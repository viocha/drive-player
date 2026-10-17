import { encodeCanvasPNG } from "./canvas-png";
import { waitForPlaybackAvailability, withPlaybackPriority } from "./playback-priority";
const THUMBNAIL_MAX_WIDTH = 320;
function captureNativeThumbnail(src: string, offsetPercent: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<{ dataUrl: string; width: number; height: number }>((resolve, reject) => {
    const video = document.createElement("video");
    let settled = false;
    let timeout = 0;

    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      video.removeAttribute("src");
      video.load();
    };

    const finish = (error?: unknown, result?: { dataUrl: string; width: number; height: number }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("缩略图生成结果为空"));
    };

    const onAbort = () => finish(new DOMException("封面生成已取消", "AbortError"));

    const capture = () => {
      if (signal.aborted || settled) return;
      if (!video.videoWidth || !video.videoHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        finish(new Error("视频没有可用画面"));
        return;
      }
      const width = Math.min(THUMBNAIL_MAX_WIDTH, video.videoWidth);
      const height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * width));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        finish(new Error("无法创建缩略图画布"));
        return;
      }
      context.drawImage(video, 0, 0, width, height);
      finish(undefined, {
        dataUrl: canvas.toDataURL("image/webp", 0.72),
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };

    video.crossOrigin = "anonymous";
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("error", () => finish(new Error("视频缩略图加载失败")), { once: true });
    video.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const normalizedPercent = Math.max(0, Math.min(100, offsetPercent));
      const target = duration > 0 ? (duration * normalizedPercent) / 100 : 0;
      const captureWhenDataIsReady = () => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) capture();
        else video.addEventListener("loadeddata", capture, { once: true });
      };
      if (target === 0) {
        captureWhenDataIsReady();
        return;
      }
      video.addEventListener("seeked", captureWhenDataIsReady, { once: true });
      video.currentTime = target;
    }, { once: true });

    signal.addEventListener("abort", onAbort, { once: true });
    timeout = window.setTimeout(() => finish(new Error("视频缩略图加载超时")), 30_000);
    video.src = src;
    video.load();
  });
}


function videoSnapshotAbortError() {
  return new DOMException("视频截图已取消", "AbortError");
}

class VideoSnapshotDecodeError extends Error {}

function videoSnapshotSourceError(video: HTMLVideoElement, message: string) {
  return video.error?.code === 3 ? new VideoSnapshotDecodeError(message) : new Error(message);
}

function waitForVideoSnapshotMetadata(video: HTMLVideoElement, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(videoSnapshotAbortError());
      return;
    }
    let timeout = 0;
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onError);
    };
    const finish = (error?: unknown) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(videoSnapshotAbortError());
    const onLoadedMetadata = () => finish();
    const onError = () => finish(videoSnapshotSourceError(video, "视频截图源加载失败"));
    signal.addEventListener("abort", onAbort, { once: true });
    video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    video.addEventListener("error", onError, { once: true });
    timeout = window.setTimeout(() => finish(new Error("视频截图源加载超时")), 30_000);
  });
}

function seekVideoForSnapshot(video: HTMLVideoElement, position: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(videoSnapshotAbortError());
      return;
    }
    let timeout = 0;
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const finish = (error?: unknown) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(videoSnapshotAbortError());
    const onSeeked = () => finish();
    const onError = () => finish(videoSnapshotSourceError(video, "视频截图定位失败"));
    signal.addEventListener("abort", onAbort, { once: true });
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    timeout = window.setTimeout(() => finish(new Error("视频截图定位超时")), 30_000);
    video.currentTime = position;
  });
}

async function extractSnapshotsWorker(
  src: string,
  positions: number[],
  signal: AbortSignal,
  foregroundVideo: HTMLVideoElement,
  onSnapshot: (snapshot: { position: number; dataUrl: string }) => Promise<void>,
) {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;

  const dispose = () => {
    video.removeAttribute("src");
    video.load();
  };
  const onAbort = () => dispose();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (positions.length === 0) return;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建视频截图画布");

    for (const position of positions) {
      if (signal.aborted) throw videoSnapshotAbortError();
      const dataUrl = await withPlaybackPriority(foregroundVideo, signal, async (phase) => {
        phase.addEventListener("abort", dispose, { once: true });
        try {
          if (!video.getAttribute("src")) {
            const metadata = waitForVideoSnapshotMetadata(video, phase);
            video.src = src;
            video.load();
            await metadata;
          }
          if (!video.videoWidth || !video.videoHeight) throw new Error("视频没有可截图的原始画面");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          await seekVideoForSnapshot(video, position, phase);
          if (phase.aborted) throw videoSnapshotAbortError();
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          return await encodeCanvasPNG(canvas, phase);
        } finally {
          phase.removeEventListener("abort", dispose);
        }
      });
      await waitForPlaybackAvailability(foregroundVideo, signal);
      await onSnapshot({ position, dataUrl });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    dispose();
  }
}


async function extractNativeSnapshots(src: string, positions: number[], signal: AbortSignal, foregroundVideo: HTMLVideoElement, onSnapshot: (snapshot: { position: number; dataUrl: string }) => Promise<void>) {
  signal.throwIfAborted();
  if (!positions.length) return;
  const cancel = new AbortController();
  const operation = AbortSignal.any([signal, cancel.signal]);
  const middle = Math.ceil(positions.length / 2);
  const groups = [positions.slice(0, middle), positions.slice(middle)].filter(group => group.length);
  const completed = new Set<number>();
  const save = async (snapshot: { position: number; dataUrl: string }) => {
    operation.throwIfAborted();
    await onSnapshot(snapshot);
    completed.add(snapshot.position);
  };
  const workers = groups.map(group => extractSnapshotsWorker(src, group, operation, foregroundVideo, save));
  try { await Promise.all(workers); }
  catch (error) {
    cancel.abort();
    await Promise.allSettled(workers);
    signal.throwIfAborted();
    if (groups.length > 1 && error instanceof VideoSnapshotDecodeError) {
      // 部分设备的硬件解码器数量有限；串行补齐未完成截图，保留已保存结果。
      await extractSnapshotsWorker(src, positions.filter(position => !completed.has(position)), signal, foregroundVideo, onSnapshot);
      return;
    }
    throw error;
  }
}

type SnapshotImage = { requestedPosition: number; position: number; dataUrl: string };
type KeyframeSource = Awaited<ReturnType<typeof import("./video-keyframes").createKeyframeSource>>;

function canReadKeyframes(src: string, fileSize: number) {
  return typeof VideoDecoder !== "undefined" && Number.isSafeInteger(fileSize) && fileSize > 0
    && /\.(mp4|m4v|mov)$/i.test(new URL(src, window.location.href).pathname);
}

function frameTimeout(signal: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("视频截图超时", "TimeoutError")), 30_000);
  return { signal: AbortSignal.any([signal, controller.signal]), clear: () => clearTimeout(timer) };
}

export async function captureVideoThumbnail(src: string, offsetPercent: number, signal: AbortSignal, fileSize = 0) {
  signal.throwIfAborted();
  if (!canReadKeyframes(src, fileSize)) return captureNativeThumbnail(src, offsetPercent, signal);
  const timeout = frameTimeout(signal);
  let source: KeyframeSource | undefined;
  try {
    const { createKeyframeSource } = await import("./video-keyframes");
    source = await createKeyframeSource(src, fileSize, timeout.signal);
    const duration = await source.getDuration();
    if (!duration || !Number.isFinite(duration)) throw new Error("容器缺少视频时长");
    const frame = await source.read(duration * Math.max(0, Math.min(100, offsetPercent)) / 100);
    const canvas = await frame.draw(THUMBNAIL_MAX_WIDTH);
    timeout.signal.throwIfAborted();
    return { dataUrl: canvas.toDataURL("image/webp", 0.72), width: canvas.width, height: canvas.height };
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.signal.aborted) throw timeout.signal.reason;
    source?.dispose();
    return captureNativeThumbnail(src, offsetPercent, signal);
  } finally { timeout.clear(); source?.dispose(); }
}

export async function extractVideoSnapshots(src: string, positions: number[], signal: AbortSignal, foregroundVideo: HTMLVideoElement, onSnapshot: (snapshot: SnapshotImage) => Promise<void>, fileSize = 0) {
  signal.throwIfAborted();
  const completed = new Set<number>();
  const save = async (snapshot: SnapshotImage) => { await onSnapshot(snapshot); completed.add(snapshot.requestedPosition); };
  const native = () => extractNativeSnapshots(src, positions.filter(position => !completed.has(position)), signal, foregroundVideo, snapshot => save({ ...snapshot, requestedPosition: snapshot.position }));
  if (!positions.length || !canReadKeyframes(src, fileSize)) return native();
  let source: KeyframeSource | undefined;
  let saveError = false;
  const encoded = new Map<number, string>();
  const dispose = () => { source?.dispose(); source = undefined; };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    const { createKeyframeSource } = await import("./video-keyframes");
    for (let index = 0; index < positions.length; index += 2) {
      const batch = positions.slice(index, index + 2);
      const images = await withPlaybackPriority(foregroundVideo, signal, async phase => {
        const timeout = frameTimeout(phase);
        timeout.signal.addEventListener("abort", dispose, { once: true });
        try {
          const activeSource = source ??= await createKeyframeSource(src, fileSize, timeout.signal);
          const frames = await Promise.all(batch.map(position => activeSource.read(position)));
          const images: SnapshotImage[] = [];
          for (let offset = 0; offset < frames.length; offset++) {
            const frame = frames[offset];
            let dataUrl = encoded.get(frame.position);
            if (!dataUrl) {
              dataUrl = await encodeCanvasPNG(await frame.draw(), timeout.signal);
              encoded.set(frame.position, dataUrl);
            }
            images.push({ requestedPosition: batch[offset], position: frame.position, dataUrl });
          }
          return images;
        } catch (error) { timeout.signal.throwIfAborted(); throw error; }
        finally { timeout.clear(); timeout.signal.removeEventListener("abort", dispose); }
      });
      for (const image of images) {
        await waitForPlaybackAvailability(foregroundVideo, signal);
        try { await save(image); } catch (error) { saveError = true; throw error; }
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (saveError || error instanceof DOMException && error.name === "TimeoutError") throw error;
    dispose();
    await native();
  } finally { signal.removeEventListener("abort", dispose); dispose(); }
}
