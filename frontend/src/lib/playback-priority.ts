import { VIDEO_SEEK_COMPLETE_EVENT, VIDEO_SEEK_STATE_EVENT, videoSeekControllers } from "./video-seeking";

const events = ["playing", "canplay", "seeking", "seeked", "waiting", "pause", "loadedmetadata", "emptied", "error", VIDEO_SEEK_COMPLETE_EVENT, VIDEO_SEEK_STATE_EVENT];
const abortError = () => new DOMException("截图任务已取消", "AbortError");

function playbackBusy(video: HTMLVideoElement) {
  const seek = videoSeekControllers.get(video);
  return Boolean(video.seeking || seek?.pending || seek?.scrubbing
    || (!video.error && !(seek?.playbackPaused ?? video.paused) && video.readyState < 3));
}

export function waitForPlaybackAvailability(video: HTMLVideoElement, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(abortError());
  if (!playbackBusy(video)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      for (const event of events) video.removeEventListener(event, check);
      signal.removeEventListener("abort", abort);
    };
    const check = () => { if (!playbackBusy(video)) { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(abortError()); };
    for (const event of events) video.addEventListener(event, check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

// 主视频开始 seek 或缓冲时中止当前后台片段，恢复后重试这一张，已完成的截图保留。
export async function withPlaybackPriority<T>(video: HTMLVideoElement, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>) {
  for (;;) {
    await waitForPlaybackAvailability(video, signal);
    const phase = new AbortController();
    const abort = () => phase.abort();
    const interrupt = () => { if (playbackBusy(video)) phase.abort(); };
    signal.addEventListener("abort", abort, { once: true });
    for (const event of events) video.addEventListener(event, interrupt);
    try {
      if (signal.aborted) throw abortError();
      interrupt();
      if (phase.signal.aborted) continue;
      const result = await operation(phase.signal);
      if (!phase.signal.aborted) return result;
    } catch (error) {
      if (signal.aborted || !phase.signal.aborted) throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      for (const event of events) video.removeEventListener(event, interrupt);
    }
  }
}
