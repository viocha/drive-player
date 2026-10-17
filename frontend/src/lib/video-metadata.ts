import mediaInfoFactory, { isTrackType, type MediaInfo } from "mediainfo.js";
import mediaInfoWasmURL from "mediainfo.js/MediaInfoModule.wasm?url";
import { withAbortSignal } from "./abortable-task";

const MEDIA_INFO_CHUNK_SIZE = 256 * 1024;

export type VideoMediaMetadata = {
  width: number;
  height: number;
  frameRate: number;
};

let mediaInfoPromise: Promise<MediaInfo<"object">> | null = null;
let mediaInfoAnalysisQueue: Promise<void> = Promise.resolve();

function abortError() {
  return new DOMException("Media metadata analysis aborted", "AbortError");
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function positiveNumber(...values: Array<number | undefined>) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function getMediaInfo() {
  if (!mediaInfoPromise) {
    const initialization = mediaInfoFactory({
      format: "object",
      full: false,
      coverData: false,
      chunkSize: MEDIA_INFO_CHUNK_SIZE,
      locateFile: () => mediaInfoWasmURL,
    });
    mediaInfoPromise = initialization;
    void initialization.catch(() => {
      if (mediaInfoPromise === initialization) mediaInfoPromise = null;
    });
  }
  return mediaInfoPromise;
}

async function readRemoteChunk(
  src: string,
  fileSize: number,
  chunkSize: number,
  offset: number,
  signal: AbortSignal,
) {
  assertNotAborted(signal);
  if (chunkSize <= 0 || offset >= fileSize) return new Uint8Array();

  const end = Math.min(fileSize - 1, offset + chunkSize - 1);
  return withAbortSignal(signal, async () => {
    const response = await fetch(src, {
      headers: { Range: `bytes=${offset}-${end}` },
      cache: "no-store",
      signal,
    });
    assertNotAborted(signal);
    if (!response.ok) {
      throw new Error(`媒体元数据读取失败：HTTP ${response.status}`);
    }

    const wholeFileRequest = offset === 0 && end === fileSize - 1;
    if (response.status !== 206 && !wholeFileRequest) {
      response.body?.cancel().catch(() => undefined);
      throw new Error("媒体服务器不支持 Range 请求，已拒绝整文件下载");
    }

    const data = new Uint8Array(await response.arrayBuffer());
    assertNotAborted(signal);
    return data.length > chunkSize ? data.subarray(0, chunkSize) : data;
  });
}

async function analyzeVideoMetadataNow(src: string, fileSize: number, signal: AbortSignal): Promise<VideoMediaMetadata> {
  assertNotAborted(signal);
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error("无法读取视频大小，不能分析媒体元数据");
  }

  const mediaInfo = await withAbortSignal(signal, getMediaInfo);
  assertNotAborted(signal);
  const result = await mediaInfo.analyzeData(
    fileSize,
    (chunkSize, offset) => readRemoteChunk(src, fileSize, chunkSize, offset, signal),
  );
  assertNotAborted(signal);

  const videoTrack = result.media?.track.find((track) => isTrackType(track, "Video"));
  if (!videoTrack) throw new Error("MediaInfo 未找到视频轨道");

  const rationalFrameRate = videoTrack.FrameRate_Num && videoTrack.FrameRate_Den
    ? videoTrack.FrameRate_Num / videoTrack.FrameRate_Den
    : 0;
  const countedFrameRate = videoTrack.FrameCount && videoTrack.Duration
    ? videoTrack.FrameCount / videoTrack.Duration
    : 0;

  return {
    width: Math.round(positiveNumber(videoTrack.Width, videoTrack.Width_Original, videoTrack.Stored_Width)),
    height: Math.round(positiveNumber(videoTrack.Height, videoTrack.Height_Original, videoTrack.Stored_Height)),
    frameRate: positiveNumber(
      videoTrack.FrameRate,
      rationalFrameRate,
      videoTrack.FrameRate_Nominal,
      countedFrameRate,
    ),
  };
}

export async function analyzeVideoMetadata(src: string, fileSize: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const run = () => analyzeVideoMetadataNow(src, fileSize, signal);
  const result = mediaInfoAnalysisQueue.then(run, run);
  mediaInfoAnalysisQueue = result.then(() => undefined, () => undefined);
  return withAbortSignal(signal, () => result);
}
