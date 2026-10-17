import type { VideoMediaMetadata } from "./video-metadata";
import { withAbortSignal, withTimeout } from "./abortable-task";

const DIRECTORY_PREVIEW_TIMEOUT_MS = 10_000;

export type CachedVideoPreview = {
  path: string;
  metadata: VideoMediaMetadata & { found: boolean };
  cover: string;
};

// 先恢复整个目录的缓存，再串行补齐缺失视频；网络等待不能阻挡缓存展示。
export async function loadDirectoryVideoPreviews<T extends { path: string }>(entries: T[], signal: AbortSignal, handlers: {
  loadCached: (entries: T[], signal: AbortSignal) => Promise<CachedVideoPreview[]>;
  onCached: (previews: CachedVideoPreview[]) => void;
  generateMetadata: (entry: T, signal: AbortSignal) => Promise<VideoMediaMetadata>;
  generateCover: (entry: T, signal: AbortSignal) => Promise<string>;
  onMetadata: (entry: T, metadata: VideoMediaMetadata) => void;
  onCover: (entry: T, cover: string) => void;
}, timeoutMS = DIRECTORY_PREVIEW_TIMEOUT_MS) {
  if (entries.length === 0 || signal.aborted) return;
  let cached: CachedVideoPreview[];
  try { cached = await withAbortSignal(signal, () => handlers.loadCached(entries, signal)); }
  catch (error) { if (signal.aborted) return; throw error; }
  if (signal.aborted) return;
  handlers.onCached(cached);
  const byPath = new Map(cached.map((preview) => [preview.path, preview]));
  for (const entry of entries) {
    if (signal.aborted) return;
    const preview = byPath.get(entry.path);
    if (preview?.metadata.found && preview.cover) continue;
    try {
      await withTimeout(signal, timeoutMS, async taskSignal => {
        await Promise.allSettled([
          !preview?.metadata.found ? Promise.resolve().then(() => handlers.generateMetadata(entry, taskSignal)).then((metadata) => {
            if (!taskSignal.aborted) handlers.onMetadata(entry, metadata);
          }) : Promise.resolve(),
          !preview?.cover ? Promise.resolve().then(() => handlers.generateCover(entry, taskSignal)).then((cover) => {
            if (!taskSignal.aborted) handlers.onCover(entry, cover);
          }) : Promise.resolve(),
        ]);
      });
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof DOMException && error.name === "TimeoutError")) throw error;
    }
  }
}
