import { expect, test } from "bun:test";
import { createVideoByteReader } from "../src/lib/video-byte-ranges";

test("并发读取同一块只发一个请求，缓存命中不重复下载", async () => {
  let calls = 0;
  const file = Uint8Array.from({ length: 100000 }, (_, i) => i % 251);
  const request = (async (_url, init) => {
    calls++;
    const [, start, end] = new Headers(init?.headers).get("Range")!.match(/bytes=(\d+)-(\d+)/)!;
    return new Response(file.slice(Number(start), Number(end) + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${file.length}` } });
  }) as typeof fetch;
  const read = createVideoByteReader("video", file.length, new AbortController().signal, request);
  const result = await Promise.all([read(10, 20), read(20, 30)]);
  expect(result).toEqual([file.slice(10, 20), file.slice(20, 30)]);
  expect(await read(100, 200)).toEqual(file.slice(100, 200));
  expect(calls).toBe(1);
});

test("大区间批量读取且单次不超过 256 KiB", async () => {
  const ranges: string[] = [];
  const request = (async (_url, init) => {
    const range = new Headers(init?.headers).get("Range")!;
    ranges.push(range);
    const [, start, end] = range.match(/bytes=(\d+)-(\d+)/)!;
    return new Response(new Uint8Array(Number(end) - Number(start) + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/700000` } });
  }) as typeof fetch;
  await createVideoByteReader("video", 700000, new AbortController().signal, request)(10, 650000);
  expect(ranges).toEqual(["bytes=0-262143", "bytes=262144-524287", "bytes=524288-655359"]);
});

test("代理只返回缓存前缀时续读剩余数据", async () => {
  const ranges: string[] = [];
  const request = (async (_url, init) => {
    ranges.push(new Headers(init?.headers).get("Range")!);
    const start = ranges.length === 1 ? 0 : 2;
    return new Response(new Uint8Array(start === 0 ? [0, 1] : [2, 3]), { status: 206, headers: { "Content-Range": `bytes ${start}-${start + 1}/4` } });
  }) as typeof fetch;
  const data = await createVideoByteReader("video", 4, new AbortController().signal, request)(0, 4);
  expect(data).toEqual(new Uint8Array([0, 1, 2, 3]));
  expect(ranges).toEqual(["bytes=0-3", "bytes=2-3"]);
});

test("忽略 Range 的整文件响应立即取消，不读取正文", async () => {
  let consumed = false, cancelled = false;
  const stream = new ReadableStream({ pull(controller) { consumed = true; controller.enqueue(new Uint8Array(1000)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = (async () => new Response(stream)) as typeof fetch;
  await expect(createVideoByteReader("video", 1000000, new AbortController().signal, request)(1, 10)).rejects.toThrow("Range");
  expect(consumed).toBe(false);
  expect(cancelled).toBe(true);
});

test("已取消的缓存读取也立即结束", async () => {
  const controller = new AbortController();
  let calls = 0;
  const request = (async () => { calls++; return new Response(new Uint8Array([1, 2]), { status: 206, headers: { "Content-Range": "bytes 0-1/2" } }); }) as typeof fetch;
  const read = createVideoByteReader("video", 2, controller.signal, request);
  await read(0, 2);
  controller.abort();
  await expect(read(0, 2)).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
});
