type SeekMedia = Pick<HTMLVideoElement, "currentTime" | "duration" | "seeking" | "readyState" | "paused" | "pause" | "play" | "addEventListener" | "removeEventListener"> & {
  fastSeek?: (position: number) => void;
  requestVideoFrameCallback?: HTMLVideoElement["requestVideoFrameCallback"];
  cancelVideoFrameCallback?: HTMLVideoElement["cancelVideoFrameCallback"];
};

export type VideoSeekState = { position: number; pending: boolean; scrubbing: boolean };
type SeekTarget = { position: number; precise: boolean };
export const VIDEO_SEEK_COMPLETE_EVENT = "drive-video-seek-complete";
export const VIDEO_SEEK_STATE_EVENT = "drive-video-seek-state";

// 一次只解码一个位置；输入只覆盖待处理目标，已完成的画面先呈现再追赶最新位置。
export function createVideoSeekController(video: SeekMedia, options: {
  onChange: (state: VideoSeekState) => void;
  requestFrame?: typeof requestAnimationFrame;
  cancelFrame?: typeof cancelAnimationFrame;
}) {
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  let pending: SeekTarget | null = null;
  let active: SeekTarget | null = null;
  let frameReady = false;
  let seekReady = false;
  let frameCallback: number | null = null;
  let paintCallback: number | null = null;
  let scrubbing = false;
  let playbackPaused: boolean | null = null;
  let disposed = false;
  let position = video.currentTime;
  const completions: Array<(position: number) => void> = [];

  const notify = () => options.onChange({ position, pending: Boolean(active || pending || video.seeking), scrubbing });
  const settle = () => {
    for (const resolve of completions.splice(0)) resolve(video.currentTime);
    if (!scrubbing && playbackPaused !== null) {
      if (!playbackPaused) void video.play().catch(() => notify());
      playbackPaused = null;
      notify();
    }
  };
  const cancelCallbacks = () => {
    if (frameCallback !== null) video.cancelVideoFrameCallback?.(frameCallback);
    if (paintCallback !== null) cancelFrame(paintCallback);
    frameCallback = null;
    paintCallback = null;
  };

  const finishFrame = () => {
    if (!active || !seekReady || !frameReady || paintCallback !== null) return;
    const target = active;
    paintCallback = requestFrame(() => {
      if (active !== target) return;
      paintCallback = null;
      active = null;
      pump();
    });
  };
  const watchFrame = () => {
    if (!video.requestVideoFrameCallback) return;
    const target = active;
    frameCallback = video.requestVideoFrameCallback((_now, frame) => {
      if (active !== target) return;
      frameCallback = null;
      if (disposed || !active) return;
      // 排除 seek 开始前已经排入合成队列的旧画面。
      if (Math.abs(frame.mediaTime - video.currentTime) > 0.25) {
        watchFrame();
        return;
      }
      frameReady = true;
      finishFrame();
    });
  };
  function pump(interrupt = false) {
    if (disposed || active || (!interrupt && video.seeking) || video.readyState === 0) return;
    const next = pending;
    pending = null;
    if (!next) {
      position = video.currentTime;
      notify();
      settle();
      return;
    }
    if (!video.seeking && Math.abs(next.position - video.currentTime) < 0.005 && video.readyState >= 2) {
      pump();
      return;
    }
    active = next;
    frameReady = !video.requestVideoFrameCallback;
    seekReady = false;
    watchFrame();
    if (!next.precise && video.fastSeek) video.fastSeek(next.position);
    else video.currentTime = next.position;
    notify();
  }
  const request = (next: number, precise: boolean, immediate = false) => {
    if (disposed || !Number.isFinite(next)) return;
    position = Math.max(0, Math.min(next, Number.isFinite(video.duration) ? video.duration : next));
    // 同一目标的 React 重渲染不重复 seek；松手仍可将粗定位提升为精确定位。
    if (!immediate && pending?.position === position && pending.precise === precise) return;
    if (!pending && active?.position === position && (active.precise || !precise)) return;
    if (immediate && active) {
      // 松手后直接提交最终位置，不再等待过时的中间画面或网络请求。
      cancelCallbacks();
      active = null;
    }
    pending = { position, precise };
    notify();
    pump(immediate);
  };
  const onSeeking = () => {
    if (!active && !pending) position = video.currentTime;
    notify();
  };
  const onSeeked = () => {
    if (video.seeking) return;
    if (!active) { pump(); return; }
    seekReady = true;
    notify();
    finishFrame();
  };
  const onMetadata = () => {
    if (!pending || paintCallback !== null) return;
    // 让 loadedmetadata 的恢复播放位置处理先结束，再执行用户排队的定位。
    paintCallback = requestFrame(() => { paintCallback = null; pump(); });
  };
  const reset = () => {
    cancelCallbacks();
    active = null;
    pending = null;
    scrubbing = false;
    playbackPaused = null;
    position = video.currentTime;
    notify();
    for (const resolve of completions.splice(0)) resolve(position);
  };
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("loadedmetadata", onMetadata);
  video.addEventListener("emptied", reset);
  video.addEventListener("error", reset);

  return {
    get position() { return active || pending || scrubbing ? position : video.currentTime; },
    get pending() { return Boolean(active || pending || video.seeking); },
    get scrubbing() { return scrubbing; },
    get playbackPaused() { return playbackPaused; },
    setPlaybackPaused(paused: boolean) {
      if (playbackPaused === null || disposed) return false;
      playbackPaused = paused;
      if (paused) video.pause();
      notify();
      return true;
    },
    beginScrub() {
      if (disposed || scrubbing) return;
      if (!active && !pending) position = video.currentTime;
      scrubbing = true;
      playbackPaused ??= video.paused;
      video.pause();
      notify();
    },
    preview(next: number) { request(next, false); },
    endScrub() {
      if (disposed || !scrubbing) return;
      scrubbing = false;
      request(position, true, true);
      notify();
    },
    seek(next: number) {
      if (disposed || !Number.isFinite(next)) return Promise.resolve(video.currentTime);
      return new Promise<number>((resolve) => {
        completions.push(resolve);
        request(next, true);
      });
    },
    destroy() {
      if (disposed) return;
      reset();
      disposed = true;
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("emptied", reset);
      video.removeEventListener("error", reset);
    },
  };
}

export type VideoSeekController = ReturnType<typeof createVideoSeekController>;
export const videoSeekControllers = new WeakMap<HTMLVideoElement, VideoSeekController>();
