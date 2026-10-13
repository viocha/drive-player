import { playbackFeature, timeFeature, videoFeatures } from "@videojs/core/dom";
import { createVideoSeekController, VIDEO_SEEK_COMPLETE_EVENT, VIDEO_SEEK_STATE_EVENT, videoSeekControllers } from "./video-seeking";

// 速览的临时暂停只控制解码器；按钮和快捷键使用用户选择的播放状态。
const previewPlaybackFeature: typeof playbackFeature = {
  ...playbackFeature,
  state(context) {
    const state = playbackFeature.state(context);
    const controller = () => {
      const media = context.target().media;
      return media instanceof HTMLVideoElement ? videoSeekControllers.get(media) : undefined;
    };
    return {
      ...state,
      play() { return controller()?.setPlaybackPaused(false) ? Promise.resolve() : state.play(); },
      pause() { if (!controller()?.setPlaybackPaused(true)) state.pause(); },
    };
  },
  attach(context) {
    const video = context.target.media;
    const update: typeof context.set = (state) => {
      const paused = video instanceof HTMLVideoElement ? videoSeekControllers.get(video)?.playbackPaused : null;
      context.set(paused == null ? state : { ...state, paused });
    };
    playbackFeature.attach?.({ ...context, set: update });
    if (!(video instanceof HTMLVideoElement)) return;
    video.addEventListener(VIDEO_SEEK_STATE_EVENT, () => {
      context.set({ paused: videoSeekControllers.get(video)?.playbackPaused ?? video.paused });
    }, { signal: context.signal });
  },
};

// 保留官方 time feature 的媒体状态同步，只将 seek 动作交给连续速览调度器。
const previewTimeFeature: typeof timeFeature = {
  ...timeFeature,
  state(context) {
    const state = timeFeature.state(context);
    return {
      ...state,
      seek(position) {
        const media = context.target().media;
        const controller = media instanceof HTMLVideoElement ? videoSeekControllers.get(media) : undefined;
        return controller ? controller.seek(position) : state.seek(position);
      },
    };
  },
  attach(context) {
    timeFeature.attach?.(context);
    const video = context.target.media;
    if (!(video instanceof HTMLVideoElement)) return;
    let wasPending = false;
    const controller = createVideoSeekController(video, {
      onChange: ({ position, pending, scrubbing }) => {
        context.set({ currentTime: position, seeking: pending });
        const container = context.target.container;
        if (scrubbing) container?.setAttribute("data-scrubbing", "");
        else container?.removeAttribute("data-scrubbing");
        if (!context.signal.aborted) video.dispatchEvent(new Event(VIDEO_SEEK_STATE_EVENT));
        const completed = wasPending && !pending;
        wasPending = pending;
        if (completed && !context.signal.aborted) video.dispatchEvent(new Event(VIDEO_SEEK_COMPLETE_EVENT));
      },
    });
    videoSeekControllers.set(video, controller);
    context.signal.addEventListener("abort", () => {
      controller.destroy();
      videoSeekControllers.delete(video);
      context.target.container?.removeAttribute("data-scrubbing");
    }, { once: true });
  },
};

export const driveVideoFeatures = videoFeatures.map((feature) => feature === timeFeature ? previewTimeFeature : feature === playbackFeature ? previewPlaybackFeature : feature);
