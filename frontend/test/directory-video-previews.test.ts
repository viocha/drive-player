import { expect, test } from "bun:test";
import { loadDirectoryVideoPreviews, type CachedVideoPreview } from "../src/lib/directory-video-previews";

const metadata = { found: true, width: 1920, height: 1080, frameRate: 24 };
const entries = Array.from({ length: 5 }, (_, index) => ({ path: `/video-${index + 1}.mp4` }));
const previews = (): CachedVideoPreview[] => entries.map((entry) => ({ path: entry.path, metadata, cover: `cache:${entry.path}` }));

test("第二个视频补图未完成时，后续已有缓存全部立即恢复", async () => {
  const cached = previews();
  cached[1].cover = "";
  const started = Promise.withResolvers<void>();
  const generation = Promise.withResolvers<string>();
  const restored: string[] = [];
  const generated: string[] = [];
  const job = loadDirectoryVideoPreviews(entries, new AbortController().signal, {
    loadCached: async () => cached,
    onCached: (items) => restored.push(...items.filter((item) => item.cover).map((item) => item.path)),
    generateMetadata: async () => { throw new Error("已缓存元信息不应重新获取"); },
    generateCover: async (entry) => {
      expect(restored).toEqual([entries[0].path, entries[2].path, entries[3].path, entries[4].path]);
      generated.push(entry.path);
      started.resolve();
      return generation.promise;
    },
    onMetadata: () => {}, onCover: () => {},
  });
  await started.promise;
  expect(restored).toHaveLength(4);
  expect(generated).toEqual([entries[1].path]);
  generation.reject(new Error("无法解码第二个视频"));
  await job;
  expect(restored).toHaveLength(4);
});

test("失败任务结束后处理后续缺失项，同时只生成一个视频", async () => {
  const cached = previews();
  cached[1].cover = "";
  cached[2].cover = "";
  const started = Promise.withResolvers<void>();
  const second = Promise.withResolvers<string>();
  const calls: string[] = [];
  const shown: string[] = [];
  const job = loadDirectoryVideoPreviews(entries, new AbortController().signal, {
    loadCached: async () => cached, onCached: () => {},
    generateMetadata: async () => metadata,
    generateCover: async (entry) => {
      calls.push(entry.path);
      if (entry.path === entries[1].path) { started.resolve(); return second.promise; }
      return "new-cover";
    },
    onMetadata: () => {}, onCover: (entry) => shown.push(entry.path),
  });
  await started.promise;
  expect(calls).toEqual([entries[1].path]);
  second.reject(new Error("截图失败"));
  await job;
  expect(calls).toEqual([entries[1].path, entries[2].path]);
  expect(shown).toEqual([entries[2].path]);
});

test("目录切换后丢弃缓存读取结果，不启动补图", async () => {
  const controller = new AbortController();
  const cache = Promise.withResolvers<CachedVideoPreview[]>();
  let displayed = false;
  let generated = false;
  const job = loadDirectoryVideoPreviews(entries, controller.signal, {
    loadCached: () => cache.promise,
    onCached: () => { displayed = true; },
    generateMetadata: async () => { generated = true; return metadata; },
    generateCover: async () => { generated = true; return "cover"; },
    onMetadata: () => {}, onCover: () => {},
  });
  controller.abort();
  cache.resolve(previews());
  await job;
  expect(displayed).toBe(false);
  expect(generated).toBe(false);
});

test("元信息卡住时按总时限处理下一项，保留已完成封面并丢弃迟到结果", async () => {
  const cached = previews().slice(0, 2);
  cached[0].metadata = { ...metadata, found: false };
  cached.forEach(item => { item.cover = ""; });
  const pending = Promise.withResolvers<typeof metadata>();
  let firstSignal!: AbortSignal;
  const shown: string[] = [], analyzed: string[] = [];
  await loadDirectoryVideoPreviews(entries.slice(0, 2), new AbortController().signal, {
    loadCached: async () => cached, onCached() {},
    generateMetadata: (entry, signal) => { firstSignal = signal; return pending.promise; },
    generateCover: async () => "cover",
    onCover: entry => { shown.push(entry.path); },
    onMetadata: entry => { analyzed.push(entry.path); },
  }, 5);
  expect(firstSignal.aborted).toBe(true);
  expect(firstSignal.reason.name).toBe("TimeoutError");
  expect(shown).toEqual(entries.slice(0, 2).map(entry => entry.path));
  pending.resolve(metadata);
  await new Promise(resolve => setImmediate(resolve));
  expect(analyzed).toEqual([]);
});

test("封面挂起时中止当前项并继续，目录取消也无需等待底层完成", async () => {
  const cached = previews().slice(0, 2).map(item => ({ ...item, cover: "" }));
  const controller = new AbortController();
  const pending = Promise.withResolvers<string>();
  let firstSignal!: AbortSignal;
  const shown: string[] = [];
  await loadDirectoryVideoPreviews(entries.slice(0, 2), controller.signal, {
    loadCached: async () => cached, onCached() {},
    generateMetadata: async () => metadata,
    generateCover: (entry, signal) => {
      if (entry.path === entries[0].path) { firstSignal = signal; return pending.promise; }
      return Promise.resolve("cover");
    },
    onMetadata() {}, onCover: entry => { shown.push(entry.path); },
  }, 5);
  expect(firstSignal.aborted).toBe(true);
  pending.resolve("迟到封面");
  await new Promise(resolve => setImmediate(resolve));
  expect(shown).toEqual([entries[1].path]);

  const entered = Promise.withResolvers<void>();
  let starts = 0;
  const job = loadDirectoryVideoPreviews(entries, controller.signal, {
    loadCached: async () => [], onCached() {},
    generateMetadata: async () => metadata,
    generateCover: () => { starts++; entered.resolve(); return new Promise(() => {}); },
    onMetadata() {}, onCover() {},
  });
  await entered.promise;
  controller.abort();
  await job;
  expect(starts).toBe(1);
});
