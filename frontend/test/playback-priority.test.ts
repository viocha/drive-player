import { expect, test } from "bun:test";
import { waitForPlaybackAvailability, withPlaybackPriority } from "../src/lib/playback-priority";
import { VIDEO_SEEK_STATE_EVENT, videoSeekControllers } from "../src/lib/video-seeking";

const fixture = () => Object.assign(new EventTarget(), { seeking: false, paused: false, readyState: 4, error: null }) as unknown as HTMLVideoElement;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

test("主视频缓冲完成后才开始截图", async () => {
  const video = fixture();
  Object.assign(video, { readyState: 2 });
  let started = false;
  const result = withPlaybackPriority(video, new AbortController().signal, async () => { started = true; return "PNG"; });
  await Promise.resolve();
  expect(started).toBe(false);
  Object.assign(video, { readyState: 3 });
  video.dispatchEvent(new Event("canplay"));
  expect(await result).toBe("PNG");
});

test("主视频 seek 中断当前截图，恢复后重试并保留结果", async () => {
  const video = fixture();
  const entered = deferred();
  const interrupted = deferred();
  let attempts = 0;
  const result = withPlaybackPriority(video, new AbortController().signal, async (signal) => {
    attempts++;
    if (attempts > 1) return "PNG";
    entered.resolve();
    return await new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => {
      interrupted.resolve();
      reject(new DOMException("中断", "AbortError"));
    }, { once: true }));
  });
  await entered.promise;
  Object.assign(video, { seeking: true });
  video.dispatchEvent(new Event("seeking"));
  await interrupted.promise;
  await Promise.resolve();
  expect(attempts).toBe(1);
  Object.assign(video, { seeking: false });
  video.dispatchEvent(new Event("seeked"));
  expect(await result).toBe("PNG");
  expect(attempts).toBe(2);
});

test("滑动预览的物理暂停不会让后台截图抢占资源", async () => {
  const video = fixture();
  Object.assign(video, { paused: true });
  const state = { pending: false, scrubbing: true, playbackPaused: false };
  videoSeekControllers.set(video, state as unknown as NonNullable<ReturnType<typeof videoSeekControllers.get>>);
  let available = false;
  const wait = waitForPlaybackAvailability(video, new AbortController().signal).then(() => { available = true; });
  await Promise.resolve();
  expect(available).toBe(false);
  state.scrubbing = false;
  video.dispatchEvent(new Event(VIDEO_SEEK_STATE_EVENT));
  await wait;
  expect(available).toBe(true);
  videoSeekControllers.delete(video);
});

test("取消等待不启动截图，真实错误不会无限重试", async () => {
  const video = fixture();
  Object.assign(video, { seeking: true });
  const controller = new AbortController();
  let attempts = 0;
  const waiting = withPlaybackPriority(video, controller.signal, async () => { attempts++; });
  controller.abort();
  await expect(waiting).rejects.toHaveProperty("name", "AbortError");
  expect(attempts).toBe(0);
  Object.assign(video, { seeking: false });
  await expect(withPlaybackPriority(video, new AbortController().signal, async () => { attempts++; throw new Error("解码失败"); })).rejects.toThrow("解码失败");
  expect(attempts).toBe(1);
});
