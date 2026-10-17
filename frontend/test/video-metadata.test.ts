import { afterEach, expect, mock, test } from "bun:test";

let failInitialization = true, active = 0, maximumActive = 0;
const metadata = { media: { track: [{ "@type": "Video", Width: 1920, Height: 1080, FrameRate: 24 }] } };
const parser = {
  async analyzeData(_size: number, read: (length: number, offset: number) => Promise<Uint8Array>) {
    active++; maximumActive = Math.max(maximumActive, active);
    try { await read(8, 0); return metadata; }
    finally { active--; }
  },
};
mock.module("mediainfo.js", () => ({
  default: async () => {
    if (failInitialization) { failInitialization = false; throw new Error("WASM 加载失败"); }
    return parser;
  },
  isTrackType: (track: { "@type": string }, type: string) => track["@type"] === type,
}));
mock.module("mediainfo.js/MediaInfoModule.wasm?url", () => ({ default: "mediainfo.wasm" }));
const { analyzeVideoMetadata } = await import("../src/lib/video-metadata");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const response = () => new Response(new Uint8Array(8), { status: 206 });
const expected = { width: 1920, height: 1080, frameRate: 24 };

test("WASM 初始化失败后可重试", async () => {
  globalThis.fetch = (async () => response()) as typeof fetch;
  await expect(analyzeVideoMetadata("first", 100, new AbortController().signal)).rejects.toThrow("WASM 加载失败");
  expect(await analyzeVideoMetadata("retry", 100, new AbortController().signal)).toEqual(expected);
});

test("取消卡住的读取释放解析队列，跳过已取消的排队项并忽略迟到响应", async () => {
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<Response>();
  const urls: string[] = [];
  globalThis.fetch = (async src => {
    urls.push(String(src));
    if (src === "stuck") { entered.resolve(); return late.promise; }
    return response();
  }) as typeof fetch;
  const first = new AbortController();
  const job = analyzeVideoMetadata("stuck", 100, first.signal);
  await entered.promise;
  const skipped = new AbortController();
  const waiting = analyzeVideoMetadata("skip", 100, skipped.signal);
  skipped.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  const next = analyzeVideoMetadata("next", 100, new AbortController().signal);
  first.abort();
  await expect(job).rejects.toMatchObject({ name: "AbortError" });
  expect(await next).toEqual(expected);
  expect(urls).toEqual(["stuck", "next"]);
  late.resolve(response());
  await new Promise(resolve => setImmediate(resolve));
  expect(active).toBe(0);
  expect(maximumActive).toBe(1);
});

test("响应正文读取卡住时取消也能释放解析队列", async () => {
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<ArrayBuffer>();
  globalThis.fetch = (async src => src === "body" ? {
    ok: true, status: 206,
    arrayBuffer() { entered.resolve(); return late.promise; },
  } : response()) as typeof fetch;
  const controller = new AbortController();
  const job = analyzeVideoMetadata("body", 100, controller.signal);
  await entered.promise;
  const next = analyzeVideoMetadata("next", 100, new AbortController().signal);
  controller.abort();
  await expect(job).rejects.toMatchObject({ name: "AbortError" });
  expect(await next).toEqual(expected);
  late.resolve(new ArrayBuffer(8));
  await new Promise(resolve => setImmediate(resolve));
  expect(active).toBe(0);
  expect(maximumActive).toBe(1);
});

test("已取消的解析不进入队列，也不产生未处理的迟到错误", async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return response(); }) as typeof fetch;
  const controller = new AbortController();
  controller.abort();
  await expect(analyzeVideoMetadata("cancelled", 100, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  await new Promise(resolve => setImmediate(resolve));
  expect(requests).toBe(0);
  expect(await analyzeVideoMetadata("next", 100, new AbortController().signal)).toEqual(expected);
});
