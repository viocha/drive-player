import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { withTimeout } from "../src/lib/abortable-task";

mock.module("../src/lib/canvas-png", () => ({
  encodeCanvasPNG: async (canvas: { position: number; width: number; height: number }, signal: AbortSignal) => {
    signal.throwIfAborted();
    expect([canvas.width, canvas.height]).toEqual([640, 360]);
    return `png:${canvas.position}`;
  },
}));
let keySourceFactory: (...args: any[]) => any;
mock.module("../src/lib/video-keyframes", () => ({ createKeyframeSource: (...args: any[]) => keySourceFactory(...args) }));
const { captureVideoThumbnail, extractVideoSnapshots } = await import("../src/lib/video-snapshots");

let active = 0;
let maximumActive = 0;
let failParallelDecode = false;
let holdMetadata = false;
let videos: FakeVideo[] = [];

class FakeVideo extends EventTarget {
  src = "";
  preload = "";
  duration = 120;
  videoWidth = 640;
  videoHeight = 360;
  readyState = 2;
  error: { code: number } | null = null;
  private position = 0;
  private loaded = false;
  private generation = 0;
  get currentTime() { return this.position; }
  set currentTime(value: number) {
    this.position = value;
    const generation = this.generation;
    queueMicrotask(() => { if (generation === this.generation) this.dispatchEvent(new Event("seeked")); });
  }
  load() {
    const generation = ++this.generation;
    if (!this.src) return;
    if (!this.loaded) { this.loaded = true; active++; maximumActive = Math.max(maximumActive, active); }
    const fail = failParallelDecode && active > 1;
    if (fail) failParallelDecode = false;
    if (holdMetadata) return;
    queueMicrotask(() => {
      if (generation !== this.generation) return;
      if (fail) { this.error = { code: 3 }; this.dispatchEvent(new Event("error")); }
      else this.dispatchEvent(new Event("loadedmetadata"));
    });
  }
  getAttribute() { return this.src || null; }
  removeAttribute() {
    this.src = "";
    if (this.loaded) { this.loaded = false; active--; }
  }
}

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalMediaElement = globalThis.HTMLMediaElement;
const originalDecoder = globalThis.VideoDecoder;
beforeEach(() => {
  active = 0; maximumActive = 0; failParallelDecode = false; holdMetadata = false; videos = [];
  keySourceFactory = () => { throw new Error("关键帧源不可用"); };
  globalThis.VideoDecoder = undefined as unknown as typeof VideoDecoder;
  globalThis.window = { setTimeout, clearTimeout, location: { href: "http://localhost/" } } as unknown as Window & typeof globalThis;
  globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 } as typeof HTMLMediaElement;
  globalThis.document = {
    createElement(tag: string) {
      if (tag === "video") { const video = new FakeVideo(); videos.push(video); return video; }
      const canvas = { width: 0, height: 0, position: 0,
        getContext: () => ({ drawImage: (video: FakeVideo) => { canvas.position = video.currentTime; } }),
        toDataURL: () => `webp:${canvas.position}`,
      };
      return canvas;
    },
  } as unknown as Document;
});
afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.HTMLMediaElement = originalMediaElement;
  globalThis.VideoDecoder = originalDecoder;
});

const foreground = () => Object.assign(new EventTarget(), { paused: true, readyState: 4, seeking: false }) as unknown as HTMLVideoElement;

test("截图最多两路并发，保留每个时间点和原始分辨率，并释放视频源", async () => {
  const saved: number[] = [];
  const positions = Array.from({ length: 10 }, (_, i) => i + 1);
  await extractVideoSnapshots("video", positions, new AbortController().signal, foreground(), async snapshot => {
    expect(snapshot.dataUrl).toBe(`png:${snapshot.position}`);
    saved.push(snapshot.position);
  });
  expect(saved.sort((a, b) => a - b)).toEqual(positions);
  expect(maximumActive).toBe(2);
  expect(active).toBe(0);
});

test("并行解码失败后串行补齐，已保存截图不重复", async () => {
  failParallelDecode = true;
  const saved: number[] = [];
  await extractVideoSnapshots("video", [1, 2, 3, 4], new AbortController().signal, foreground(), async snapshot => {
    saved.push(snapshot.position);
  });
  expect(saved.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  expect(videos).toHaveLength(3);
  expect(active).toBe(0);
});

test("取消任务时结束两路等待，不保存截图", async () => {
  holdMetadata = true;
  const controller = new AbortController();
  let saved = 0;
  const job = extractVideoSnapshots("video", [1, 2], controller.signal, foreground(), async () => { saved++; });
  controller.abort();
  await expect(job).rejects.toMatchObject({ name: "AbortError" });
  expect(saved).toBe(0);
  expect(active).toBe(0);
});

test("保存失败时终止任务，不触发解码回退", async () => {
  await expect(extractVideoSnapshots("video", [1, 2], new AbortController().signal, foreground(), async () => {
    throw new Error("保存失败");
  })).rejects.toThrow("保存失败");
  expect(videos).toHaveLength(2);
  expect(active).toBe(0);
});

test("封面仅预加载元数据，按指定比例截取且在结束时释放源", async () => {
  expect((await captureVideoThumbnail("video", 10, new AbortController().signal)).dataUrl).toBe("webp:12");
  expect(videos[0].preload).toBe("metadata");
  expect(active).toBe(0);
});

test("封面回退隐藏播放器后仍受同一总时限约束，并释放视频源", async () => {
  globalThis.VideoDecoder = class {} as typeof VideoDecoder;
  holdMetadata = true;
  keySourceFactory = () => { throw new Error("此编码不支持直接解码"); };
  await expect(withTimeout(new AbortController().signal, 5, signal =>
    captureVideoThumbnail("http://localhost/video.mp4", 50, signal, 1000),
  )).rejects.toMatchObject({ name: "TimeoutError" });
  expect(videos).toHaveLength(1);
  expect(active).toBe(0);
});

test("附近关键帧保留目标与实际时间，同一帧只编码一次", async () => {
  globalThis.VideoDecoder = class {} as typeof VideoDecoder;
  let draws = 0, disposed = 0;
  keySourceFactory = () => ({
    dispose() { disposed++; },
    read: async () => ({ position: 8, draw: async () => { draws++; return { width: 640, height: 360, position: 8 }; } }),
  });
  const saved: { requestedPosition: number; position: number; dataUrl: string }[] = [];
  await extractVideoSnapshots("http://localhost/video.mp4", [9, 10], new AbortController().signal, foreground(), async image => { saved.push(image); }, 1000);
  expect(saved).toEqual([{ requestedPosition: 9, position: 8, dataUrl: "png:8" }, { requestedPosition: 10, position: 8, dataUrl: "png:8" }]);
  expect(draws).toBe(1);
  expect(disposed).toBeGreaterThan(0);
  expect(videos).toHaveLength(0);
});

test("关键帧中途失败只回退未保存目标，避免重复提取", async () => {
  globalThis.VideoDecoder = class {} as typeof VideoDecoder;
  keySourceFactory = () => ({
    dispose() {},
    read: async (position: number) => {
      if (position >= 30) throw new Error("解码失败");
      return { position: position - 2, draw: async () => ({ width: 640, height: 360, position: position - 2 }) };
    },
  });
  const saved: { requestedPosition: number; position: number }[] = [];
  await extractVideoSnapshots("http://localhost/video.mp4", [10, 20, 30, 40], new AbortController().signal, foreground(), async image => { saved.push(image); }, 1000);
  expect(saved.map(image => image.requestedPosition).sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
  expect(saved.find(image => image.requestedPosition === 10)?.position).toBe(8);
  expect(videos).toHaveLength(2);
});

test("关键帧保存失败直接报错，不重新下载原生视频", async () => {
  globalThis.VideoDecoder = class {} as typeof VideoDecoder;
  keySourceFactory = () => ({ dispose() {}, read: async () => ({ position: 8, draw: async () => ({ width: 640, height: 360, position: 8 }) }) });
  await expect(extractVideoSnapshots("http://localhost/video.mp4", [10], new AbortController().signal, foreground(), async () => { throw new Error("磁盘错误"); }, 1000)).rejects.toThrow("磁盘错误");
  expect(videos).toHaveLength(0);
});

test("取消关键帧读取时释放源，不保存或回退下载", async () => {
  globalThis.VideoDecoder = class {} as typeof VideoDecoder;
  const controller = new AbortController();
  let disposed = 0, saved = 0;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  keySourceFactory = (_src: string, _size: number, signal: AbortSignal) => ({
    dispose() { disposed++; },
    read: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started();
    }),
  });
  const job = extractVideoSnapshots("http://localhost/video.mp4", [10], controller.signal, foreground(), async () => { saved++; }, 1000);
  await reading;
  controller.abort();
  await expect(job).rejects.toMatchObject({ name: "AbortError" });
  expect(disposed).toBeGreaterThan(0);
  expect(saved).toBe(0);
  expect(videos).toHaveLength(0);
});

test("主视频定位中断关键帧读取，恢复后重建源并补齐目标", async () => {
  globalThis.VideoDecoder = class {} as typeof VideoDecoder;
  const video = foreground();
  let sources = 0, disposed = 0;
  const saved: number[] = [];
  keySourceFactory = (_src: string, _size: number, signal: AbortSignal) => {
    const generation = ++sources;
    return {
      dispose() { disposed++; },
      read: async (position: number) => {
        if (generation === 1) {
          Object.assign(video, { seeking: true });
          video.dispatchEvent(new Event("seeking"));
          queueMicrotask(() => {
            Object.assign(video, { seeking: false });
            video.dispatchEvent(new Event("seeked"));
          });
          signal.throwIfAborted();
        }
        return { position: position - 2, draw: async () => ({ width: 640, height: 360, position: position - 2 }) };
      },
    };
  };
  await extractVideoSnapshots("http://localhost/video.mp4", [10, 20], new AbortController().signal, video, async image => { saved.push(image.requestedPosition); }, 1000);
  expect(saved).toEqual([10, 20]);
  expect(sources).toBe(2);
  expect(disposed).toBeGreaterThanOrEqual(2);
  expect(videos).toHaveLength(0);
});

test("MKV 按耗时优先直接使用原生路径", async () => {
  globalThis.VideoDecoder = class {} as typeof VideoDecoder;
  keySourceFactory = () => { throw new Error("不应加载 MKV 关键帧解析"); };
  await extractVideoSnapshots("http://localhost/video.mkv", [10], new AbortController().signal, foreground(), async () => {}, 1000);
  expect(videos).toHaveLength(1);
});
