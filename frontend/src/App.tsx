import { FormEvent, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "@videojs/react/video/skin.css";
import { createPlayer, videoFeatures } from "@videojs/react";
import { Video } from "@videojs/react/video";
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Folder,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  LogOut,
  Play,
  RefreshCw,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Events, System } from "@wailsio/runtime";
import { AppService } from "../bindings/drive-player";
import type {
  AppState,
  FileEntry,
  PlaybackProgressStats,
  QuarkIDCacheStats,
  VideoMetadataCacheStats,
  VideoSnapshot,
  VideoSnapshotCacheStats,
} from "../bindings/drive-player";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Toaster, toast } from "@/components/ui/toast";
import { DriveVideoSkin } from "@/components/drive-video-skin";
import { analyzeVideoMetadata, type VideoMediaMetadata } from "@/lib/video-metadata";

const Player = createPlayer({ features: videoFeatures });
const GESTURE_ACTIVATION_DISTANCE = 8;
const GESTURE_SEEK_DISTANCE_PX = 1;

function removeGestureActivationDistance(delta: number) {
  return Math.sign(delta) * Math.max(0, Math.abs(delta) - GESTURE_ACTIVATION_DISTANCE);
}

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "mov",
  "webm",
  "ogv",
  "ogg",
  "mkv",
  "avi",
  "wmv",
  "flv",
  "ts",
  "m2ts",
]);

const THUMBNAIL_MAX_WIDTH = 320;
const VIDEO_METADATA_CONCURRENCY = 2;
const DIRECTORY_CACHE_SETTINGS_KEY = "drive-player.directory-cache-settings";
const DEFAULT_DIRECTORY_CACHE_TTL_MINUTES = 30;
const LEGACY_DEFAULT_DIRECTORY_CACHE_TTL_MINUTES = 5;
const DEFAULT_DIRECTORY_CACHE_MAX_SIZE_MB = 32;
const DIRECTORY_SCROLL_POSITION_CACHE_LIMIT = 1000;
const DIRECTORY_HISTORY_LIMIT = 1000;
const MIN_DIRECTORY_CACHE_TTL_MINUTES = 1;
const MAX_DIRECTORY_CACHE_TTL_MINUTES = 1440;
const MIN_DIRECTORY_CACHE_MAX_SIZE_MB = 1;
const MAX_DIRECTORY_CACHE_MAX_SIZE_MB = 1024;

type ActiveVideo = {
  name: string;
  path: string;
  modifiedAt: string;
  url: string;
  resumePosition: number;
};

type DirectoryCacheSettings = {
  ttlMinutes: number;
  maxSizeMB: number;
};

type DirectoryCacheStats = {
  count: number;
  totalEntries: number;
  totalBytes: number;
};

type ProviderBrowseStats = {
  directoryCache: DirectoryCacheStats;
  scrollPositions: number;
  backHistory: number;
  forwardHistory: number;
};

type DirectoryCacheItem = {
  entries: FileEntry[];
  cachedAt: number;
  lastAccess: number;
  sizeBytes: number;
};

type CloudProvider = "123" | "quark";

type ProviderBrowseSession = {
  currentPath: string;
  entries: FileEntry[];
  thumbnailImages: Record<string, string>;
  videoMetadataByPath: Record<string, VideoMediaMetadata>;
  directoryCache: Map<string, DirectoryCacheItem>;
  scrollPositions: Map<string, number>;
  backHistory: string[];
  forwardHistory: string[];
};

function createProviderBrowseSession(): ProviderBrowseSession {
  return {
    currentPath: "/",
    entries: [],
    thumbnailImages: {},
    videoMetadataByPath: {},
    directoryCache: new Map(),
    scrollPositions: new Map(),
    backHistory: [],
    forwardHistory: [],
  };
}

function normalizeProvider(value: string): CloudProvider {
  return value === "quark" ? "quark" : "123";
}

function loadDirectoryCacheSettings(): DirectoryCacheSettings {
  try {
    const raw = window.localStorage.getItem(DIRECTORY_CACHE_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DirectoryCacheSettings>;
      const ttlMinutes = Number(parsed.ttlMinutes);
      const maxSizeMB = Number(parsed.maxSizeMB);
      if (
        Number.isInteger(ttlMinutes) &&
        ttlMinutes >= MIN_DIRECTORY_CACHE_TTL_MINUTES &&
        ttlMinutes <= MAX_DIRECTORY_CACHE_TTL_MINUTES &&
        Number.isInteger(maxSizeMB) &&
        maxSizeMB >= MIN_DIRECTORY_CACHE_MAX_SIZE_MB &&
        maxSizeMB <= MAX_DIRECTORY_CACHE_MAX_SIZE_MB
      ) {
        if (
          ttlMinutes === LEGACY_DEFAULT_DIRECTORY_CACHE_TTL_MINUTES &&
          maxSizeMB === DEFAULT_DIRECTORY_CACHE_MAX_SIZE_MB
        ) {
          const migrated = {
            ttlMinutes: DEFAULT_DIRECTORY_CACHE_TTL_MINUTES,
            maxSizeMB: DEFAULT_DIRECTORY_CACHE_MAX_SIZE_MB,
          };
          window.localStorage.setItem(DIRECTORY_CACHE_SETTINGS_KEY, JSON.stringify(migrated));
          return migrated;
        }
        return { ttlMinutes, maxSizeMB };
      }
    }
  } catch {
    // Fall back to defaults when local storage is unavailable or malformed.
  }
  return {
    ttlMinutes: DEFAULT_DIRECTORY_CACHE_TTL_MINUTES,
    maxSizeMB: DEFAULT_DIRECTORY_CACHE_MAX_SIZE_MB,
  };
}

function estimateDirectoryCacheSize(remotePath: string, entries: FileEntry[]) {
  let bytes = remotePath.length * 2 + 96;
  for (const entry of entries) {
    bytes += 96;
    bytes += (entry.name.length + entry.path.length + entry.modifiedAt.length + entry.contentType.length) * 2;
  }
  return bytes;
}

function directoryCacheStatsFor(cache: Map<string, DirectoryCacheItem>): DirectoryCacheStats {
  let totalEntries = 0;
  let totalBytes = 0;
  for (const item of cache.values()) {
    totalEntries += item.entries.length;
    totalBytes += item.sizeBytes;
  }
  return { count: cache.size, totalEntries, totalBytes };
}

function pruneDirectoryCache(
  cache: Map<string, DirectoryCacheItem>,
  settings: DirectoryCacheSettings,
  now = Date.now(),
) {
  const ttlMs = settings.ttlMinutes * 60 * 1000;
  for (const [remotePath, item] of cache) {
    if (now - item.cachedAt >= ttlMs) cache.delete(remotePath);
  }

  const maxBytes = settings.maxSizeMB * 1024 * 1024;
  let stats = directoryCacheStatsFor(cache);
  while (stats.totalBytes > maxBytes && cache.size > 0) {
    let oldestPath: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [remotePath, item] of cache) {
      if (item.lastAccess < oldestAccess) {
        oldestPath = remotePath;
        oldestAccess = item.lastAccess;
      }
    }
    if (oldestPath === null) break;
    cache.delete(oldestPath);
    stats = directoryCacheStatsFor(cache);
  }
  return stats;
}

function formatPlayerTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatHUDClock(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type PlayerSidebarTab = "snapshots" | "videos";

function VideoSnapshotPane({
  twoColumns = false,
  snapshots,
  loading,
  extracting,
  completedCount,
  plannedCount,
  onExtract,
  onStop,
  onJump,
}: {
  twoColumns?: boolean;
  snapshots: VideoSnapshot[];
  loading: boolean;
  extracting: boolean;
  completedCount: number;
  plannedCount: number;
  onExtract: (refreshAll: boolean) => void;
  onStop: () => void;
  onJump: (position: number) => void;
}) {
  const canExtract = !loading && plannedCount > 0;
  const extractionComplete = plannedCount > 0 && completedCount >= plannedCount;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b p-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">时间点截图</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {loading
              ? "正在读取缓存"
              : extracting
              ? `正在提取 ${completedCount}/${plannedCount}`
              : snapshots.length > 0
                ? `已缓存 ${snapshots.length} 张`
                : "按视频时长等分提取原画"}
          </div>
        </div>
        {(extracting || canExtract) && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={extracting ? onStop : () => onExtract(extractionComplete)}
          >
            {extracting ? <Square /> : <Play />}
            {extracting ? "中断提取" : extractionComplete ? "重新获取" : snapshots.length > 0 ? "补全截图" : "提取截图"}
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {snapshots.length === 0 ? (
          <div className="flex min-h-28 items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {loading
              ? "正在读取缓存…"
              : extracting
                ? "截图会在提取完成一张后立即显示"
                : plannedCount > 0
                  ? "点击“提取截图”开始"
                  : "正在读取视频时长…"}
          </div>
        ) : (
          <div className={`grid gap-2 p-2 ${twoColumns ? "grid-cols-2" : "grid-cols-1"}`}>
            {snapshots.map((snapshot) => (
              <Button
                key={snapshot.position}
                type="button"
                variant="ghost"
                className="relative h-auto w-full overflow-hidden rounded-md p-0"
                title={`跳转到 ${formatPlayerTime(snapshot.position)}`}
                onClick={() => onJump(snapshot.position)}
              >
                <img
                  src={snapshot.url}
                  alt={`${formatPlayerTime(snapshot.position)} 截图`}
                  loading="lazy"
                  decoding="async"
                  className="aspect-video w-full object-cover"
                />
                <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 py-0.5 font-mono text-[10px] leading-none text-white">
                  {formatPlayerTime(snapshot.position)}
                </span>
              </Button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function VideoListPane({
  videos,
  currentPath,
  switchingPath,
  onSelectVideo,
  active,
}: {
  videos: FileEntry[];
  currentPath: string;
  switchingPath: string | null;
  onSelectVideo: (entry: FileEntry) => void;
  active: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const initiallyCenteredRef = useRef(false);

  useLayoutEffect(() => {
    if (!active || initiallyCenteredRef.current) return;
    const viewport = viewportRef.current;
    if (!viewport || viewport.clientHeight <= 0) return;
    const currentItem = viewport.querySelector<HTMLElement>('[data-current-video="true"]');
    if (!currentItem) return;

    const viewportRect = viewport.getBoundingClientRect();
    const itemRect = currentItem.getBoundingClientRect();
    const target = viewport.scrollTop
      + itemRect.top
      - viewportRect.top
      - (viewport.clientHeight - itemRect.height) / 2;
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = Math.max(0, Math.min(maxScrollTop, target));
    initiallyCenteredRef.current = true;
  }, [active, currentPath, videos]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b p-3">
        <div className="text-sm font-medium">同目录视频</div>
        <div className="mt-0.5 text-xs text-muted-foreground">共 {videos.length} 个视频</div>
      </div>
      <ScrollArea viewportRef={viewportRef} className="min-h-0 flex-1">
        <div className="grid gap-1 p-2">
          {videos.map((video) => {
            const current = video.path === currentPath;
            const switching = video.path === switchingPath;
            const modifiedAt = formatDate(video.modifiedAt);
            return (
              <Button
                key={video.path}
                type="button"
                variant={current ? "secondary" : "ghost"}
                className="h-auto min-w-0 w-full justify-start gap-2 overflow-hidden px-2 py-2 text-left"
                aria-current={current ? "true" : undefined}
                data-current-video={current ? "true" : undefined}
                disabled={switchingPath !== null}
                title={video.name}
                onClick={() => {
                  if (!current) onSelectVideo(video);
                }}
              >
                {switching ? <LoaderCircle className="animate-spin" /> : current ? <Play /> : null}
                <span className="w-0 min-w-0 flex-1 overflow-hidden">
                  <span className="block w-full truncate text-sm font-medium">{video.name}</span>
                  <span className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="shrink-0">{formatSize(video.size)}</span>
                    <span className="min-w-0 truncate text-right" title={modifiedAt}>{modifiedAt}</span>
                  </span>
                </span>
              </Button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function VideoPlayerSidebar({
  className,
  twoColumns = false,
  visible = true,
  tab,
  onTabChange,
  onClose,
  videos,
  currentPath,
  switchingPath,
  onSelectVideo,
  ...snapshotProps
}: {
  className: string;
  twoColumns?: boolean;
  visible?: boolean;
  tab: PlayerSidebarTab;
  onTabChange: (tab: PlayerSidebarTab) => void;
  onClose?: () => void;
  videos: FileEntry[];
  currentPath: string;
  switchingPath: string | null;
  onSelectVideo: (entry: FileEntry) => void;
} & Omit<Parameters<typeof VideoSnapshotPane>[0], "twoColumns">) {
  return (
    <aside
      className={className}
      aria-label="播放器侧栏"
      aria-hidden={!visible}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as PlayerSidebarTab)}
        className="min-h-0 flex-1 gap-0 overflow-hidden"
      >
        <div className="flex shrink-0 items-center gap-2 border-b p-2">
          <TabsList className="grid min-w-0 flex-1 grid-cols-2">
            <TabsTrigger value="snapshots">时间点截图</TabsTrigger>
            <TabsTrigger value="videos">视频列表</TabsTrigger>
          </TabsList>
          {onClose && (
            <Button type="button" size="icon-sm" variant="ghost" aria-label="关闭播放器侧栏" onClick={onClose}>
              <X />
            </Button>
          )}
        </div>
        <TabsContent value="snapshots" keepMounted className="flex min-h-0 overflow-hidden">
          <VideoSnapshotPane twoColumns={twoColumns} {...snapshotProps} />
        </TabsContent>
        <TabsContent value="videos" keepMounted className="flex min-h-0 overflow-hidden">
          <VideoListPane
            videos={videos}
            currentPath={currentPath}
            switchingPath={switchingPath}
            onSelectVideo={onSelectVideo}
            active={visible && tab === "videos"}
          />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function VideoPlayer({
  src,
  remotePath,
  modifiedAt,
  initialPosition,
  onPersistProgress,
  isAndroid,
  isMobile,
  mobileLongPressRate,
  fullscreenHUDEnabled,
  fullscreenHUDSideOffsetPX,
  directoryVideos,
  onSelectVideo,
}: {
  src: string;
  remotePath: string;
  modifiedAt: string;
  initialPosition: number;
  onPersistProgress: (remotePath: string, position: number, duration: number) => void;
  isAndroid: boolean;
  isMobile: boolean;
  mobileLongPressRate: number;
  fullscreenHUDEnabled: boolean;
  fullscreenHUDSideOffsetPX: number;
  directoryVideos: FileEntry[];
  onSelectVideo: (entry: FileEntry) => Promise<void>;
}) {
  type GestureMode = "pending" | "seek" | "brightness";
  type AndroidPlayerBridge = {
    playerEnsureBrightnessAccess?: () => boolean;
    playerGetBrightness?: () => string;
    playerSetBrightness?: (percent: number) => void;
    playerGetSystemBarInsets?: () => string;
    playerGetPower?: () => string;
    playerSetFullscreen?: (fullscreen: boolean, portrait: boolean) => void;
  };

  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const remotePathRef = useRef(remotePath);
  remotePathRef.current = remotePath;
  const miniProgressRef = useRef<HTMLDivElement | null>(null);
  const gestureFeedbackRef = useRef<HTMLDivElement | null>(null);
  const gestureFeedbackHideTimerRef = useRef<number | null>(null);
  const lastPersistedAt = useRef(0);
  const endedRef = useRef(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const nativeFullscreenRef = useRef(false);
  const [webFullscreen, setWebFullscreen] = useState(false);
  const [fullscreenSidePanelOpen, setFullscreenSidePanelOpen] = useState(false);
  const [sidePanelTab, setSidePanelTab] = useState<PlayerSidebarTab>("snapshots");
  const [switchingVideoPath, setSwitchingVideoPath] = useState<string | null>(null);
  const [hudClock, setHUDClock] = useState(() => Date.now());
  const [hudBatteryPercent, setHUDBatteryPercent] = useState<number | null>(null);
  const [hudProgress, setHUDProgress] = useState({ position: initialPosition, duration: 0 });
  const [videoSnapshots, setVideoSnapshots] = useState<VideoSnapshot[]>([]);
  const [videoSnapshotsLoading, setVideoSnapshotsLoading] = useState(true);
  const [videoSnapshotExtracting, setVideoSnapshotExtracting] = useState(false);
  const [videoSnapshotPlannedCount, setVideoSnapshotPlannedCount] = useState(0);
  const [videoSnapshotCompletedCount, setVideoSnapshotCompletedCount] = useState(0);
  const videoSnapshotAbortRef = useRef<AbortController | null>(null);
  const hudSliderDraggingRef = useRef(false);
  const hudGestureDraggingRef = useRef(false);
  const hudSeekPendingRef = useRef(false);
  const fullscreenActive = nativeFullscreen || webFullscreen;
  const fullscreenHUDVisible = fullscreenHUDEnabled && fullscreenActive;
  const gesture = useRef<{
    pointerId: number;
    mode: GestureMode;
    startX: number;
    startY: number;
    startBrightness: number;
    targetTime: number;
    lastSeekX: number;
    side: boolean;
    rect: DOMRect;
    viewportWidth: number;
  } | null>(null);

  const androidBridge = useCallback(() => {
    if (!isAndroid) return null;
    return (window as Window & { wails?: AndroidPlayerBridge }).wails ?? null;
  }, [isAndroid]);

  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // `autoPlay` alone lets the browser defer the actual play request until it
    // decides the media is ready enough. Issue the play request as soon as the
    // element is mounted so Video.js enters its playing state immediately while
    // buffering/decoding can continue in the background.
    void video.play().catch(() => {
      // Keep the native autoplay attribute as the fallback if the runtime
      // temporarily rejects an explicit request (for example autoplay policy).
    });
  }, [src]);

  useEffect(() => {
    endedRef.current = false;
    lastPersistedAt.current = 0;
    hudSliderDraggingRef.current = false;
    hudGestureDraggingRef.current = false;
    hudSeekPendingRef.current = false;
    setHUDProgress({ position: initialPosition, duration: 0 });
  }, [initialPosition, src]);

  useEffect(() => {
    videoSnapshotAbortRef.current?.abort();
    videoSnapshotAbortRef.current = null;
    setVideoSnapshotExtracting(false);
    setVideoSnapshotPlannedCount(0);
    setVideoSnapshotCompletedCount(0);

    setVideoSnapshotsLoading(true);
    setVideoSnapshots([]);
    let disposed = false;
    const request = AppService.GetVideoSnapshots(remotePath, modifiedAt);
    void request
      .then((snapshots) => {
        if (!disposed) setVideoSnapshots(snapshots ?? []);
      })
      .catch((err) => {
        if (!disposed) toast.add({ title: "读取视频截图失败", description: errorMessage(err), type: "error" });
      })
      .finally(() => {
        if (!disposed) setVideoSnapshotsLoading(false);
      });

    return () => {
      disposed = true;
      request.cancel("video player closed");
      videoSnapshotAbortRef.current?.abort();
      videoSnapshotAbortRef.current = null;
    };
  }, [modifiedAt, remotePath]);

  useEffect(() => {
    const plannedTimes = plannedVideoSnapshotTimes(hudProgress.duration);
    setVideoSnapshotPlannedCount(plannedTimes.length);
    if (videoSnapshotExtracting) return;
    setVideoSnapshotCompletedCount(
      plannedTimes.filter((position) => hasVideoSnapshotAt(videoSnapshots, position)).length,
    );
  }, [hudProgress.duration, videoSnapshotExtracting, videoSnapshots]);

  const startVideoSnapshotExtraction = useCallback(async (refreshAll = false) => {
    if (videoSnapshotsLoading || videoSnapshotExtracting) return;
    const sourceVideo = videoRef.current;
    const duration = sourceVideo?.duration ?? 0;
    if (!Number.isFinite(duration) || duration <= 0) {
      toast.add({ title: "暂时无法提取截图", description: "视频时长尚未加载完成", type: "error" });
      return;
    }

    const plannedTimes = plannedVideoSnapshotTimes(duration);
    const missingTimes = refreshAll
      ? plannedTimes
      : plannedTimes.filter((position) => !hasVideoSnapshotAt(videoSnapshots, position));
    const completedCount = refreshAll ? 0 : plannedTimes.length - missingTimes.length;
    setVideoSnapshotPlannedCount(plannedTimes.length);
    setVideoSnapshotCompletedCount(completedCount);

    if (missingTimes.length === 0) return;

    videoSnapshotAbortRef.current?.abort();
    const controller = new AbortController();
    videoSnapshotAbortRef.current = controller;
    setVideoSnapshotExtracting(true);

    try {
      await extractVideoSnapshots(
        src,
        missingTimes,
        controller.signal,
        async (snapshot) => {
          const saveRequest = AppService.SaveVideoSnapshot(remotePath, modifiedAt, snapshot.position, snapshot.dataUrl);
          const cancelSave = () => saveRequest.cancel("video snapshot extraction aborted");
          controller.signal.addEventListener("abort", cancelSave, { once: true });
          try {
            await saveRequest;
          } finally {
            controller.signal.removeEventListener("abort", cancelSave);
          }
          if (controller.signal.aborted) return;
          setVideoSnapshots((current) => (
            [
              ...current.filter((item) => Math.abs(item.position - snapshot.position) > 0.001),
              { position: snapshot.position, url: snapshot.dataUrl },
            ]
              .sort((a, b) => a.position - b.position)
          ));
          setVideoSnapshotCompletedCount((current) => Math.min(plannedTimes.length, current + 1));
        },
      );
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError") && !controller.signal.aborted) {
        toast.add({ title: "提取视频截图失败", description: errorMessage(err), type: "error" });
      }
    } finally {
      if (videoSnapshotAbortRef.current === controller) {
        videoSnapshotAbortRef.current = null;
        setVideoSnapshotExtracting(false);
      }
    }
  }, [modifiedAt, remotePath, src, videoSnapshotExtracting, videoSnapshots, videoSnapshotsLoading]);

  const stopVideoSnapshotExtraction = useCallback(() => {
    videoSnapshotAbortRef.current?.abort();
  }, []);

  const jumpToVideoSnapshot = useCallback((position: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(position)) return;
    video.currentTime = Math.max(0, Math.min(position, Number.isFinite(video.duration) ? video.duration : position));
  }, []);

  const setAndroidFullscreen = useCallback((fullscreen: boolean) => {
    if (!isAndroid) return;
    const video = videoRef.current;
    const portrait = Boolean(
      fullscreen
      && video
      && video.videoHeight > 0
      && video.videoHeight > video.videoWidth,
    );
    nativeFullscreenRef.current = fullscreen;
    androidBridge()?.playerSetFullscreen?.(fullscreen, portrait);
    setNativeFullscreen(fullscreen);
  }, [androidBridge, isAndroid]);

  const toggleAndroidFullscreen = useCallback(() => {
    setAndroidFullscreen(!nativeFullscreen);
  }, [nativeFullscreen, setAndroidFullscreen]);

  useEffect(() => {
    if (!isAndroid) return;
    const backWindow = window as Window & { __drivePlayerExitFullscreen?: () => boolean };
    backWindow.__drivePlayerExitFullscreen = () => {
      if (!nativeFullscreen) return false;
      setAndroidFullscreen(false);
      return true;
    };
    return () => {
      delete backWindow.__drivePlayerExitFullscreen;
    };
  }, [isAndroid, nativeFullscreen, setAndroidFullscreen]);

  // Native fullscreen is tied to the lifetime of the player itself. Keeping
  // this teardown separate prevents gesture-effect dependency changes from
  // accidentally issuing an "exit fullscreen" call while still mounted.
  useEffect(() => {
    if (!isAndroid) return;
    return () => {
      nativeFullscreenRef.current = false;
      androidBridge()?.playerSetFullscreen?.(false, false);
    };
  }, [androidBridge, isAndroid]);

  useEffect(() => {
    const syncWebFullscreen = () => {
      if (isAndroid) {
        setWebFullscreen(false);
        return;
      }
      const frame = frameRef.current;
      const fullscreenElement = document.fullscreenElement;
      setWebFullscreen(Boolean(
        frame
        && fullscreenElement
        && (
          frame === fullscreenElement
          || frame.contains(fullscreenElement)
          || fullscreenElement.contains(frame)
        ),
      ));
    };

    syncWebFullscreen();
    document.addEventListener("fullscreenchange", syncWebFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncWebFullscreen);
  }, [isAndroid]);

  useEffect(() => {
    if (!fullscreenActive) {
      setFullscreenSidePanelOpen(false);
    }
  }, [fullscreenActive]);

  useEffect(() => {
    if (!fullscreenHUDVisible) return;

    let cancelled = false;
    let androidBatteryCleanup: (() => void) | null = null;
    let desktopBatteryCleanup: (() => void) | null = null;

    const setBatteryPercent = (percent: number) => {
      setHUDBatteryPercent(
        Number.isFinite(percent) && percent >= 0
          ? Math.max(0, Math.min(100, Math.round(percent)))
          : null,
      );
    };

    const setBatteryLevel = (level: number) => setBatteryPercent(level * 100);

    const syncAndroidPower = () => {
      try {
        const level = JSON.parse(androidBridge()?.playerGetPower?.() ?? "{}")?.level;
        setBatteryLevel(typeof level === "number" ? level : -1);
      } catch {
        setHUDBatteryPercent(null);
      }
    };

    const subscribeAndroidPower = () => {
      androidBatteryCleanup = Events.On("player:BatteryChanged", (event) => {
        try {
          const rawPayload = event.data as unknown;
          const payload = typeof rawPayload === "string"
            ? JSON.parse(rawPayload)
            : rawPayload as { level?: unknown } | null;
          const level = payload && typeof payload.level === "number" ? payload.level : -1;
          setBatteryLevel(level);
        } catch {
          setHUDBatteryPercent(null);
        }
      });
      // ACTION_BATTERY_CHANGED is sticky, so one synchronous read gives the
      // current value immediately; all later updates arrive through the event.
      syncAndroidPower();
    };

    const syncDesktopPower = async () => {
      try {
        const percent = await AppService.GetBatteryPercent();
        if (cancelled) return;
        setBatteryPercent(percent);
      } catch {
        if (!cancelled) setHUDBatteryPercent(null);
      }
    };

    const video = videoRef.current;
    if (video) {
      setHUDProgress({ position: video.currentTime, duration: video.duration });
    }
    setHUDClock(Date.now());
    if (isAndroid) {
      subscribeAndroidPower();
    } else {
      void syncDesktopPower();
      desktopBatteryCleanup = Events.On("player:BatteryChanged", () => {
        void syncDesktopPower();
      });
    }

    let clockTimeout = 0;
    const scheduleClockUpdate = () => {
      clockTimeout = window.setTimeout(() => {
        setHUDClock(Date.now());
        scheduleClockUpdate();
      }, 60_000 - (Date.now() % 60_000) + 50);
    };
    scheduleClockUpdate();

    return () => {
      cancelled = true;
      androidBatteryCleanup?.();
      desktopBatteryCleanup?.();
      window.clearTimeout(clockTimeout);
    };
  }, [androidBridge, fullscreenHUDVisible, isAndroid]);

  const clearGestureFeedbackHideTimer = useCallback(() => {
    if (gestureFeedbackHideTimerRef.current === null) return;
    window.clearTimeout(gestureFeedbackHideTimerRef.current);
    gestureFeedbackHideTimerRef.current = null;
  }, []);

  const showGestureFeedback = useCallback((message: string) => {
    clearGestureFeedbackHideTimer();
    const feedback = gestureFeedbackRef.current;
    if (!feedback) return;
    feedback.textContent = message;
    feedback.hidden = false;
  }, [clearGestureFeedbackHideTimer]);

  const hideGestureFeedback = useCallback(() => {
    clearGestureFeedbackHideTimer();
    const feedback = gestureFeedbackRef.current;
    if (feedback) feedback.hidden = true;
  }, [clearGestureFeedbackHideTimer]);

  const scheduleGestureFeedbackHide = useCallback((delayMs = 550) => {
    clearGestureFeedbackHideTimer();
    gestureFeedbackHideTimerRef.current = window.setTimeout(() => {
      gestureFeedbackHideTimerRef.current = null;
      const feedback = gestureFeedbackRef.current;
      if (feedback) feedback.hidden = true;
    }, delayMs);
  }, [clearGestureFeedbackHideTimer]);

  const persistProgress = useCallback((video: HTMLVideoElement) => {
    const position = video.currentTime;
    const duration = video.duration;
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
    lastPersistedAt.current = Date.now();
    onPersistProgress(remotePathRef.current, position, duration);
  }, [onPersistProgress]);

  const selectDirectoryVideo = useCallback(async (entry: FileEntry) => {
    if (entry.path === remotePath || switchingVideoPath !== null) return;
    const currentVideo = videoRef.current;
    if (currentVideo) persistProgress(currentVideo);
    setSwitchingVideoPath(entry.path);
    try {
      await onSelectVideo(entry);
      setSidePanelTab("videos");
    } catch (err) {
      toast.add({ title: "切换视频失败", description: errorMessage(err), type: "error" });
    } finally {
      setSwitchingVideoPath(null);
    }
  }, [onSelectVideo, persistProgress, remotePath, switchingVideoPath]);

  const syncHUDWithTimeSlider = useCallback((progress: { position: number; duration: number; dragging: boolean }) => {
    if (!fullscreenHUDVisible) return;
    if (progress.dragging) {
      hudSliderDraggingRef.current = true;
      hudSeekPendingRef.current = true;
      setHUDProgress({ position: progress.position, duration: progress.duration });
      return;
    }
    if (hudSliderDraggingRef.current) {
      hudSliderDraggingRef.current = false;
      // Keep the final slider target visible until the media confirms the seek.
      // Otherwise an old timeupdate can make the HUD jump backwards while data loads.
      hudSeekPendingRef.current = true;
    }
  }, [fullscreenHUDVisible]);

  useEffect(() => {
    const miniProgress = miniProgressRef.current;
    const playerRoot = miniProgress?.closest(".media-default-skin");
    const timeSlider = playerRoot?.querySelector<HTMLElement>(".media-time-controls .media-slider");
    if (!miniProgress || !timeSlider) return;

    const syncProgressUI = () => {
      const fill = timeSlider.style.getPropertyValue("--media-slider-fill").trim();
      miniProgress.style.setProperty("--video-mini-progress", fill || "0%");
    };

    syncProgressUI();
    const observer = new MutationObserver(syncProgressUI);
    observer.observe(timeSlider, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (endedRef.current) return;
    const video = videoRef.current;
    if (video) persistProgress(video);
  }, [persistProgress]);

  useEffect(() => {
    const frame = frameRef.current;
    const root = frame?.querySelector<HTMLElement>(".media-player-pane");
    if (!frame || !root) return;

    const systemPointerIds = new Set<number>();
    const systemTouchIds = new Set<number>();
    let suppressSystemGestureClickUntil = 0;
    let suppressLongPressClickUntil = 0;
    let suppressPlayerGestureClickUntil = 0;
    let longPressTimer: number | null = null;
    let longPress: {
      pointerId: number;
      startX: number;
      startY: number;
      previousRate: number;
      active: boolean;
    } | null = null;
    const isControlsTarget = (target: EventTarget | null) => {
      return target instanceof Element && Boolean(target.closest(
        ".media-controls--root, .video-player-sidebar--fullscreen, button, [role='slider'], input, select, textarea, a",
      ));
    };

    const isFullscreenSidePanelTarget = (target: EventTarget | null) => {
      return target instanceof Element && Boolean(target.closest(".video-player-sidebar--fullscreen"));
    };

    const getSystemGestureGuards = () => {
      let top = 0;
      let bottom = 0;
      if (!nativeFullscreenRef.current) return { top, bottom };
      try {
        const insets = JSON.parse(androidBridge()?.playerGetSystemBarInsets?.() ?? "{}");
        const density = Math.max(1, window.devicePixelRatio);
        const topInsetPx = insets?.top;
        const bottomInsetPx = insets?.bottom;
        top = typeof topInsetPx === "number" && Number.isFinite(topInsetPx)
          ? Math.max(24, topInsetPx / density + 12)
          : 36;
        bottom = typeof bottomInsetPx === "number" && Number.isFinite(bottomInsetPx)
          ? Math.max(24, bottomInsetPx / density + 12)
          : 36;
      } catch {
        top = 36;
        bottom = 36;
      }
      return { top, bottom };
    };

    const isSystemGestureStart = (clientY: number) => {
      if (!nativeFullscreenRef.current) return false;
      const rect = root.getBoundingClientRect();
      const relativeY = clientY - rect.top;
      const guards = getSystemGestureGuards();
      return relativeY <= guards.top || relativeY >= rect.height - guards.bottom;
    };

    const clearLongPressTimer = () => {
      if (longPressTimer === null) return;
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    };

    const resetLongPress = (restoreRate: boolean) => {
      clearLongPressTimer();
      const current = longPress;
      longPress = null;
      if (!restoreRate || !current?.active) return;
      const video = videoRef.current;
      if (video) video.playbackRate = current.previousRate;
    };

    const formatLongPressRate = (rate: number) => {
      return `${rate.toFixed(2).replace(/\.?0+$/, "")}×`;
    };

    const startLongPress = (event: PointerEvent, video: HTMLVideoElement) => {
      if (!isMobile || event.pointerType === "mouse" || !event.isPrimary || video.paused) return;
      resetLongPress(true);
      longPress = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        previousRate: video.playbackRate,
        active: false,
      };
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        const current = longPress;
        const currentVideo = videoRef.current;
        if (!current || current.pointerId !== event.pointerId || !currentVideo) return;
        current.previousRate = currentVideo.playbackRate;
        current.active = true;
        if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
        currentVideo.playbackRate = mobileLongPressRate;
        showGestureFeedback(formatLongPressRate(mobileLongPressRate));
      }, 500);
    };

    const onPointerDown = (event: PointerEvent) => {
      const video = videoRef.current;
      if (!video) return;
      if (isFullscreenSidePanelTarget(event.target)) {
        resetLongPress(true);
        gesture.current = null;
        hideGestureFeedback();
        return;
      }
      const rect = root.getBoundingClientRect();
      const relativeX = event.clientX - rect.left;
      const relativeY = event.clientY - rect.top;
      const guards = getSystemGestureGuards();
      const startsInSystemGestureZone = isAndroid && nativeFullscreenRef.current
        && (relativeY <= guards.top || relativeY >= rect.height - guards.bottom);
      if (startsInSystemGestureZone) {
        resetLongPress(true);
        systemPointerIds.add(event.pointerId);
        gesture.current = null;
        hideGestureFeedback();
        // Keep Android's edge gestures available but keep the media player's
        // Gesture/controls from seeing any part of this pointer sequence.
        // Deliberately do not preventDefault(): the OS still owns the gesture.
        event.stopImmediatePropagation();
        return;
      }
      if (isControlsTarget(event.target)) return;
      startLongPress(event, video);
      if (!isAndroid) return;
      if (event.pointerType === "mouse" || !event.isPrimary) return;
      // A new gesture owns the feedback lifetime. Cancel the previous release
      // timer immediately so rapid swipe/release/swipe sequences cannot have an
      // old timeout hide the new brightness indicator.
      clearGestureFeedbackHideTimer();
      const side = relativeX <= rect.width * 0.2 || relativeX >= rect.width * 0.8;
      let startBrightness = 0.5;
      if (side) {
        try {
          const value = JSON.parse(androidBridge()?.playerGetBrightness?.() ?? "{}")?.value;
          if (typeof value === "number" && Number.isFinite(value)) startBrightness = value;
        } catch {
          // Keep the neutral fallback if the native reading is unavailable.
        }
      }
      gesture.current = {
        pointerId: event.pointerId,
        mode: "pending",
        startX: event.clientX,
        startY: event.clientY,
        startBrightness,
        targetTime: video.currentTime,
        lastSeekX: event.clientX,
        side,
        rect,
        viewportWidth: Math.max(1, window.visualViewport?.width ?? window.innerWidth ?? rect.width),
      };
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        // Some WebView builds may reject capture for a pointer that has already ended.
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (systemPointerIds.has(event.pointerId)) {
        event.stopImmediatePropagation();
        return;
      }
      const currentLongPress = longPress;
      if (currentLongPress?.pointerId === event.pointerId) {
        const dx = event.clientX - currentLongPress.startX;
        const dy = event.clientY - currentLongPress.startY;
        if (currentLongPress.active) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (Math.hypot(dx, dy) >= GESTURE_ACTIVATION_DISTANCE) {
          clearLongPressTimer();
          longPress = null;
        }
      }
      const current = gesture.current;
      const video = videoRef.current;
      if (!current || current.pointerId !== event.pointerId || !video) return;
      if (!isAndroid) return;

      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (current.mode === "pending") {
        if (absX >= GESTURE_ACTIVATION_DISTANCE && absX > absY * 1.05) {
          current.mode = "seek";
          current.lastSeekX = event.clientX;
          hudGestureDraggingRef.current = true;
          hideGestureFeedback();
        }
        else if (current.side && absY >= GESTURE_ACTIVATION_DISTANCE && absY > absX * 1.05) {
          if (androidBridge()?.playerEnsureBrightnessAccess?.() === false) {
            gesture.current = null;
            return;
          }
          current.mode = "brightness";
        }
        else return;

      }

      event.preventDefault();
      event.stopImmediatePropagation();

      if (current.mode === "brightness") {
        const brightnessDY = removeGestureActivationDistance(dy);
        const rawPercent = (current.startBrightness - brightnessDY / current.rect.height) * 100;
        const percent = Math.max(5, Math.min(100, Math.round(rawPercent / 5) * 5));
        androidBridge()?.playerSetBrightness?.(percent);
        showGestureFeedback(`亮度 ${percent}%`);
        return;
      }

      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const pendingSeekDX = event.clientX - current.lastSeekX;
      current.targetTime = Math.max(
        0,
        Math.min(duration, video.currentTime + (pendingSeekDX / current.viewportWidth) * duration),
      );
      // 只按累计滑动距离触发 seek，避免刷新率、停留时间或原地抖动改变进度。
      if (Math.abs(pendingSeekDX) >= GESTURE_SEEK_DISTANCE_PX) {
        current.lastSeekX = event.clientX;
        hudSeekPendingRef.current = true;
        if (fullscreenHUDVisible) {
          setHUDProgress({ position: current.targetTime, duration });
        }
        video.currentTime = current.targetTime;
      }
    };

    const finishPointer = (event: PointerEvent) => {
      if (systemPointerIds.delete(event.pointerId)) {
        suppressSystemGestureClickUntil = performance.now() + 1000;
        event.stopImmediatePropagation();
        return;
      }
      const currentLongPress = longPress;
      if (currentLongPress?.pointerId === event.pointerId) {
        clearLongPressTimer();
        longPress = null;
        if (currentLongPress.active) {
          const video = videoRef.current;
          if (video) video.playbackRate = currentLongPress.previousRate;
          if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
          try {
            if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
          } catch {
            // The pointer may already have been released by the WebView.
          }
          suppressLongPressClickUntil = performance.now() + 600;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.type === "pointercancel") hideGestureFeedback();
          else scheduleGestureFeedbackHide(250);
          return;
        }
      }
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      gesture.current = null;
      try {
        if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
      } catch {
        // The pointer may already have been released by the WebView.
      }
      if (current.mode === "seek") {
        const video = videoRef.current;
        hudGestureDraggingRef.current = false;
        suppressPlayerGestureClickUntil = performance.now() + 600;
        if (video?.seeking) {
          hudSeekPendingRef.current = true;
        } else if (video) {
          hudSeekPendingRef.current = false;
          setHUDProgress({ position: video.currentTime, duration: video.duration });
          persistProgress(video);
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        hideGestureFeedback();
        return;
      }
      if (current.mode === "brightness") {
        suppressPlayerGestureClickUntil = performance.now() + 600;
        event.preventDefault();
        event.stopImmediatePropagation();
        scheduleGestureFeedbackHide();
        return;
      }

      if (event.type === "pointercancel") {
        hideGestureFeedback();
        return;
      }

      hideGestureFeedback();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (!isAndroid || !nativeFullscreenRef.current) return;
      if (isFullscreenSidePanelTarget(event.target)) return;
      let systemGestureStarted = false;
      for (const touch of Array.from(event.changedTouches)) {
        if (isSystemGestureStart(touch.clientY)) {
          systemTouchIds.add(touch.identifier);
          systemGestureStarted = true;
        }
      }
      if (systemGestureStarted) event.stopImmediatePropagation();
    };

    const onTouchMove = (event: TouchEvent) => {
      if (Array.from(event.changedTouches).some((touch) => systemTouchIds.has(touch.identifier))) {
        event.stopImmediatePropagation();
      }
    };

    const finishTouch = (event: TouchEvent) => {
      let systemGestureEnded = false;
      for (const touch of Array.from(event.changedTouches)) {
        if (systemTouchIds.delete(touch.identifier)) systemGestureEnded = true;
      }
      if (systemGestureEnded) {
        suppressSystemGestureClickUntil = performance.now() + 1000;
        event.stopImmediatePropagation();
      }
    };

    const onClick = (event: MouseEvent) => {
      const now = performance.now();
      if (
        now >= suppressSystemGestureClickUntil
        && now >= suppressLongPressClickUntil
        && now >= suppressPlayerGestureClickUntil
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onContextMenu = (event: MouseEvent) => {
      if (!isMobile || isControlsTarget(event.target)) return;
      event.preventDefault();
    };

    frame.addEventListener("pointerdown", onPointerDown, true);
    frame.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    frame.addEventListener("pointerup", finishPointer, { capture: true, passive: false });
    frame.addEventListener("pointercancel", finishPointer, { capture: true, passive: false });
    frame.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    frame.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
    frame.addEventListener("touchend", finishTouch, { capture: true, passive: true });
    frame.addEventListener("touchcancel", finishTouch, { capture: true, passive: true });
    frame.addEventListener("click", onClick, true);
    frame.addEventListener("contextmenu", onContextMenu, true);

    return () => {
      resetLongPress(true);
      gesture.current = null;
      hudGestureDraggingRef.current = false;
      hudSeekPendingRef.current = false;
      clearGestureFeedbackHideTimer();
      frame.removeEventListener("pointerdown", onPointerDown, true);
      frame.removeEventListener("pointermove", onPointerMove, true);
      frame.removeEventListener("pointerup", finishPointer, true);
      frame.removeEventListener("pointercancel", finishPointer, true);
      frame.removeEventListener("touchstart", onTouchStart, true);
      frame.removeEventListener("touchmove", onTouchMove, true);
      frame.removeEventListener("touchend", finishTouch, true);
      frame.removeEventListener("touchcancel", finishTouch, true);
      frame.removeEventListener("click", onClick, true);
      frame.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, [androidBridge, clearGestureFeedbackHideTimer, fullscreenHUDVisible, hideGestureFeedback, isAndroid, isMobile, mobileLongPressRate, persistProgress, scheduleGestureFeedbackHide, showGestureFeedback]);

  return (
    <div className={`video-player-layout${isMobile ? " video-player-layout--mobile" : " video-player-layout--desktop"}`}>
      <div
        ref={frameRef}
        className={`video-player-frame${isAndroid ? " video-player-frame--android" : ""}${nativeFullscreen ? " video-player-frame--fullscreen" : ""}`}
      >
        <Player.Provider>
          <DriveVideoSkin
            nativeFullscreen={isAndroid ? { active: nativeFullscreen, onToggle: toggleAndroidFullscreen } : undefined}
            mobile={isMobile}
            onTimeSliderProgress={syncHUDWithTimeSlider}
            sidePanel={fullscreenActive ? (
              <VideoPlayerSidebar
                className={`video-player-sidebar video-player-sidebar--fullscreen${fullscreenSidePanelOpen ? "" : " video-player-sidebar--closed"}`}
                visible={fullscreenSidePanelOpen}
                tab={sidePanelTab}
                onTabChange={setSidePanelTab}
                loading={videoSnapshotsLoading}
                snapshots={videoSnapshots}
                extracting={videoSnapshotExtracting}
                completedCount={videoSnapshotCompletedCount}
                plannedCount={videoSnapshotPlannedCount}
                onExtract={(refreshAll) => void startVideoSnapshotExtraction(refreshAll)}
                onStop={stopVideoSnapshotExtraction}
                onClose={() => setFullscreenSidePanelOpen(false)}
                onJump={jumpToVideoSnapshot}
                videos={directoryVideos}
                currentPath={remotePath}
                switchingPath={switchingVideoPath}
                onSelectVideo={(entry) => void selectDirectoryVideo(entry)}
              />
            ) : undefined}
            sidePanelControl={fullscreenActive ? {
              active: fullscreenSidePanelOpen,
              onToggle: () => setFullscreenSidePanelOpen((open) => !open),
            } : undefined}
          >
          <Video
            ref={videoRef}
            src={src}
            playsInline
            autoPlay
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              endedRef.current = false;
              hudSliderDraggingRef.current = false;
              hudGestureDraggingRef.current = false;
              hudSeekPendingRef.current = false;
              if (initialPosition > 0 && initialPosition <= video.duration) {
                video.currentTime = Math.min(initialPosition, Math.max(0, video.duration - 0.1));
              }
              setHUDProgress({ position: video.currentTime, duration: video.duration });
              if (isAndroid && nativeFullscreenRef.current) {
                setAndroidFullscreen(true);
              }
            }}
            onTimeUpdate={(event) => {
              if (
                hudSeekPendingRef.current
                && !event.currentTarget.seeking
                && !hudSliderDraggingRef.current
              ) {
                hudSeekPendingRef.current = false;
              }
              if (fullscreenHUDVisible && !hudSeekPendingRef.current) {
                setHUDProgress({ position: event.currentTarget.currentTime, duration: event.currentTarget.duration });
              }
              if (Date.now() - lastPersistedAt.current >= 3_000) {
                persistProgress(event.currentTarget);
              }
            }}
            onSeeked={(event) => {
              if (hudSliderDraggingRef.current) return;
              if (hudGestureDraggingRef.current) {
                hudSeekPendingRef.current = false;
                setHUDProgress({ position: event.currentTarget.currentTime, duration: event.currentTarget.duration });
                return;
              }
              hudSliderDraggingRef.current = false;
              hudSeekPendingRef.current = false;
              setHUDProgress({ position: event.currentTarget.currentTime, duration: event.currentTarget.duration });
              persistProgress(event.currentTarget);
            }}
            onEnded={(event) => {
              const video = event.currentTarget;
              endedRef.current = true;
              hudSliderDraggingRef.current = false;
              hudGestureDraggingRef.current = false;
              hudSeekPendingRef.current = false;
              setHUDProgress({ position: video.duration, duration: video.duration });
              if (Number.isFinite(video.duration) && video.duration > 0) {
                lastPersistedAt.current = Date.now();
                onPersistProgress(remotePathRef.current, video.duration, video.duration);
              }
            }}
          />
          <div className="video-mini-progress" aria-hidden="true">
            <div ref={miniProgressRef} className="video-mini-progress__fill" />
          </div>
          <div ref={gestureFeedbackRef} className="media-surface video-gesture-feedback" hidden aria-live="polite" />
          {fullscreenHUDVisible && (
            <div
              className="video-fullscreen-hud"
              style={{
                left: `${fullscreenHUDSideOffsetPX}px`,
                right: `${fullscreenHUDSideOffsetPX}px`,
              }}
              aria-hidden="true"
            >
              <span className="video-fullscreen-hud__chip video-fullscreen-hud__status">
                <span>{formatHUDClock(hudClock)}</span>
                {hudBatteryPercent !== null && <span>{hudBatteryPercent}%</span>}
              </span>
              <span className="video-fullscreen-hud__chip video-fullscreen-hud__progress">
                {formatPlayerTime(hudProgress.position)} / {formatPlayerTime(hudProgress.duration)}
              </span>
            </div>
          )}
          </DriveVideoSkin>
        </Player.Provider>
      </div>

      <VideoPlayerSidebar
        className={`video-player-sidebar${fullscreenActive ? " video-player-sidebar--detached-hidden" : ""}`}
        visible={!fullscreenActive}
        twoColumns={isMobile}
        tab={sidePanelTab}
        onTabChange={setSidePanelTab}
        loading={videoSnapshotsLoading}
        snapshots={videoSnapshots}
        extracting={videoSnapshotExtracting}
        completedCount={videoSnapshotCompletedCount}
        plannedCount={videoSnapshotPlannedCount}
        onExtract={(refreshAll) => void startVideoSnapshotExtraction(refreshAll)}
        onStop={stopVideoSnapshotExtraction}
        onJump={jumpToVideoSnapshot}
        videos={directoryVideos}
        currentPath={remotePath}
        switchingPath={switchingVideoPath}
        onSelectVideo={(entry) => void selectDirectoryVideo(entry)}
      />
    </div>
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "未知错误";
  }
}

function isVideo(entry: FileEntry) {
  if (entry.isDirectory) return false;
  if (entry.contentType?.toLowerCase().startsWith("video/")) return true;
  const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.has(extension);
}

function captureVideoThumbnail(src: string, offsetPercent: number, signal: AbortSignal) {
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

    const onAbort = () => finish(new DOMException("Thumbnail generation aborted", "AbortError"));

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
    video.preload = "auto";
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

function plannedVideoSnapshotTimes(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  let count = 10;
  while (count > 1 && duration / (count + 1) < 1) count -= 1;
  return Array.from({ length: count }, (_, index) => duration * (index + 1) / (count + 1));
}

function hasVideoSnapshotAt(snapshots: VideoSnapshot[], position: number) {
  return snapshots.some((snapshot) => Math.abs(snapshot.position - position) <= 0.05);
}

function videoSnapshotAbortError() {
  return new DOMException("Video snapshot extraction aborted", "AbortError");
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
    const onError = () => finish(new Error("视频截图源加载失败"));
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
    const onError = () => finish(new Error("视频截图定位失败"));
    signal.addEventListener("abort", onAbort, { once: true });
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    timeout = window.setTimeout(() => finish(new Error("视频截图定位超时")), 30_000);
    video.currentTime = position;
  });
}

async function extractVideoSnapshots(
  src: string,
  positions: number[],
  signal: AbortSignal,
  onSnapshot: (snapshot: { position: number; dataUrl: string }) => Promise<void>,
) {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  const dispose = () => {
    video.removeAttribute("src");
    video.load();
  };
  const onAbort = () => dispose();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    video.src = src;
    video.load();
    await waitForVideoSnapshotMetadata(video, signal);
    if (!video.videoWidth || !video.videoHeight) throw new Error("视频没有可截图的原始画面");
    if (positions.length === 0) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建视频截图画布");

    for (const position of positions) {
      if (signal.aborted) throw videoSnapshotAbortError();
      await seekVideoForSnapshot(video, position, signal);
      if (signal.aborted) throw videoSnapshotAbortError();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      await onSnapshot({ position, dataUrl: canvas.toDataURL("image/png") });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    dispose();
  }
}

function formatSize(bytes: number) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatFrameRate(frameRate: number) {
  if (!Number.isFinite(frameRate) || frameRate <= 0) return "";
  const rounded = Math.round(frameRate * 1000) / 1000;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function hasCompleteVideoMediaMetadata(metadata?: VideoMediaMetadata) {
  return Boolean(
    metadata
      && metadata.width > 0
      && metadata.height > 0
      && Number.isFinite(metadata.frameRate)
      && metadata.frameRate > 0,
  );
}

function formatVideoMediaMetadata(metadata?: VideoMediaMetadata) {
  if (!hasCompleteVideoMediaMetadata(metadata) || !metadata) return "";
  return `${metadata.width}×${metadata.height}@${formatFrameRate(metadata.frameRate)}`;
}

function formatDate(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function normalizePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/\\/g, "/").replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
}

function parentDirectory(value: string) {
  const normalized = normalizePath(value);
  if (normalized === "/") return "/";
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function breadcrumbs(value: string) {
  const parts = normalizePath(value).split("/").filter(Boolean);
  return parts.map((name, index) => ({
    name,
    path: `/${parts.slice(0, index + 1).join("/")}`,
  }));
}

function LoginView({
  state,
  onLogin123,
  onLoginQuark,
  initialError,
}: {
  state: AppState;
  onLogin123: (username: string, password: string) => Promise<void>;
  onLoginQuark: (cookie: string) => Promise<void>;
  initialError?: string;
}) {
  const [provider, setProvider] = useState<"123" | "quark">(state.provider === "quark" ? "quark" : "123");
  const [username, setUsername] = useState(state.username ?? "");
  const [password, setPassword] = useState(state.password ?? "");
  const [quarkCookie, setQuarkCookie] = useState(state.quarkCookie ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialError ?? "");

  useEffect(() => {
    setError(initialError ?? "");
  }, [initialError]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (provider === "quark") {
        await onLoginQuark(quarkCookie);
      } else {
        await onLogin123(username, password);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell">
      <Card className="w-full max-w-md shadow-xl shadow-black/5">
        <CardHeader className="space-y-4">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <HardDrive className="size-6" />
          </div>
          <div className="space-y-1.5">
            <CardTitle className="text-2xl">
              {provider === "quark" ? "连接夸克网盘" : "连接 123 云盘"}
            </CardTitle>
            <CardDescription>
              {provider === "quark"
                ? "使用浏览器登录夸克网盘后的 Cookie 登录。"
                : "使用 123 云盘“第三方挂载”生成的 WebDAV 账号和应用密码登录。"}
            </CardDescription>
          </div>
        </CardHeader>
        <form onSubmit={submit} className="flex flex-col gap-(--card-spacing)">
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={provider === "123" ? "default" : "outline"}
                onClick={() => {
                  setProvider("123");
                  setError("");
                }}
              >
                123 云盘
              </Button>
              <Button
                type="button"
                variant={provider === "quark" ? "default" : "outline"}
                onClick={() => {
                  setProvider("quark");
                  setError("");
                }}
              >
                夸克网盘
              </Button>
            </div>
            {error && (
              <Alert variant="destructive">
                <CircleAlert className="size-4" />
                <AlertTitle>登录失败</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {provider === "quark" ? (
              <div className="grid gap-2">
                <Label htmlFor="quark-cookie">Cookie</Label>
                <Textarea
                  id="quark-cookie"
                  value={quarkCookie}
                  onChange={(event) => setQuarkCookie(event.target.value)}
                  placeholder="粘贴 pan.quark.cn 登录后的完整 Cookie"
                  className="min-h-36 resize-y font-mono text-xs"
                  autoFocus
                  spellCheck={false}
                />
                <div className="text-xs text-muted-foreground">
                  Cookie 会和现有 123 云盘凭据一样保存在本机应用配置中。
                </div>
              </div>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="username">账号</Label>
                  <Input
                    id="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="WebDAV 账号"
                    autoComplete="username"
                    autoFocus
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="password">密码</Label>
                  <Input
                    id="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="WebDAV 应用密码"
                    type="password"
                    autoComplete="current-password"
                  />
                </div>
              </>
            )}
            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">
                {provider === "quark" ? "夸克 API" : "WebDAV 地址"}
              </div>
              <div className="mt-1 break-all font-mono">
                {provider === "quark" ? state.quarkEndpoint : state.endpoint}
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button
              className="w-full"
              type="submit"
              disabled={
                submitting ||
                (provider === "quark" ? quarkCookie.trim().length === 0 : !username || !password)
              }
            >
              {submitting && <LoaderCircle className="animate-spin" />}
              登录并浏览文件
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}

function AccountLoginDialog({
  provider,
  state,
  onClose,
  onLogin123,
  onLoginQuark,
}: {
  provider: "123" | "quark";
  state: AppState;
  onClose: () => void;
  onLogin123: (username: string, password: string) => Promise<void>;
  onLoginQuark: (cookie: string) => Promise<void>;
}) {
  const [username, setUsername] = useState(state.username ?? "");
  const [password, setPassword] = useState(state.password ?? "");
  const [quarkCookie, setQuarkCookie] = useState(state.quarkCookie ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (provider === "quark") {
        await onLoginQuark(quarkCookie);
      } else {
        await onLogin123(username, password);
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{provider === "quark" ? "登录夸克网盘" : "登录 123 云盘"}</DialogTitle>
          <DialogDescription>
            {provider === "quark"
              ? "登录后会和 123 云盘同时保持在线，可从顶部随时切换。"
              : "登录后会和夸克网盘同时保持在线，可从顶部随时切换。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <CircleAlert className="size-4" />
              <AlertTitle>登录失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {provider === "quark" ? (
            <div className="grid gap-2">
              <Label htmlFor="account-quark-cookie">Cookie</Label>
              <Textarea
                id="account-quark-cookie"
                value={quarkCookie}
                onChange={(event) => setQuarkCookie(event.target.value)}
                placeholder="粘贴 pan.quark.cn 登录后的完整 Cookie"
                className="min-h-36 resize-y font-mono text-xs"
                autoFocus
                spellCheck={false}
              />
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="account-123-username">账号</Label>
                <Input
                  id="account-123-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="WebDAV 账号"
                  autoFocus
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="account-123-password">密码</Label>
                <Input
                  id="account-123-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="WebDAV 应用密码"
                  type="password"
                />
              </div>
            </>
          )}
          <Button
            className="w-full"
            type="submit"
            disabled={
              submitting ||
              (provider === "quark" ? quarkCookie.trim().length === 0 : !username || !password)
            }
          >
            {submitting && <LoaderCircle className="animate-spin" />}
            登录
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function App() {
  const userAgent = navigator.userAgent;
  const isAndroid = System.IsAndroid() || /Android/i.test(userAgent);
  const isIOS = System.IsIOS() || /iPhone|iPad|iPod/i.test(userAgent);
  const isMobile = System.IsMobile() || isAndroid || isIOS;
  const [directoryCacheSettings, setDirectoryCacheSettings] = useState<DirectoryCacheSettings>(() =>
    loadDirectoryCacheSettings(),
  );
  const [state, setState] = useState<AppState | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [thumbnailImages, setThumbnailImages] = useState<Record<string, string>>({});
  const [videoMetadataByPath, setVideoMetadataByPath] = useState<Record<string, VideoMediaMetadata>>({});
  const [videoMetadataStats, setVideoMetadataStats] = useState<VideoMetadataCacheStats>({ count: 0, totalBytes: 0 });
  const [refreshingVideoMetadataPaths, setRefreshingVideoMetadataPaths] = useState<Set<string>>(() => new Set());
  const [videoSnapshotStats, setVideoSnapshotStats] = useState<VideoSnapshotCacheStats>({ count: 0, totalBytes: 0 });
  const [playbackProgressStats, setPlaybackProgressStats] = useState<PlaybackProgressStats>({ count: 0, totalBytes: 0 });
  const [quarkIDCacheStats, setQuarkIDCacheStats] = useState<QuarkIDCacheStats>({ count: 0 });
  const [providerBrowseStats, setProviderBrowseStats] = useState<Record<CloudProvider, ProviderBrowseStats>>({
    "123": {
      directoryCache: { count: 0, totalEntries: 0, totalBytes: 0 },
      scrollPositions: 0,
      backHistory: 0,
      forwardHistory: 0,
    },
    quark: {
      directoryCache: { count: 0, totalEntries: 0, totalBytes: 0 },
      scrollPositions: 0,
      backHistory: 0,
      forwardHistory: 0,
    },
  });
  const [webdavCacheCount, setWebDAVCacheCount] = useState(0);
  const [quarkDownloadCacheCount, setQuarkDownloadCacheCount] = useState(0);
  const [currentPath, setCurrentPath] = useState("/");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [loginProvider, setLoginProvider] = useState<CloudProvider | null>(null);
  const [activeVideo, setActiveVideo] = useState<ActiveVideo | null>(null);
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!error || showSettings) return;
    toast.add({ title: "请求失败", description: error, type: "error" });
    setError("");
  }, [error, showSettings]);

  const [webdavCacheTTLInput, setWebDAVCacheTTLInput] = useState("30");
  const [quarkDownloadCacheTTLInput, setQuarkDownloadCacheTTLInput] = useState("30");
  const [quarkIDCacheTTLInput, setQuarkIDCacheTTLInput] = useState("30");
  const [directoryCacheTTLInput, setDirectoryCacheTTLInput] = useState(String(directoryCacheSettings.ttlMinutes));
  const [directoryCacheMaxSizeInput, setDirectoryCacheMaxSizeInput] = useState(String(directoryCacheSettings.maxSizeMB));
  const [videoMetadataMaxAgeInput, setVideoMetadataMaxAgeInput] = useState("30");
  const [videoMetadataMaxSizeInput, setVideoMetadataMaxSizeInput] = useState("512");
  const [videoMetadataThumbnailOffsetPercentInput, setVideoMetadataThumbnailOffsetPercentInput] = useState("10");
  const [videoSnapshotMaxAgeInput, setVideoSnapshotMaxAgeInput] = useState("30");
  const [videoSnapshotMaxSizeInput, setVideoSnapshotMaxSizeInput] = useState("1024");
  const [playbackMaxAgeInput, setPlaybackMaxAgeInput] = useState("365");
  const [playbackMaxSizeInput, setPlaybackMaxSizeInput] = useState("16");
  const [mobileLongPressRateInput, setMobileLongPressRateInput] = useState("3");
  const [fullscreenHUDEnabledInput, setFullscreenHUDEnabledInput] = useState(false);
  const [fullscreenHUDSideOffsetInput, setFullscreenHUDSideOffsetInput] = useState("0");
  const [fullscreenHUDToggleSaving, setFullscreenHUDToggleSaving] = useState(false);
  const directoryRequestId = useRef(0);
  const openContextMenuPath = useRef("");
  const directoryRequest = useRef<ReturnType<typeof AppService.ListDirectory> | null>(null);
  const directoryAbortController = useRef<AbortController | null>(null);
  const videoMetadataAbortController = useRef<AbortController | null>(null);
  const directoryScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbScrollRef = useRef<HTMLElement | null>(null);
  const providerBrowseSessions = useRef<Record<CloudProvider, ProviderBrowseSession>>({
    "123": createProviderBrowseSession(),
    quark: createProviderBrowseSession(),
  });
  const activeBrowseProvider = useRef<CloudProvider>("123");
  const directoryScrollPositions = useRef(providerBrowseSessions.current["123"].scrollPositions);
  const pendingDirectoryScrollRestore = useRef<{ path: string; scrollTop: number } | null>(null);
  const currentPathRef = useRef("/");
  const directoryBackHistory = useRef(providerBrowseSessions.current["123"].backHistory);
  const directoryForwardHistory = useRef(providerBrowseSessions.current["123"].forwardHistory);
  const videoMetadataReloadNeeded = useRef(false);
  const directoryCache = useRef(providerBrowseSessions.current["123"].directoryCache);
  const directoryCacheSettingsRef = useRef(directoryCacheSettings);

  const pointBrowseRefsAtProvider = useCallback((provider: CloudProvider) => {
    const session = providerBrowseSessions.current[provider];
    activeBrowseProvider.current = provider;
    directoryCache.current = session.directoryCache;
    directoryScrollPositions.current = session.scrollPositions;
    directoryBackHistory.current = session.backHistory;
    directoryForwardHistory.current = session.forwardHistory;
    currentPathRef.current = session.currentPath;
  }, []);

  const refreshProviderBrowseStats = useCallback((settings = directoryCacheSettingsRef.current) => {
    const statsFor = (provider: CloudProvider): ProviderBrowseStats => {
      const session = providerBrowseSessions.current[provider];
      return {
        directoryCache: pruneDirectoryCache(session.directoryCache, settings),
        scrollPositions: session.scrollPositions.size,
        backHistory: session.backHistory.length,
        forwardHistory: session.forwardHistory.length,
      };
    };
    setProviderBrowseStats({
      "123": statsFor("123"),
      quark: statsFor("quark"),
    });
  }, []);

  const syncBackendState = useCallback((nextState: AppState) => {
    setState(nextState);
    setWebDAVCacheTTLInput(String(nextState.webdavCacheTTLMinutes));
    setQuarkDownloadCacheTTLInput(String(nextState.quarkDownloadCacheTTLMinutes));
    setQuarkIDCacheTTLInput(String(nextState.quarkIDCacheTTLMinutes));
    setVideoMetadataMaxAgeInput(String(nextState.videoMetadataMaxAgeDays));
    setVideoMetadataMaxSizeInput(String(nextState.videoMetadataMaxSizeMB));
    setVideoMetadataThumbnailOffsetPercentInput(String(nextState.videoMetadataThumbnailOffsetPercent));
    setVideoSnapshotMaxAgeInput(String(nextState.videoSnapshotMaxAgeDays));
    setVideoSnapshotMaxSizeInput(String(nextState.videoSnapshotMaxSizeMB));
    setPlaybackMaxAgeInput(String(nextState.playbackMaxAgeDays));
    setPlaybackMaxSizeInput(String(nextState.playbackMaxSizeMB));
    setMobileLongPressRateInput(String(nextState.mobileLongPressRate));
    setFullscreenHUDEnabledInput(nextState.fullscreenHudEnabled);
    setFullscreenHUDSideOffsetInput(String(nextState.fullscreenHudSideOffsetPx));
  }, []);

  useEffect(() => {
    AppService.GetState()
      .then(async (nextState) => {
        syncBackendState(nextState);

        const preferredProvider = nextState.provider;
        let restoredState = nextState;
        const restoreErrors: string[] = [];

        if (!restoredState.connected123 && nextState.username && nextState.password) {
          try {
            restoredState = await AppService.Login(nextState.username, nextState.password);
            syncBackendState(restoredState);
          } catch (err) {
            restoreErrors.push(`123 云盘自动登录失败：${errorMessage(err)}`);
          }
        }
        if (!restoredState.connectedQuark && nextState.quarkCookie) {
          try {
            restoredState = await AppService.LoginQuark(nextState.quarkCookie);
            syncBackendState(restoredState);
          } catch (err) {
            restoreErrors.push(`夸克网盘自动登录失败：${errorMessage(err)}`);
          }
        }

        const preferredConnected =
          preferredProvider === "quark" ? restoredState.connectedQuark : restoredState.connected123;
        if (preferredConnected && restoredState.provider !== preferredProvider) {
          try {
            restoredState = await AppService.SwitchProvider(preferredProvider);
            syncBackendState(restoredState);
          } catch (err) {
            restoreErrors.push(`恢复当前网盘失败：${errorMessage(err)}`);
          }
        }

        pointBrowseRefsAtProvider(normalizeProvider(restoredState.provider));

        if (restoreErrors.length > 0) {
          setError(restoreErrors.join("；"));
        }
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setRestoringSession(false));
  }, [pointBrowseRefsAtProvider, syncBackendState]);

  useEffect(
    () => () => {
      directoryRequest.current?.cancel("component unmounted");
      directoryAbortController.current?.abort();
      videoMetadataAbortController.current?.abort();
    },
    [],
  );

  useLayoutEffect(() => {
    if (loading) return;
    const pending = pendingDirectoryScrollRestore.current;
    if (!pending || pending.path !== currentPath) return;
    const viewport = directoryScrollViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = pending.scrollTop;
    pendingDirectoryScrollRestore.current = null;
  }, [currentPath, entries, loading]);

  useLayoutEffect(() => {
    let settleFrame = 0;
    const layoutFrame = window.requestAnimationFrame(() => {
      const breadcrumb = breadcrumbScrollRef.current;
      if (!breadcrumb) return;

      breadcrumb.scrollLeft = Math.max(0, breadcrumb.scrollWidth - breadcrumb.clientWidth);

      settleFrame = window.requestAnimationFrame(() => {
        const settledBreadcrumb = breadcrumbScrollRef.current;
        if (!settledBreadcrumb) return;
        settledBreadcrumb.scrollLeft = Math.max(
          0,
          settledBreadcrumb.scrollWidth - settledBreadcrumb.clientWidth,
        );
      });
    });

    return () => {
      window.cancelAnimationFrame(layoutFrame);
      if (settleFrame) window.cancelAnimationFrame(settleFrame);
    };
  }, [currentPath]);

  const getCachedDirectory = useCallback((remotePath: string) => {
    const now = Date.now();
    const cache = directoryCache.current;
    pruneDirectoryCache(cache, directoryCacheSettingsRef.current, now);
    const item = cache.get(remotePath);
    if (!item) return null;
    item.lastAccess = now;
    return item.entries;
  }, []);

  const cacheDirectory = useCallback((remotePath: string, sourceEntries: FileEntry[]) => {
    const now = Date.now();
    const cachedEntries = sourceEntries.slice();
    directoryCache.current.set(remotePath, {
      entries: cachedEntries,
      cachedAt: now,
      lastAccess: now,
      sizeBytes: estimateDirectoryCacheSize(remotePath, cachedEntries),
    });
    pruneDirectoryCache(directoryCache.current, directoryCacheSettingsRef.current, now);
  }, []);

  const rememberDirectoryScrollPosition = useCallback((remotePath: string, scrollTop: number) => {
    const cache = directoryScrollPositions.current;
    cache.delete(remotePath);
    cache.set(remotePath, scrollTop);
    while (cache.size > DIRECTORY_SCROLL_POSITION_CACHE_LIMIT) {
      const oldestPath = cache.keys().next().value as string | undefined;
      if (oldestPath === undefined) break;
      cache.delete(oldestPath);
    }
  }, []);

  const getDirectoryScrollPosition = useCallback((remotePath: string) => {
    const cache = directoryScrollPositions.current;
    const scrollTop = cache.get(remotePath);
    if (scrollTop === undefined) return 0;
    cache.delete(remotePath);
    cache.set(remotePath, scrollTop);
    return scrollTop;
  }, []);

  const generateAndCacheVideoMetadata = useCallback(async (entry: FileEntry, signal: AbortSignal) => {
    const playbackURL = await AppService.GetPlaybackURL(entry.path);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const [thumbnail, analyzedMetadata] = await Promise.all([
      captureVideoThumbnail(
        playbackURL,
        state?.videoMetadataThumbnailOffsetPercent ?? 10,
        signal,
      ),
      analyzeVideoMetadata(playbackURL, entry.size, signal),
    ]);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const mediaMetadata: VideoMediaMetadata = {
      width: analyzedMetadata.width || thumbnail.width,
      height: analyzedMetadata.height || thumbnail.height,
      frameRate: analyzedMetadata.frameRate,
    };
    if (!hasCompleteVideoMediaMetadata(mediaMetadata)) {
      throw new Error("视频元信息不完整");
    }

    await AppService.SaveVideoMetadata(
      entry.path,
      entry.modifiedAt,
      thumbnail.dataUrl,
      mediaMetadata.width,
      mediaMetadata.height,
      mediaMetadata.frameRate,
    );
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    return { thumbnailDataURL: thumbnail.dataUrl, mediaMetadata };
  }, [state?.videoMetadataThumbnailOffsetPercent]);

  const startThumbnailLoading = useCallback((sourceEntries: FileEntry[], requestId: number) => {
    videoMetadataAbortController.current?.abort();
    const controller = new AbortController();
    videoMetadataAbortController.current = controller;
    const videos = sourceEntries.filter(isVideo);

    void (async () => {
      let nextVideoIndex = 0;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const index = nextVideoIndex;
          nextVideoIndex += 1;
          if (index >= videos.length) return;
          const entry = videos[index];
          try {
            const cached = await AppService.GetVideoMetadata(entry.path, entry.modifiedAt);
            if (controller.signal.aborted || requestId !== directoryRequestId.current) return;
            if (cached.found && cached.thumbnailDataUrl) {
              const mediaMetadata: VideoMediaMetadata = {
                width: cached.width,
                height: cached.height,
                frameRate: cached.frameRate,
              };
              setThumbnailImages((current) => ({ ...current, [entry.path]: cached.thumbnailDataUrl }));
              setVideoMetadataByPath((current) => ({ ...current, [entry.path]: mediaMetadata }));
              continue;
            }

            const generated = await generateAndCacheVideoMetadata(entry, controller.signal);
            if (controller.signal.aborted || requestId !== directoryRequestId.current) return;
            setThumbnailImages((current) => ({ ...current, [entry.path]: generated.thumbnailDataURL }));
            setVideoMetadataByPath((current) => ({ ...current, [entry.path]: generated.mediaMetadata }));
          } catch (err) {
            if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
            // A codec, seek, or metadata failure for one video should not block the directory or other video metadata jobs.
          }
        }
      };

      const workerCount = Math.min(VIDEO_METADATA_CONCURRENCY, videos.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    })();
  }, [generateAndCacheVideoMetadata]);

  const refreshVideoMetadata = useCallback(async (entry: FileEntry) => {
    if (!isVideo(entry) || refreshingVideoMetadataPaths.has(entry.path)) return;

    setRefreshingVideoMetadataPaths((current) => {
      const next = new Set(current);
      next.add(entry.path);
      return next;
    });
    const requestId = directoryRequestId.current;
    const controller = new AbortController();

    try {
      const generated = await generateAndCacheVideoMetadata(entry, controller.signal);
      if (requestId === directoryRequestId.current) {
        setThumbnailImages((current) => ({ ...current, [entry.path]: generated.thumbnailDataURL }));
        setVideoMetadataByPath((current) => ({ ...current, [entry.path]: generated.mediaMetadata }));
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        toast.add({ title: "重新获取元信息失败", description: errorMessage(err), type: "error" });
      }
    } finally {
      setRefreshingVideoMetadataPaths((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
    }
  }, [generateAndCacheVideoMetadata, refreshingVideoMetadataPaths]);

  const loadDirectory = useCallback(async (targetPath: string, forceRefresh = false) => {
    const normalized = normalizePath(targetPath);
    const requestId = ++directoryRequestId.current;
    const viewport = directoryScrollViewportRef.current;
    if (viewport) {
      rememberDirectoryScrollPosition(currentPathRef.current, viewport.scrollTop);
    }
    directoryRequest.current?.cancel("directory changed");
    directoryRequest.current = null;
    directoryAbortController.current?.abort();
    videoMetadataAbortController.current?.abort();
    const controller = new AbortController();
    directoryAbortController.current = controller;
    setError("");

    if (!forceRefresh) {
      const cached = getCachedDirectory(normalized);
      if (cached !== null) {
        const visibleEntries = cached.filter((entry) => entry.isDirectory || isVideo(entry));
        currentPathRef.current = normalized;
        pendingDirectoryScrollRestore.current = {
          path: normalized,
          scrollTop: getDirectoryScrollPosition(normalized),
        };
        setCurrentPath(normalized);
        setThumbnailImages({});
        setVideoMetadataByPath({});
        setEntries(visibleEntries);
        setLoading(false);
        startThumbnailLoading(visibleEntries, requestId);
        return;
      }
    }

    if (requestId !== directoryRequestId.current || controller.signal.aborted) return;
    currentPathRef.current = normalized;
    setCurrentPath(normalized);
    setEntries([]);
    setThumbnailImages({});
    setVideoMetadataByPath({});
    setLoading(true);
    const request = AppService.ListDirectory(normalized);
    directoryRequest.current = request;
    try {
      const result = (await request) ?? [];
      if (requestId !== directoryRequestId.current || controller.signal.aborted) return;

      cacheDirectory(normalized, result);
      const visibleEntries = result.filter((entry) => entry.isDirectory || isVideo(entry));
      pendingDirectoryScrollRestore.current = {
        path: normalized,
        scrollTop: getDirectoryScrollPosition(normalized),
      };
      setEntries(visibleEntries);
      setLoading(false);
      startThumbnailLoading(visibleEntries, requestId);
    } catch (err) {
      if (requestId !== directoryRequestId.current || controller.signal.aborted) return;
      setError(errorMessage(err));
    } finally {
      if (requestId === directoryRequestId.current) {
        directoryRequest.current = null;
        setLoading(false);
      }
    }
  }, [cacheDirectory, getCachedDirectory, getDirectoryScrollPosition, rememberDirectoryScrollPosition, startThumbnailLoading]);

  const syncDirectoryHistoryState = useCallback(() => {
    setCanGoBack(directoryBackHistory.current.length > 0);
    setCanGoForward(directoryForwardHistory.current.length > 0);
  }, []);

  const navigateDirectory = useCallback((targetPath: string) => {
    const normalized = normalizePath(targetPath);
    const current = currentPathRef.current;
    if (normalized === current) return;

    if (isMobile) {
      directoryBackHistory.current.length = 0;
      directoryForwardHistory.current.length = 0;
    } else {
      const back = directoryBackHistory.current;
      back.push(current);
      if (back.length > DIRECTORY_HISTORY_LIMIT) back.shift();
      directoryForwardHistory.current.length = 0;
    }
    syncDirectoryHistoryState();
    void loadDirectory(normalized);
  }, [isMobile, loadDirectory, syncDirectoryHistoryState]);

  const goParentDirectory = useCallback(() => {
    const current = currentPathRef.current;
    if (current === "/") return;
    directoryBackHistory.current.length = 0;
    directoryForwardHistory.current.length = 0;
    syncDirectoryHistoryState();
    void loadDirectory(parentDirectory(current));
  }, [loadDirectory, syncDirectoryHistoryState]);

  const goBackDirectory = useCallback(() => {
    const back = directoryBackHistory.current;
    const target = back.pop();
    if (target === undefined) return;

    const forward = directoryForwardHistory.current;
    forward.push(currentPathRef.current);
    if (forward.length > DIRECTORY_HISTORY_LIMIT) forward.shift();
    syncDirectoryHistoryState();
    void loadDirectory(target);
  }, [loadDirectory, syncDirectoryHistoryState]);

  const goForwardDirectory = useCallback(() => {
    const forward = directoryForwardHistory.current;
    const target = forward.pop();
    if (target === undefined) return;

    const back = directoryBackHistory.current;
    back.push(currentPathRef.current);
    if (back.length > DIRECTORY_HISTORY_LIMIT) back.shift();
    syncDirectoryHistoryState();
    void loadDirectory(target);
  }, [loadDirectory, syncDirectoryHistoryState]);

  const saveActiveBrowseSession = useCallback(() => {
    const viewport = directoryScrollViewportRef.current;
    if (viewport) {
      rememberDirectoryScrollPosition(currentPathRef.current, viewport.scrollTop);
    }
    const session = providerBrowseSessions.current[activeBrowseProvider.current];
    session.currentPath = currentPathRef.current;
    session.entries = entries.slice();
    session.thumbnailImages = { ...thumbnailImages };
    session.videoMetadataByPath = { ...videoMetadataByPath };
  }, [entries, rememberDirectoryScrollPosition, thumbnailImages, videoMetadataByPath]);

  const resetProviderBrowseSession = useCallback((provider: CloudProvider) => {
    providerBrowseSessions.current[provider] = createProviderBrowseSession();
    if (activeBrowseProvider.current === provider) {
      pointBrowseRefsAtProvider(provider);
    }
  }, [pointBrowseRefsAtProvider]);

  const restoreProviderBrowseSession = useCallback((provider: CloudProvider) => {
    pointBrowseRefsAtProvider(provider);
    const session = providerBrowseSessions.current[provider];
    setCurrentPath(session.currentPath);
    syncDirectoryHistoryState();

    const cached = getCachedDirectory(session.currentPath);
    if (cached === null) {
      session.entries = [];
      session.thumbnailImages = {};
      session.videoMetadataByPath = {};
      setEntries([]);
      setThumbnailImages({});
      setVideoMetadataByPath({});
      void loadDirectory(session.currentPath);
      return;
    }

    const visibleEntries = cached.filter((entry) => entry.isDirectory || isVideo(entry));
    session.entries = visibleEntries.slice();
    setEntries(visibleEntries);
    setThumbnailImages({ ...session.thumbnailImages });
    setVideoMetadataByPath({ ...session.videoMetadataByPath });
    pendingDirectoryScrollRestore.current = {
      path: session.currentPath,
      scrollTop: getDirectoryScrollPosition(session.currentPath),
    };
    setLoading(false);
    const requestId = ++directoryRequestId.current;
    startThumbnailLoading(visibleEntries, requestId);
  }, [getCachedDirectory, getDirectoryScrollPosition, loadDirectory, pointBrowseRefsAtProvider, startThumbnailLoading, syncDirectoryHistoryState]);

  useEffect(() => {
    const handleHistoryMouseButton = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== "mousedown" || showSettings || activeVideo) return;
      if (event.button === 3) goBackDirectory();
      else goForwardDirectory();
    };

    window.addEventListener("mousedown", handleHistoryMouseButton, true);
    window.addEventListener("mouseup", handleHistoryMouseButton, true);
    window.addEventListener("auxclick", handleHistoryMouseButton, true);
    return () => {
      window.removeEventListener("mousedown", handleHistoryMouseButton, true);
      window.removeEventListener("mouseup", handleHistoryMouseButton, true);
      window.removeEventListener("auxclick", handleHistoryMouseButton, true);
    };
  }, [activeVideo, goBackDirectory, goForwardDirectory, showSettings]);

  useEffect(() => {
    if (!restoringSession && state?.connected) {
      void loadDirectory(currentPath);
    }
    // Wait for both saved sessions to restore before the initial directory load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoringSession]);

  const refreshProviderCaches = useCallback(async () => {
    try {
      const [webdavEntries, quarkEntries] = await Promise.all([
        AppService.ListRedirectCache("123"),
        AppService.ListRedirectCache("quark"),
      ]);
      setWebDAVCacheCount((webdavEntries ?? []).length);
      setQuarkDownloadCacheCount((quarkEntries ?? []).length);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const refreshVideoMetadataStats = useCallback(async () => {
    try {
      setVideoMetadataStats(await AppService.GetVideoMetadataCacheStats());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const refreshVideoSnapshotStats = useCallback(async () => {
    try {
      setVideoSnapshotStats(await AppService.GetVideoSnapshotCacheStats());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const refreshPlaybackProgressStats = useCallback(async () => {
    try {
      setPlaybackProgressStats(await AppService.GetPlaybackProgressStats());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const refreshQuarkIDCacheStats = useCallback(async () => {
    try {
      setQuarkIDCacheStats(await AppService.GetQuarkIDCacheStats());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const completeLogin = (nextState: AppState, provider: CloudProvider) => {
    directoryRequest.current?.cancel("provider login");
    directoryAbortController.current?.abort();
    videoMetadataAbortController.current?.abort();
    resetProviderBrowseSession(provider);
    syncBackendState(nextState);
    setQuarkIDCacheStats({ count: 0 });
    setShowSettings(false);
    setLoginProvider(null);
    setError("");
    restoreProviderBrowseSession(provider);
    void refreshProviderCaches();
    if (provider === "quark") void refreshQuarkIDCacheStats();
  };

  const login123 = async (username: string, password: string) => {
    saveActiveBrowseSession();
    completeLogin(await AppService.Login(username, password), "123");
  };

  const loginQuark = async (cookie: string) => {
    saveActiveBrowseSession();
    completeLogin(await AppService.LoginQuark(cookie), "quark");
  };

  const switchProvider = async (provider: CloudProvider) => {
    if (!state || state.provider === provider) return;
    const connected = provider === "quark" ? state.connectedQuark : state.connected123;
    if (!connected) {
      setLoginProvider(provider);
      return;
    }

    saveActiveBrowseSession();
    directoryRequest.current?.cancel("provider switched");
    directoryAbortController.current?.abort();
    videoMetadataAbortController.current?.abort();
    const nextState = await AppService.SwitchProvider(provider);
    syncBackendState(nextState);
    restoreProviderBrowseSession(provider);
    setShowSettings(false);
    setError("");
    void refreshProviderCaches();
    if (provider === "quark") {
      void refreshQuarkIDCacheStats();
    } else {
      setQuarkIDCacheStats({ count: 0 });
    }
  };

  const logout = async () => {
    const loggedOutProvider = state ? normalizeProvider(state.provider) : activeBrowseProvider.current;
    directoryRequest.current?.cancel("provider logout");
    directoryAbortController.current?.abort();
    videoMetadataAbortController.current?.abort();
    const nextState = await AppService.Logout();
    resetProviderBrowseSession(loggedOutProvider);
    syncBackendState(nextState);
    setVideoDialogOpen(false);
    setActiveVideo(null);
    setError("");

    if (nextState.connected) {
      const nextProvider = normalizeProvider(nextState.provider);
      restoreProviderBrowseSession(nextProvider);
      void refreshProviderCaches();
      if (nextProvider === "quark") {
        void refreshQuarkIDCacheStats();
      } else {
        setQuarkIDCacheStats({ count: 0 });
      }
      return;
    }

    pointBrowseRefsAtProvider(loggedOutProvider);
    setEntries([]);
    setThumbnailImages({});
    setVideoMetadataByPath({});
    setCurrentPath("/");
    syncDirectoryHistoryState();
    refreshProviderBrowseStats();
    setWebDAVCacheCount(0);
    setQuarkDownloadCacheCount(0);
    setQuarkIDCacheStats({ count: 0 });
  };

  const activateVideoEntry = async (entry: FileEntry) => {
    const [url, progress] = await Promise.all([
      AppService.GetPlaybackURL(entry.path),
      AppService.GetPlaybackProgress(entry.path).catch(() => null),
    ]);
    setActiveVideo({
      name: entry.name,
      path: entry.path,
      modifiedAt: entry.modifiedAt,
      url,
      resumePosition: progress?.found ? progress.position : 0,
    });
    setVideoDialogOpen(true);
    window.setTimeout(() => void refreshProviderCaches(), 600);
  };

  const openEntry = async (entry: FileEntry) => {
    if (entry.isDirectory) {
      navigateDirectory(entry.path);
      return;
    }
    if (!isVideo(entry)) return;
    try {
      videoMetadataAbortController.current?.abort();
      await activateVideoEntry(entry);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const closeVideo = () => {
    setVideoDialogOpen(false);
  };

  const closeSettings = useCallback(() => {
    setShowSettings(false);
    if (videoMetadataReloadNeeded.current) {
      videoMetadataReloadNeeded.current = false;
      void loadDirectory(currentPathRef.current);
    }
  }, [loadDirectory]);

  const persistPlaybackProgress = useCallback((remotePath: string, position: number, duration: number) => {
    void AppService.SavePlaybackProgress(remotePath, position, duration).catch(() => {
      // Progress persistence must never interrupt playback or closing the player.
    });
  }, []);

  const saveWebDAVCacheTTL = async () => {
    const minutes = Number.parseInt(webdavCacheTTLInput, 10);
    if (!Number.isFinite(minutes)) {
      toast.add({ title: "设置无效", description: "请输入有效的 123 URL 缓存分钟数", type: "error" });
      return;
    }
    try {
      const nextState = await AppService.SetWebDAVCacheTTL(minutes);
      syncBackendState(nextState);
      await refreshProviderCaches();
    } catch (err) {
      toast.add({ title: "保存失败", description: errorMessage(err), type: "error" });
    }
  };

  const saveQuarkDownloadCacheTTL = async () => {
    const minutes = Number.parseInt(quarkDownloadCacheTTLInput, 10);
    if (!Number.isFinite(minutes)) {
      toast.add({ title: "设置无效", description: "请输入有效的夸克下载 URL 缓存分钟数", type: "error" });
      return;
    }
    try {
      const nextState = await AppService.SetQuarkDownloadCacheTTL(minutes);
      syncBackendState(nextState);
      await refreshProviderCaches();
    } catch (err) {
      toast.add({ title: "保存失败", description: errorMessage(err), type: "error" });
    }
  };

  const clearProviderCache = async (provider: CloudProvider) => {
    try {
      await AppService.ClearRedirectCache(provider);
      if (provider === "quark") {
        setQuarkDownloadCacheCount(0);
      } else {
        setWebDAVCacheCount(0);
      }
    } catch (err) {
      toast.add({ title: "清空失败", description: errorMessage(err), type: "error" });
    }
  };

  const saveQuarkIDCacheTTL = async () => {
    const minutes = Number.parseInt(quarkIDCacheTTLInput, 10);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      toast.add({ title: "设置无效", description: "路径 ID 缓存时间必须在 1 到 1440 分钟之间", type: "error" });
      return;
    }
    try {
      const nextState = await AppService.SetQuarkIDCacheTTL(minutes);
      syncBackendState(nextState);
      await refreshQuarkIDCacheStats();
    } catch (err) {
      toast.add({ title: "保存失败", description: errorMessage(err), type: "error" });
    }
  };

  const clearQuarkIDCache = async () => {
    try {
      setQuarkIDCacheStats(await AppService.ClearQuarkIDCache());
    } catch (err) {
      toast.add({ title: "清空失败", description: errorMessage(err), type: "error" });
    }
  };

  const saveDirectoryCacheSettings = () => {
    const ttlMinutes = Number.parseInt(directoryCacheTTLInput, 10);
    const maxSizeMB = Number.parseInt(directoryCacheMaxSizeInput, 10);
    if (
      !Number.isInteger(ttlMinutes) ||
      ttlMinutes < MIN_DIRECTORY_CACHE_TTL_MINUTES ||
      ttlMinutes > MAX_DIRECTORY_CACHE_TTL_MINUTES
    ) {
      toast.add({
        title: "设置无效",
        description: `文件列表缓存时间必须在 ${MIN_DIRECTORY_CACHE_TTL_MINUTES} 到 ${MAX_DIRECTORY_CACHE_TTL_MINUTES} 分钟之间`,
        type: "error",
      });
      return;
    }
    if (
      !Number.isInteger(maxSizeMB) ||
      maxSizeMB < MIN_DIRECTORY_CACHE_MAX_SIZE_MB ||
      maxSizeMB > MAX_DIRECTORY_CACHE_MAX_SIZE_MB
    ) {
      toast.add({
        title: "设置无效",
        description: `文件列表缓存上限必须在 ${MIN_DIRECTORY_CACHE_MAX_SIZE_MB} 到 ${MAX_DIRECTORY_CACHE_MAX_SIZE_MB} MB 之间`,
        type: "error",
      });
      return;
    }
    const nextSettings = { ttlMinutes, maxSizeMB };
    directoryCacheSettingsRef.current = nextSettings;
    setDirectoryCacheSettings(nextSettings);
    setDirectoryCacheTTLInput(String(ttlMinutes));
    setDirectoryCacheMaxSizeInput(String(maxSizeMB));
    try {
      window.localStorage.setItem(DIRECTORY_CACHE_SETTINGS_KEY, JSON.stringify(nextSettings));
    } catch {
      // The active in-memory settings still apply even when persistence is unavailable.
    }
    refreshProviderBrowseStats(nextSettings);
  };

  const clearDirectoryCache = (provider: CloudProvider) => {
    providerBrowseSessions.current[provider].directoryCache.clear();
    refreshProviderBrowseStats();
  };

  const saveVideoMetadataSettings = async () => {
    const maxAgeDays = Number.parseInt(videoMetadataMaxAgeInput, 10);
    const maxSizeMB = Number.parseInt(videoMetadataMaxSizeInput, 10);
    const offsetPercent = Number.parseInt(videoMetadataThumbnailOffsetPercentInput, 10);
    if (![maxAgeDays, maxSizeMB, offsetPercent].every(Number.isFinite)) {
      toast.add({ title: "设置无效", description: "请输入有效的视频元信息缓存设置", type: "error" });
      return;
    }
    try {
      const previousOffset = state?.videoMetadataThumbnailOffsetPercent;
      const nextState = await AppService.SetVideoMetadataSettings(maxAgeDays, maxSizeMB, offsetPercent);
      setState(nextState);
      setVideoMetadataMaxAgeInput(String(nextState.videoMetadataMaxAgeDays));
      setVideoMetadataMaxSizeInput(String(nextState.videoMetadataMaxSizeMB));
      setVideoMetadataThumbnailOffsetPercentInput(String(nextState.videoMetadataThumbnailOffsetPercent));
      if (previousOffset !== nextState.videoMetadataThumbnailOffsetPercent) {
        setThumbnailImages({});
        setVideoMetadataByPath({});
        videoMetadataReloadNeeded.current = true;
      }
      await refreshVideoMetadataStats();
    } catch (err) {
      toast.add({ title: "保存失败", description: errorMessage(err), type: "error" });
    }
  };

  const clearVideoMetadataCache = async () => {
    try {
      setVideoMetadataStats(await AppService.ClearVideoMetadataCache());
      setThumbnailImages({});
      setVideoMetadataByPath({});
      videoMetadataReloadNeeded.current = true;
    } catch (err) {
      toast.add({ title: "清空失败", description: errorMessage(err), type: "error" });
    }
  };

  const saveVideoSnapshotSettings = async () => {
    if (!state) return;
    const maxAgeDays = Number.parseInt(videoSnapshotMaxAgeInput, 10);
    const maxSizeMB = Number.parseInt(videoSnapshotMaxSizeInput, 10);
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 3650) {
      toast.add({ title: "设置无效", description: "视频截图保留时间必须在 1 到 3650 天之间", type: "error" });
      return;
    }
    if (!Number.isInteger(maxSizeMB) || maxSizeMB < 64 || maxSizeMB > 10240) {
      toast.add({ title: "设置无效", description: "视频截图缓存上限必须在 64 到 10240 MB 之间", type: "error" });
      return;
    }
    try {
      const nextState = await AppService.SetVideoSnapshotSettings(maxAgeDays, maxSizeMB);
      syncBackendState(nextState);
      await refreshVideoSnapshotStats();
    } catch (err) {
      toast.add({ title: "保存失败", description: errorMessage(err), type: "error" });
    }
  };

  const clearVideoSnapshotCache = async () => {
    try {
      setVideoSnapshotStats(await AppService.ClearVideoSnapshotCache());
    } catch (err) {
      toast.add({ title: "清空失败", description: errorMessage(err), type: "error" });
    }
  };

  const savePlaybackProgressSettings = async () => {
    const maxAgeDays = Number.parseInt(playbackMaxAgeInput, 10);
    const maxSizeMB = Number.parseInt(playbackMaxSizeInput, 10);
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 3650) {
      toast.add({ title: "设置无效", description: "播放进度保留时间必须在 1 到 3650 天之间", type: "error" });
      return;
    }
    if (!Number.isInteger(maxSizeMB) || maxSizeMB < 1 || maxSizeMB > 1024) {
      toast.add({ title: "设置无效", description: "播放进度存储上限必须在 1 到 1024 MB 之间", type: "error" });
      return;
    }
    try {
      const nextState = await AppService.SetPlaybackProgressSettings(maxAgeDays, maxSizeMB);
      setState(nextState);
      setPlaybackMaxAgeInput(String(nextState.playbackMaxAgeDays));
      setPlaybackMaxSizeInput(String(nextState.playbackMaxSizeMB));
      await refreshPlaybackProgressStats();
    } catch (err) {
      toast.add({ title: "保存失败", description: errorMessage(err), type: "error" });
    }
  };

  const setFullscreenHUDEnabled = async (enabled: boolean) => {
    if (!state || fullscreenHUDToggleSaving || enabled === state.fullscreenHudEnabled) return;

    setFullscreenHUDToggleSaving(true);

    try {
      const nextState = await AppService.SetFullscreenHUDSettings(enabled, state.fullscreenHudSideOffsetPx);
      syncBackendState(nextState);
    } catch (err) {
      toast.add({ title: "切换顶部信息失败", description: errorMessage(err), type: "error" });
    } finally {
      setFullscreenHUDToggleSaving(false);
    }
  };

  const saveMobileLongPressRate = async () => {
    if (!state) return;
    const rate = Number.parseFloat(mobileLongPressRateInput);
    if (!Number.isFinite(rate) || rate < 1 || rate > 8) {
      toast.add({ title: "设置无效", description: "移动端长按倍速必须在 1 到 8 倍之间", type: "error" });
      return;
    }
    try {
      const nextState = await AppService.SetMobileLongPressRate(rate);
      syncBackendState(nextState);
    } catch (err) {
      toast.add({ title: "保存失败", description: errorMessage(err), type: "error" });
    }
  };

  const saveFullscreenHUDSettings = async () => {
    if (!state) return;
    const offsetPX = Number.parseInt(fullscreenHUDSideOffsetInput, 10);
    if (!Number.isInteger(offsetPX) || offsetPX < 0 || offsetPX > 200) {
      toast.add({ title: "设置无效", description: "全屏信息左右偏移必须在 0 到 200 px 之间", type: "error" });
      return;
    }
    try {
      const nextState = await AppService.SetFullscreenHUDSettings(state.fullscreenHudEnabled, offsetPX);
      syncBackendState(nextState);
    } catch (err) {
      toast.add({ title: "保存失败", description: errorMessage(err), type: "error" });
    }
  };

  const clearPlaybackProgress = async () => {
    try {
      setPlaybackProgressStats(await AppService.ClearPlaybackProgress());
    } catch (err) {
      toast.add({ title: "清空失败", description: errorMessage(err), type: "error" });
    }
  };

  const openStorageDirectory = async () => {
    try {
      await AppService.OpenStorageDirectory();
    } catch (err) {
      toast.add({ title: "打开目录失败", description: errorMessage(err), type: "error" });
    }
  };

  useEffect(() => {
    if (!isAndroid) return;

    const backWindow = window as Window & {
      __drivePlayerHandleBack?: () => boolean;
      __drivePlayerExitFullscreen?: () => boolean;
    };
    backWindow.__drivePlayerHandleBack = () => {
      if (showLogoutConfirm) {
        setShowLogoutConfirm(false);
        return true;
      }
      if (videoDialogOpen && backWindow.__drivePlayerExitFullscreen?.()) return true;
      if (videoDialogOpen) {
        closeVideo();
        return true;
      }
      if (loginProvider) {
        setLoginProvider(null);
        return true;
      }
      if (showSettings) {
        closeSettings();
        return true;
      }
      if (currentPathRef.current !== "/") {
        goParentDirectory();
        return true;
      }
      return false;
    };

    return () => {
      delete backWindow.__drivePlayerHandleBack;
    };
  }, [closeSettings, goParentDirectory, isAndroid, loginProvider, showLogoutConfirm, showSettings, videoDialogOpen]);

  const pathParts = useMemo(() => breadcrumbs(currentPath), [currentPath]);
  const visibleEntries = useMemo(
    () => entries.filter((entry) => entry.isDirectory || isVideo(entry)),
    [entries],
  );
  const directoryVideos = useMemo(() => entries.filter(isVideo), [entries]);

  if (restoringSession || !state) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoaderCircle className="size-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!state.connected) {
    return (
      <LoginView
        state={state}
        onLogin123={login123}
        onLoginQuark={loginQuark}
        initialError={error}
      />
    );
  }

  const directoryCacheSettingsChanged =
    Number.parseInt(directoryCacheTTLInput, 10) !== directoryCacheSettings.ttlMinutes ||
    Number.parseInt(directoryCacheMaxSizeInput, 10) !== directoryCacheSettings.maxSizeMB;
  const webdavCacheSettingsChanged =
    Number.parseInt(webdavCacheTTLInput, 10) !== state.webdavCacheTTLMinutes;
  const quarkDownloadCacheSettingsChanged =
    Number.parseInt(quarkDownloadCacheTTLInput, 10) !== state.quarkDownloadCacheTTLMinutes;
  const quarkIDCacheSettingsChanged =
    Number.parseInt(quarkIDCacheTTLInput, 10) !== state.quarkIDCacheTTLMinutes;
  const videoMetadataSettingsChanged =
    Number.parseInt(videoMetadataMaxAgeInput, 10) !== state.videoMetadataMaxAgeDays ||
    Number.parseInt(videoMetadataMaxSizeInput, 10) !== state.videoMetadataMaxSizeMB ||
    Number.parseInt(videoMetadataThumbnailOffsetPercentInput, 10) !== state.videoMetadataThumbnailOffsetPercent;
  const videoSnapshotSettingsChanged =
    Number.parseInt(videoSnapshotMaxAgeInput, 10) !== state.videoSnapshotMaxAgeDays ||
    Number.parseInt(videoSnapshotMaxSizeInput, 10) !== state.videoSnapshotMaxSizeMB;
  const playbackProgressSettingsChanged =
    Number.parseInt(playbackMaxAgeInput, 10) !== state.playbackMaxAgeDays ||
    Number.parseInt(playbackMaxSizeInput, 10) !== state.playbackMaxSizeMB;
  const mobileLongPressRateChanged =
    Number.parseFloat(mobileLongPressRateInput) !== state.mobileLongPressRate;
  const fullscreenHUDSettingsChanged =
    Number.parseInt(fullscreenHUDSideOffsetInput, 10) !== state.fullscreenHudSideOffsetPx;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HardDrive className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate font-semibold">Drive Player</div>
            <div className="truncate text-xs text-muted-foreground">
              {state.provider === "quark" ? "夸克网盘 · Cookie 登录" : `123 云盘 · ${state.username}`}
            </div>
          </div>
        </div>
        <div className="grid w-full grid-cols-4 items-center gap-2 sm:flex sm:w-auto">
          <Tabs
            className="col-span-2 gap-0 sm:w-auto"
            value={state.provider}
            onValueChange={(provider) => {
              if (provider === "123" || provider === "quark") {
                void switchProvider(provider);
              }
            }}
          >
            <TabsList className="grid w-full grid-cols-2 sm:w-auto" aria-label="网盘切换">
              <TabsTrigger className="min-w-0 px-2 text-xs sm:px-2.5 sm:text-sm" value="123">
                {state.connected123 ? "123 云盘" : "登录 123"}
              </TabsTrigger>
              <TabsTrigger className="min-w-0 px-2 text-xs sm:px-2.5 sm:text-sm" value="quark">
                {state.connectedQuark ? "夸克网盘" : "登录夸克"}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            className="min-w-0 px-2 text-xs sm:px-2.5 sm:text-sm"
            variant="outline"
            size="sm"
            onClick={() => {
              setShowSettings(true);
              void refreshProviderCaches();
              refreshProviderBrowseStats();
              void refreshVideoMetadataStats();
              void refreshVideoSnapshotStats();
              void refreshPlaybackProgressStats();
              void refreshQuarkIDCacheStats();
            }}
          >
            <Settings />
            设置
          </Button>
          <Button
            className="min-w-0 px-2 text-xs sm:px-2.5 sm:text-sm"
            variant="outline"
            size="sm"
            onClick={() => setShowLogoutConfirm(true)}
          >
            <LogOut />
            退出当前
          </Button>
        </div>
      </header>

      <Separator />

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 border-b px-3 py-3 sm:px-6">
                <div className="flex min-w-0 items-center gap-2">
                  {!isMobile && (
                    <>
                      <Button
                        variant="outline"
                        size="icon"
                        disabled={!canGoBack}
                        onClick={goBackDirectory}
                        aria-label="后退"
                      >
                        <ArrowLeft />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        disabled={!canGoForward}
                        onClick={goForwardDirectory}
                        aria-label="前进"
                      >
                        <ArrowRight />
                      </Button>
                    </>
                  )}
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => void loadDirectory(currentPath, true)}
                    aria-label="刷新目录"
                  >
                    <RefreshCw className={loading ? "animate-spin" : ""} />
                  </Button>
                  <Breadcrumb
                    ref={breadcrumbScrollRef}
                    className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain px-1"
                  >
                    <BreadcrumbList className="w-max min-w-full flex-nowrap whitespace-nowrap">
                      <BreadcrumbItem className="shrink-0">
                        {currentPath === "/" ? (
                          <BreadcrumbPage className="whitespace-nowrap">根目录</BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink
                            className="whitespace-nowrap"
                            render={<button type="button" />}
                            onClick={() => navigateDirectory("/")}
                          >
                            根目录
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                      {pathParts.map((part, index) => (
                        <Fragment key={part.path}>
                          <BreadcrumbSeparator className="shrink-0" />
                          <BreadcrumbItem className="shrink-0">
                            {index === pathParts.length - 1 ? (
                              <BreadcrumbPage className="whitespace-nowrap">{part.name}</BreadcrumbPage>
                            ) : (
                              <BreadcrumbLink
                                className="whitespace-nowrap"
                                render={<button type="button" />}
                                onClick={() => navigateDirectory(part.path)}
                              >
                                {part.name}
                              </BreadcrumbLink>
                            )}
                          </BreadcrumbItem>
                        </Fragment>
                      ))}
                    </BreadcrumbList>
                  </Breadcrumb>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col">
                {!isMobile && (
                  <Table className="table-fixed">
                    <colgroup>
                      <col />
                      <col className="w-72" />
                      <col className="w-48" />
                    </colgroup>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="px-3 sm:px-4">名称</TableHead>
                        <TableHead className="px-3 sm:px-4">大小</TableHead>
                        <TableHead className="px-3 sm:px-4">修改时间</TableHead>
                      </TableRow>
                    </TableHeader>
                  </Table>
                )}
                <ScrollArea viewportRef={directoryScrollViewportRef} className="min-h-0 flex-1">
                  <Table className="table-fixed">
                    <colgroup>
                      <col />
                      {!isMobile && <col className="w-72" />}
                      {!isMobile && <col className="w-48" />}
                    </colgroup>
                    <TableBody>
                      {loading ? (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={isMobile ? 1 : 3} className="h-40 text-center text-muted-foreground">
                            <LoaderCircle className="mx-auto size-5 animate-spin" />
                          </TableCell>
                        </TableRow>
                      ) : visibleEntries.length === 0 ? (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={isMobile ? 1 : 3} className="h-40 text-center text-muted-foreground">
                            当前目录为空
                          </TableCell>
                        </TableRow>
                      ) : (
                        visibleEntries.map((entry) => {
                          const mediaMetadata = videoMetadataByPath[entry.path];
                          const thumbnailDataURL = thumbnailImages[entry.path];
                          const thumbnailResultReady = Boolean(
                            thumbnailDataURL && hasCompleteVideoMediaMetadata(mediaMetadata),
                          );
                          const refreshingMetadata = !entry.isDirectory && refreshingVideoMetadataPaths.has(entry.path);
                          const row = (
                            <TableRow
                              className="cursor-pointer active:bg-muted/70 data-pressed:bg-muted/70"
                              onClick={() => {
                                if (openContextMenuPath.current === entry.path) return;
                                void openEntry(entry);
                              }}
                            >
                              <TableCell className="px-3 py-2 sm:px-4">
                                <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                                  <div className="relative flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted sm:h-14 sm:w-24">
                                    {entry.isDirectory ? (
                                      <Folder className="size-8" />
                                    ) : thumbnailResultReady ? (
                                      <img
                                        src={thumbnailDataURL}
                                        alt=""
                                        className="h-full w-full object-cover"
                                      />
                                    ) : (
                                      <Play className="size-4" />
                                    )}
                                    {refreshingMetadata && (
                                      <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                                        <LoaderCircle className="size-5 animate-spin" />
                                      </div>
                                    )}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate font-medium">{entry.name}</div>
                                    {isMobile && (
                                      <div className="mt-1 flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
                                        {entry.isDirectory ? (
                                          <span className="min-w-0 truncate">文件夹</span>
                                        ) : (
                                          <span className="inline-flex min-w-0 max-w-full items-center gap-2.5">
                                            <span className="shrink-0">{formatSize(entry.size)}</span>
                                            {thumbnailResultReady && (
                                              <span className="truncate">{formatVideoMediaMetadata(mediaMetadata)}</span>
                                            )}
                                          </span>
                                        )}
                                        <span className="shrink-0">{formatDate(entry.modifiedAt)}</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </TableCell>
                              {!isMobile && (
                                <TableCell className="px-3 py-2 text-muted-foreground sm:px-4">
                                  {entry.isDirectory ? (
                                    "—"
                                  ) : (
                                    <span className="inline-flex items-center gap-2.5">
                                      <span>{formatSize(entry.size)}</span>
                                      {thumbnailResultReady && (
                                        <span>{formatVideoMediaMetadata(mediaMetadata)}</span>
                                      )}
                                    </span>
                                  )}
                                </TableCell>
                              )}
                              {!isMobile && (
                                <TableCell className="px-3 py-2 text-muted-foreground sm:px-4">{formatDate(entry.modifiedAt)}</TableCell>
                              )}
                            </TableRow>
                          );
                          if (!isVideo(entry)) {
                            return <Fragment key={entry.path}>{row}</Fragment>;
                          }
                          return (
                            <ContextMenu
                              key={entry.path}
                              onOpenChange={(open) => {
                                if (open) {
                                  openContextMenuPath.current = entry.path;
                                } else if (openContextMenuPath.current === entry.path) {
                                  openContextMenuPath.current = "";
                                }
                              }}
                            >
                              <ContextMenuTrigger render={row} />
                              <ContextMenuContent>
                                <ContextMenuItem
                                  disabled={refreshingMetadata}
                                  onClick={() => void refreshVideoMetadata(entry)}
                                >
                                  <RefreshCw />
                                  重新获取元信息
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </div>
        </div>
      </main>

      <AlertDialog open={showLogoutConfirm} onOpenChange={setShowLogoutConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              退出{state.provider === "quark" ? "夸克网盘" : "123 云盘"}？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将退出当前账号并清除该网盘的本次浏览状态。另一个已登录网盘不会受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowLogoutConfirm(false);
                void logout();
              }}
            >
              退出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={showSettings}
        onOpenChange={(open) => {
          if (!open) closeSettings();
        }}
      >
        <DialogContent
          overlayClassName="bg-transparent supports-backdrop-filter:backdrop-blur-none sm:bg-black/10 sm:supports-backdrop-filter:backdrop-blur-xs"
          className="settings-dialog-content flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[90vh] sm:w-[92vw] sm:max-w-4xl sm:rounded-xl"
        >
          <DialogHeader className="shrink-0 border-b px-4 py-4 sm:px-6">
            <DialogTitle className="pr-8">设置</DialogTitle>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto grid w-full max-w-3xl gap-3 p-3 sm:gap-4 sm:p-6">
              <Card>
                <CardHeader>
                  <CardTitle>浏览缓存规则</CardTitle>
                  <CardDescription>
                    123 和夸克各自独立保存文件列表、滚动位置和前进 / 后退历史；以下限制同时应用于两个网盘。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="directory-cache-ttl">文件列表缓存时间（分钟）</Label>
                      <Input
                        id="directory-cache-ttl"
                        type="number"
                        min={1}
                        max={1440}
                        value={directoryCacheTTLInput}
                        onChange={(event) => setDirectoryCacheTTLInput(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="directory-cache-max-size">每个网盘大小上限（MB）</Label>
                      <Input
                        id="directory-cache-max-size"
                        type="number"
                        min={1}
                        max={1024}
                        value={directoryCacheMaxSizeInput}
                        onChange={(event) => setDirectoryCacheMaxSizeInput(event.target.value)}
                      />
                    </div>
                  </div>
                  <Button
                    onClick={() => void saveDirectoryCacheSettings()}
                    disabled={!directoryCacheSettingsChanged}
                  >
                    保存
                  </Button>
                  <Separator />
                  <div className="flex flex-wrap gap-2 text-sm">
                    <Badge variant="outline">
                      滚动位置：每个网盘最多 {DIRECTORY_SCROLL_POSITION_CACHE_LIMIT} 个目录
                    </Badge>
                    <Badge variant="outline">
                      后退 / 前进：每个方向每个网盘最多 {DIRECTORY_HISTORY_LIMIT} 条
                    </Badge>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:gap-4">
                    <div className="space-y-1.5">
                      <CardTitle>123 云盘</CardTitle>
                      <CardDescription>123 的浏览状态、WebDAV 连接与 GET 302 Location 缓存。</CardDescription>
                    </div>
                    <Badge variant={state.connected123 ? "secondary" : "outline"}>
                      {state.connected123 ? "已登录" : "未登录"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-3">
                    <div className="font-medium">浏览状态</div>
                    <div className="grid gap-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground">文件列表</span>
                          <Badge variant="outline">
                            {providerBrowseStats["123"].directoryCache.totalBytes === 0
                              ? "0 B"
                              : formatSize(providerBrowseStats["123"].directoryCache.totalBytes)} / {directoryCacheSettings.maxSizeMB} MB
                          </Badge>
                          <Badge variant="outline">{providerBrowseStats["123"].directoryCache.count} 个目录</Badge>
                          <Badge variant="outline">{providerBrowseStats["123"].directoryCache.totalEntries} 个条目</Badge>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => clearDirectoryCache("123")}
                          disabled={providerBrowseStats["123"].directoryCache.count === 0}
                        >
                          <Trash2 />
                          清空列表缓存
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">
                          滚动位置 {providerBrowseStats["123"].scrollPositions} / {DIRECTORY_SCROLL_POSITION_CACHE_LIMIT}
                        </Badge>
                        <Badge variant="outline">
                          后退 {providerBrowseStats["123"].backHistory} / {DIRECTORY_HISTORY_LIMIT}
                        </Badge>
                        <Badge variant="outline">
                          前进 {providerBrowseStats["123"].forwardHistory} / {DIRECTORY_HISTORY_LIMIT}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <Separator />
                  <div className="grid gap-4 text-sm sm:grid-cols-2">
                    <div className="grid gap-1">
                      <span className="text-muted-foreground">WebDAV</span>
                      <code className="break-all rounded bg-muted px-2 py-1">{state.endpoint}</code>
                    </div>
                    <div className="grid gap-1">
                      <span className="text-muted-foreground">本地代理</span>
                      <code className="break-all rounded bg-muted px-2 py-1">{state.webdavProxyBaseUrl}</code>
                    </div>
                  </div>
                  <div className="grid max-w-sm gap-2">
                    <Label htmlFor="webdav-cache-ttl">URL 缓存时间（分钟）</Label>
                    <Input
                      id="webdav-cache-ttl"
                      type="number"
                      min={1}
                      max={1440}
                      value={webdavCacheTTLInput}
                      onChange={(event) => setWebDAVCacheTTLInput(event.target.value)}
                    />
                  </div>
                  <Button onClick={() => void saveWebDAVCacheTTL()} disabled={!webdavCacheSettingsChanged}>
                    保存
                  </Button>
                  <Separator />
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">302 URL 缓存</span>
                      <Badge variant="outline">{webdavCacheCount} 条</Badge>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void clearProviderCache("123")}
                      disabled={webdavCacheCount === 0}
                    >
                      <Trash2 />
                      清空缓存
                    </Button>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    GET：缓存并复用 302 Location；其他 WebDAV 方法直接透传。
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:gap-4">
                    <div className="space-y-1.5">
                      <CardTitle>夸克网盘</CardTitle>
                      <CardDescription>夸克的浏览状态、下载 URL / Cookie、文件大小以及路径 FID 缓存。</CardDescription>
                    </div>
                    <Badge variant={state.connectedQuark ? "secondary" : "outline"}>
                      {state.connectedQuark ? "已登录" : "未登录"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-3">
                    <div className="font-medium">浏览状态</div>
                    <div className="grid gap-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground">文件列表</span>
                          <Badge variant="outline">
                            {providerBrowseStats.quark.directoryCache.totalBytes === 0
                              ? "0 B"
                              : formatSize(providerBrowseStats.quark.directoryCache.totalBytes)} / {directoryCacheSettings.maxSizeMB} MB
                          </Badge>
                          <Badge variant="outline">{providerBrowseStats.quark.directoryCache.count} 个目录</Badge>
                          <Badge variant="outline">{providerBrowseStats.quark.directoryCache.totalEntries} 个条目</Badge>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => clearDirectoryCache("quark")}
                          disabled={providerBrowseStats.quark.directoryCache.count === 0}
                        >
                          <Trash2 />
                          清空列表缓存
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">
                          滚动位置 {providerBrowseStats.quark.scrollPositions} / {DIRECTORY_SCROLL_POSITION_CACHE_LIMIT}
                        </Badge>
                        <Badge variant="outline">
                          后退 {providerBrowseStats.quark.backHistory} / {DIRECTORY_HISTORY_LIMIT}
                        </Badge>
                        <Badge variant="outline">
                          前进 {providerBrowseStats.quark.forwardHistory} / {DIRECTORY_HISTORY_LIMIT}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <Separator />
                  <div className="grid gap-4 text-sm sm:grid-cols-2">
                    <div className="grid gap-1">
                      <span className="text-muted-foreground">夸克 API</span>
                      <code className="break-all rounded bg-muted px-2 py-1">{state.quarkEndpoint}</code>
                    </div>
                    <div className="grid gap-1">
                      <span className="text-muted-foreground">本地代理</span>
                      <code className="break-all rounded bg-muted px-2 py-1">{state.quarkProxyBaseUrl}</code>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <div className="font-medium">下载 URL 缓存</div>
                      <div className="text-sm text-muted-foreground">
                        缓存路径对应的临时下载 URL、本次下载 Cookie 和文件大小；失效后自动重新获取。
                      </div>
                    </div>
                    <div className="grid max-w-sm gap-2">
                      <Label htmlFor="quark-download-cache-ttl">缓存时间（分钟）</Label>
                      <Input
                        id="quark-download-cache-ttl"
                        type="number"
                        min={1}
                        max={1440}
                        value={quarkDownloadCacheTTLInput}
                        onChange={(event) => setQuarkDownloadCacheTTLInput(event.target.value)}
                      />
                    </div>
                    <Button onClick={() => void saveQuarkDownloadCacheTTL()} disabled={!quarkDownloadCacheSettingsChanged}>
                      保存
                    </Button>
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <Badge variant="outline">{quarkDownloadCacheCount} 条</Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void clearProviderCache("quark")}
                        disabled={quarkDownloadCacheCount === 0}
                      >
                        <Trash2 />
                        清空下载 URL 缓存
                      </Button>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <div>
                      <div className="font-medium">路径 ID 缓存</div>
                      <div className="text-sm text-muted-foreground">
                        后端内存缓存路径到 FID 的映射，避免每次访问都从根目录逐级解析。
                      </div>
                    </div>
                    <div className="grid max-w-sm gap-2">
                      <Label htmlFor="quark-id-cache-ttl">缓存时间（分钟）</Label>
                      <Input
                        id="quark-id-cache-ttl"
                        type="number"
                        min={1}
                        max={1440}
                        value={quarkIDCacheTTLInput}
                        onChange={(event) => setQuarkIDCacheTTLInput(event.target.value)}
                      />
                    </div>
                    <Button onClick={() => void saveQuarkIDCacheTTL()} disabled={!quarkIDCacheSettingsChanged}>
                      保存
                    </Button>
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <Badge variant="outline">{quarkIDCacheStats.count} 条</Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void clearQuarkIDCache()}
                        disabled={quarkIDCacheStats.count === 0}
                      >
                        <Trash2 />
                        清空路径 ID 缓存
                      </Button>
                    </div>
                  </div>

                  <div className="text-sm text-muted-foreground">
                    GET：请求长度 ≤300 MiB 时单次访问上游；更大时拆成多个 ≤300 MiB Range 顺序拼流。
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>视频元信息</CardTitle>
                  <CardDescription>
                    为当前打开目录的视频生成并缓存缩略图、分辨率和帧率；三项完整后一次性展示，并按最近使用时间自动淘汰。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="grid gap-2">
                      <Label htmlFor="video-metadata-max-age">最长保留时间（天）</Label>
                      <Input
                        id="video-metadata-max-age"
                        type="number"
                        min={1}
                        max={3650}
                        value={videoMetadataMaxAgeInput}
                        onChange={(event) => setVideoMetadataMaxAgeInput(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="video-metadata-max-size">总大小上限（MB）</Label>
                      <Input
                        id="video-metadata-max-size"
                        type="number"
                        min={16}
                        max={10240}
                        value={videoMetadataMaxSizeInput}
                        onChange={(event) => setVideoMetadataMaxSizeInput(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="video-metadata-thumbnail-offset">缩略图截帧位置（%）</Label>
                      <Input
                        id="video-metadata-thumbnail-offset"
                        type="number"
                        min={0}
                        max={100}
                        value={videoMetadataThumbnailOffsetPercentInput}
                        onChange={(event) => setVideoMetadataThumbnailOffsetPercentInput(event.target.value)}
                      />
                    </div>
                  </div>
                  <Button
                    onClick={() => void saveVideoMetadataSettings()}
                    disabled={!videoMetadataSettingsChanged}
                  >
                    保存
                  </Button>
                  <Separator />
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">空间占用</span>
                      <Badge variant="outline">
                        {videoMetadataStats.totalBytes === 0 ? "0 B" : formatSize(videoMetadataStats.totalBytes)} / {state.videoMetadataMaxSizeMB} MB
                      </Badge>
                      <Badge variant="outline">{videoMetadataStats.count} 项</Badge>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void clearVideoMetadataCache()}
                      disabled={videoMetadataStats.count === 0}
                    >
                      <Trash2 />
                      清空视频元信息缓存
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>视频时间点截图</CardTitle>
                  <CardDescription>
                    播放器始终提供时间点截图侧栏，可手动提取最多 10 张原始分辨率 PNG 截图。截图按视频时长等分，点击截图可直接跳转到对应时间点。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="video-snapshot-max-age">最长保留时间（天）</Label>
                      <Input
                        id="video-snapshot-max-age"
                        type="number"
                        min={1}
                        max={3650}
                        value={videoSnapshotMaxAgeInput}
                        onChange={(event) => setVideoSnapshotMaxAgeInput(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="video-snapshot-max-size">总大小上限（MB）</Label>
                      <Input
                        id="video-snapshot-max-size"
                        type="number"
                        min={64}
                        max={10240}
                        value={videoSnapshotMaxSizeInput}
                        onChange={(event) => setVideoSnapshotMaxSizeInput(event.target.value)}
                      />
                    </div>
                  </div>
                  <Button
                    onClick={() => void saveVideoSnapshotSettings()}
                    disabled={!videoSnapshotSettingsChanged}
                  >
                    保存
                  </Button>
                  <Separator />
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">空间占用</span>
                      <Badge variant="outline">
                        {videoSnapshotStats.totalBytes === 0 ? "0 B" : formatSize(videoSnapshotStats.totalBytes)} / {state.videoSnapshotMaxSizeMB} MB
                      </Badge>
                      <Badge variant="outline">{videoSnapshotStats.count} 张</Badge>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void clearVideoSnapshotCache()}
                      disabled={videoSnapshotStats.count === 0}
                    >
                      <Trash2 />
                      清空视频截图
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>播放进度</CardTitle>
                  <CardDescription>
                    按账号和视频路径持久化播放断点。播放中定期保存，暂停或关闭播放器时立即保存；接近播放完成时自动删除断点，下次从头播放。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="playback-max-age">最长保留时间（天）</Label>
                      <Input
                        id="playback-max-age"
                        type="number"
                        min={1}
                        max={3650}
                        value={playbackMaxAgeInput}
                        onChange={(event) => setPlaybackMaxAgeInput(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="playback-max-size">总大小上限（MB）</Label>
                      <Input
                        id="playback-max-size"
                        type="number"
                        min={1}
                        max={1024}
                        value={playbackMaxSizeInput}
                        onChange={(event) => setPlaybackMaxSizeInput(event.target.value)}
                      />
                    </div>
                  </div>
                  <Button
                    onClick={() => void savePlaybackProgressSettings()}
                    disabled={!playbackProgressSettingsChanged}
                  >
                    保存
                  </Button>
                  <Separator />
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">空间占用</span>
                      <Badge variant="outline">
                        {playbackProgressStats.totalBytes === 0 ? "0 B" : formatSize(playbackProgressStats.totalBytes)} / {state.playbackMaxSizeMB} MB
                      </Badge>
                      <Badge variant="outline">{playbackProgressStats.count} 个视频</Badge>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void clearPlaybackProgress()}
                      disabled={playbackProgressStats.count === 0}
                    >
                      <Trash2 />
                      清空播放进度
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>移动端长按倍速</CardTitle>
                  <CardDescription>
                    在视频画面的非控件区域长按约 0.5 秒后临时切换到设定倍速，松手立即恢复长按前的播放速度。仅移动端生效。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid max-w-xs gap-2">
                    <Label htmlFor="mobile-long-press-rate">长按倍速</Label>
                    <Input
                      id="mobile-long-press-rate"
                      type="number"
                      min={1}
                      max={8}
                      step={0.25}
                      value={mobileLongPressRateInput}
                      onChange={(event) => setMobileLongPressRateInput(event.target.value)}
                    />
                  </div>
                  <Button
                    onClick={() => void saveMobileLongPressRate()}
                    disabled={!mobileLongPressRateChanged}
                  >
                    保存
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>全屏顶部信息</CardTitle>
                  <CardDescription>
                    进入全屏后，左上角用一个标签显示时间和电量百分比，右上角显示当前播放进度。标签始终贴着顶部，左右偏移只调整距屏幕两侧的距离。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex w-full items-center justify-between gap-4">
                    <Label htmlFor="fullscreen-hud-enabled">显示顶部信息</Label>
                    <Switch
                      id="fullscreen-hud-enabled"
                      checked={fullscreenHUDEnabledInput}
                      className="data-disabled:cursor-default"
                      disabled={fullscreenHUDToggleSaving}
                      onCheckedChange={(checked) => void setFullscreenHUDEnabled(checked)}
                    />
                  </div>
                  <Separator />
                  <div className="grid max-w-xs gap-2">
                    <Label htmlFor="fullscreen-hud-side-offset">左右偏移（px）</Label>
                    <Input
                      id="fullscreen-hud-side-offset"
                      type="number"
                      min={0}
                      max={200}
                      value={fullscreenHUDSideOffsetInput}
                      onChange={(event) => setFullscreenHUDSideOffsetInput(event.target.value)}
                    />
                  </div>
                  <Button
                    onClick={() => void saveFullscreenHUDSettings()}
                    disabled={!fullscreenHUDSettingsChanged}
                  >
                    保存
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:gap-4">
                    <div className="space-y-1.5">
                      <CardTitle>本地存储</CardTitle>
                      <CardDescription>应用配置、视频元信息、视频时间点截图和播放进度都保存在这个应用数据目录下。</CardDescription>
                    </div>
                    {!isMobile && (
                      <Button variant="outline" size="sm" onClick={() => void openStorageDirectory()}>
                        <FolderOpen />
                        打开目录
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="grid gap-4 text-sm">
                  <div className="grid gap-1">
                    <span className="text-muted-foreground">本地数据目录</span>
                    <code className="break-all rounded bg-muted px-2 py-1">{state.storageDirectory}</code>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-muted-foreground">配置文件</span>
                    <code className="break-all rounded bg-muted px-2 py-1">{state.configPath}</code>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-muted-foreground">视频元信息目录</span>
                    <code className="break-all rounded bg-muted px-2 py-1">{state.videoMetadataDirectory}</code>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-muted-foreground">视频截图目录</span>
                    <code className="break-all rounded bg-muted px-2 py-1">{state.videoSnapshotDirectory}</code>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-muted-foreground">播放进度文件</span>
                    <code className="break-all rounded bg-muted px-2 py-1">{state.playbackProgressPath}</code>
                  </div>
                </CardContent>
              </Card>

            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {loginProvider && (
        <AccountLoginDialog
          provider={loginProvider}
          state={state}
          onClose={() => setLoginProvider(null)}
          onLogin123={login123}
          onLoginQuark={loginQuark}
        />
      )}

      <Dialog
        open={videoDialogOpen}
        onOpenChange={(open, eventDetails) => {
          if (
            !open &&
            (eventDetails.reason === "escape-key" || eventDetails.reason === "outside-press")
          ) {
            eventDetails.cancel();
            return;
          }
          if (!open) closeVideo();
        }}
      >
        <DialogContent
          overlayClassName={isMobile
            ? "video-dialog-overlay--mobile"
            : undefined}
          className={isAndroid
            ? "video-dialog-content video-dialog-content--mobile flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-none"
            : `video-dialog-content${isMobile ? " video-dialog-content--mobile" : ""} flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[90vh] sm:w-[95vw] sm:max-w-[95vw] sm:rounded-xl`}
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget || videoDialogOpen) return;
            setActiveVideo(null);
            if (!loading && entries.length > 0) {
              startThumbnailLoading(entries, directoryRequestId.current);
            }
          }}
        >
          <DialogHeader className="border-b px-3 py-3 sm:px-5 sm:py-4">
            <DialogTitle className="truncate pr-8">{activeVideo?.name ?? "视频播放"}</DialogTitle>
            <DialogDescription className="truncate font-mono text-xs">
              {activeVideo?.path}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 bg-black">
            {activeVideo && (
              <VideoPlayer
                src={activeVideo.url}
                remotePath={activeVideo.path}
                modifiedAt={activeVideo.modifiedAt}
                initialPosition={activeVideo.resumePosition}
                isAndroid={isAndroid}
                isMobile={isMobile}
                mobileLongPressRate={state.mobileLongPressRate}
                fullscreenHUDEnabled={state.fullscreenHudEnabled}
                fullscreenHUDSideOffsetPX={state.fullscreenHudSideOffsetPx}
                directoryVideos={directoryVideos}
                onSelectVideo={activateVideoEntry}
                onPersistProgress={persistPlaybackProgress}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Toaster />
    </div>
  );
}

export default App;
