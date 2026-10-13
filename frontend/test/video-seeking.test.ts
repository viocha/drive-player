import { expect, test } from "bun:test";
import { createVideoSeekController, type VideoSeekState } from "../src/lib/video-seeking";

function fixture({ frameCallback = true, fastSeek = false } = {}) {
  const paints = new Map<number, FrameRequestCallback>();
  const frames = new Map<number, VideoFrameRequestCallback>();
  const writes: Array<{ position: number; precise: boolean }> = [];
  const states: VideoSeekState[] = [];
  let id = 0;
  let position = 0;
  const video = Object.assign(new EventTarget(), {
    duration: 120, seeking: false, readyState: 4, paused: false,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    ...(frameCallback ? {
      requestVideoFrameCallback(callback: VideoFrameRequestCallback) { frames.set(++id, callback); return id; },
      cancelVideoFrameCallback(key: number) { frames.delete(key); },
    } : {}),
    ...(fastSeek ? { fastSeek(next: number) { position = Math.floor(next / 10) * 10; writes.push({ position, precise: false }); this.seeking = true; this.dispatchEvent(new Event("seeking")); } } : {}),
  });
  Object.defineProperty(video, "currentTime", {
    get: () => position,
    set: (next: number) => { position = next; writes.push({ position, precise: true }); video.seeking = true; video.dispatchEvent(new Event("seeking")); },
  });
  const media = video as typeof video & { currentTime: number };
  const controller = createVideoSeekController(media, {
    onChange: (state) => states.push(state),
    requestFrame: (callback) => { paints.set(++id, callback); return id; },
    cancelFrame: (key) => { paints.delete(key); },
  });
  const present = (time = position) => {
    for (const [key, callback] of Array.from(frames)) {
      frames.delete(key);
      callback(0, { mediaTime: time } as VideoFrameCallbackMetadata);
    }
  };
  const seeked = () => { video.seeking = false; video.dispatchEvent(new Event("seeked")); };
  const paint = () => { for (const [key, callback] of Array.from(paints)) { paints.delete(key); callback(0); } };
  const finish = () => { seeked(); present(); paint(); };
  return { controller, video: media, writes, states, frames, paints, present, seeked, paint, finish };
}

test("高频目标合并，呈现中间帧后只追赶最新目标", async () => {
  const f = fixture();
  const first = f.controller.seek(10);
  f.controller.seek(20);
  const last = f.controller.seek(30);
  expect(f.writes.map((item) => item.position)).toEqual([10]);
  expect(f.controller.position).toBe(30);
  f.seeked();
  f.paint();
  expect(f.writes).toHaveLength(1);
  expect(f.states.at(-1)?.position).toBe(30);
  f.present();
  expect(f.writes).toHaveLength(1);
  f.paint();
  expect(f.writes.map((item) => item.position)).toEqual([10, 30]);
  f.finish();
  expect(await first).toBe(30);
  expect(await last).toBe(30);
  expect(f.controller.pending).toBe(false);
  f.controller.destroy();
});

test("画面先于 seeked 到达时也等待两个信号", () => {
  const f = fixture();
  f.controller.seek(10);
  f.controller.seek(25);
  f.present();
  f.paint();
  expect(f.writes).toHaveLength(1);
  f.seeked();
  f.paint();
  expect(f.writes.map((item) => item.position)).toEqual([10, 25]);
  f.controller.destroy();
});

test("旧画面的回调不会提前放行下一个位置", () => {
  const f = fixture();
  f.controller.seek(10);
  f.controller.seek(30);
  f.present(0);
  f.seeked();
  f.paint();
  expect(f.writes).toHaveLength(1);
  f.present(10);
  f.paint();
  expect(f.writes.map((item) => item.position)).toEqual([10, 30]);
  f.controller.destroy();
});

test("元数据加载后先完成初始位置恢复，再执行用户的最新定位", () => {
  const f = fixture();
  f.video.readyState = 0;
  f.controller.seek(20);
  f.controller.seek(40);
  expect(f.writes).toHaveLength(0);
  f.video.readyState = 4;
  f.video.dispatchEvent(new Event("loadedmetadata"));
  expect(f.writes).toHaveLength(0);
  f.paint();
  expect(f.writes.map((item) => item.position)).toEqual([40]);
  f.controller.destroy();
});

test("滑动期间可粗定位，松手精确定位并恢复播放", () => {
  const f = fixture({ fastSeek: true });
  f.controller.beginScrub();
  f.controller.preview(23.5);
  f.controller.preview(46.5);
  expect(f.video.paused).toBe(true);
  f.controller.endScrub();
  expect(f.writes).toEqual([{ position: 20, precise: false }]);
  f.finish();
  expect(f.writes.at(-1)).toEqual({ position: 46.5, precise: true });
  expect(f.video.paused).toBe(true);
  f.finish();
  expect(f.video.currentTime).toBe(46.5);
  expect(f.video.paused).toBe(false);
  f.controller.destroy();
});

test("连续手势保留最新目标和播放状态，暂停视频不会被自动播放", () => {
  const f = fixture();
  f.controller.beginScrub();
  f.controller.preview(10);
  f.controller.endScrub();
  f.controller.beginScrub();
  f.controller.preview(40);
  f.finish();
  expect(f.controller.position).toBe(40);
  f.controller.endScrub();
  f.finish();
  expect(f.video.paused).toBe(false);
  f.video.pause();
  f.controller.beginScrub();
  f.controller.preview(55);
  f.controller.endScrub();
  f.finish();
  expect(f.video.paused).toBe(true);
  f.controller.destroy();
});

test("临时暂停保留用户播放状态，等待定位时的主动暂停和播放可改变最终状态", () => {
  const f = fixture();
  f.controller.beginScrub();
  f.controller.preview(20);
  expect(f.video.paused).toBe(true);
  expect(f.controller.playbackPaused).toBe(false);
  f.controller.endScrub();
  expect(f.controller.playbackPaused).toBe(false);
  expect(f.controller.setPlaybackPaused(true)).toBe(true);
  f.finish();
  expect(f.video.paused).toBe(true);
  expect(f.controller.playbackPaused).toBeNull();
  f.controller.beginScrub();
  f.controller.preview(40);
  expect(f.controller.playbackPaused).toBe(true);
  expect(f.controller.setPlaybackPaused(false)).toBe(true);
  f.controller.endScrub();
  f.finish();
  expect(f.video.paused).toBe(false);
  expect(f.controller.setPlaybackPaused(true)).toBe(false);
  f.controller.destroy();
});

test("没有视频帧 API 时使用 seeked 与绘制周期，来源切换清理待处理目标", async () => {
  const f = fixture({ frameCallback: false });
  const pending = f.controller.seek(10);
  f.controller.seek(20);
  f.seeked();
  expect(f.writes).toHaveLength(1);
  f.paint();
  expect(f.writes.map((item) => item.position)).toEqual([10, 20]);
  f.video.dispatchEvent(new Event("emptied"));
  await pending;
  expect(f.paints.size).toBe(0);
  f.controller.destroy();
  f.video.dispatchEvent(new Event("seeked"));
  expect(f.writes).toHaveLength(2);
});
