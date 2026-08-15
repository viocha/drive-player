import { FormEvent, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "@videojs/react/video/skin.css";
import { createPlayer, videoFeatures } from "@videojs/react";
import { Video, VideoSkin } from "@videojs/react/video";
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
  RotateCcw,
  Settings,
  Trash2,
} from "lucide-react";
import { AppService } from "../bindings/drive-player";
import type {
  AppState,
  FileEntry,
  PlaybackProgressStats,
  ThumbnailCacheStats,
} from "../bindings/drive-player";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const Player = createPlayer({ features: videoFeatures });

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
const THUMBNAIL_CONCURRENCY = 2;
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

type DirectoryCacheItem = {
  entries: FileEntry[];
  cachedAt: number;
  lastAccess: number;
  sizeBytes: number;
};

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

function VideoPlayer({
  src,
  initialPosition,
  onPersistProgress,
}: {
  src: string;
  initialPosition: number;
  onPersistProgress: (position: number, duration: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const miniProgressRef = useRef<HTMLDivElement | null>(null);
  const lastPersistedAt = useRef(0);
  const endedRef = useRef(false);

  const persistProgress = useCallback((video: HTMLVideoElement) => {
    const position = video.currentTime;
    const duration = video.duration;
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
    lastPersistedAt.current = Date.now();
    onPersistProgress(position, duration);
  }, [onPersistProgress]);

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

  return (
    <div className="video-player-frame">
      <Player.Provider>
        <VideoSkin>
          <Video
            ref={videoRef}
            src={src}
            playsInline
            autoPlay
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (initialPosition > 0 && initialPosition <= video.duration) {
                video.currentTime = Math.min(initialPosition, Math.max(0, video.duration - 0.1));
              }
            }}
            onTimeUpdate={(event) => {
              if (Date.now() - lastPersistedAt.current >= 3_000) {
                persistProgress(event.currentTarget);
              }
            }}
            onSeeked={(event) => {
              persistProgress(event.currentTarget);
            }}
            onEnded={(event) => {
              const video = event.currentTarget;
              endedRef.current = true;
              if (Number.isFinite(video.duration) && video.duration > 0) {
                lastPersistedAt.current = Date.now();
                onPersistProgress(video.duration, video.duration);
              }
            }}
          />
          <div className="video-mini-progress" aria-hidden="true">
            <div ref={miniProgressRef} className="video-mini-progress__fill" />
          </div>
        </VideoSkin>
      </Player.Provider>
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

function captureVideoThumbnail(src: string, offsetSeconds: number, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const video = document.createElement("video");
    let settled = false;
    let timeout = 0;

    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      video.removeAttribute("src");
      video.load();
    };

    const finish = (error?: unknown, dataURL?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(dataURL ?? "");
    };

    const onAbort = () => finish(new DOMException("Thumbnail generation aborted", "AbortError"));

    const capture = () => {
      if (signal.aborted || settled) return;
      if (!video.videoWidth || !video.videoHeight) {
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
      finish(undefined, canvas.toDataURL("image/webp", 0.72));
    };

    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("error", () => finish(new Error("视频缩略图加载失败")), { once: true });
    video.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const target = duration > 0
        ? Math.min(Math.max(0, offsetSeconds), Math.max(0, duration - 0.25))
        : Math.max(0, offsetSeconds);
      if (target <= 0.05) {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) capture();
        else video.addEventListener("loadeddata", capture, { once: true });
        return;
      }
      video.addEventListener("seeked", capture, { once: true });
      video.currentTime = target;
    }, { once: true });

    signal.addEventListener("abort", onAbort, { once: true });
    timeout = window.setTimeout(() => finish(new Error("视频缩略图加载超时")), 30_000);
    video.src = src;
    video.load();
  });
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

function breadcrumbs(value: string) {
  const parts = normalizePath(value).split("/").filter(Boolean);
  return parts.map((name, index) => ({
    name,
    path: `/${parts.slice(0, index + 1).join("/")}`,
  }));
}

function LoginView({
  state,
  onLogin,
  initialError,
}: {
  state: AppState;
  onLogin: (username: string, password: string) => Promise<void>;
  initialError?: string;
}) {
  const [username, setUsername] = useState(state.username ?? "");
  const [password, setPassword] = useState(state.password ?? "");
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
      await onLogin(username, password);
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
            <CardTitle className="text-2xl">连接 123 云盘</CardTitle>
            <CardDescription>
              使用 123 云盘“第三方挂载”生成的 WebDAV 账号和应用密码登录。
            </CardDescription>
          </div>
        </CardHeader>
        <form onSubmit={submit} className="flex flex-col gap-(--card-spacing)">
          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <CircleAlert className="size-4" />
                <AlertTitle>登录失败</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
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
            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">WebDAV 地址</div>
              <div className="mt-1 break-all font-mono">{state.endpoint}</div>
            </div>
          </CardContent>
          <CardFooter>
            <Button className="w-full" type="submit" disabled={submitting || !username || !password}>
              {submitting && <LoaderCircle className="animate-spin" />}
              登录并浏览文件
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}

function App() {
  const [directoryCacheSettings, setDirectoryCacheSettings] = useState<DirectoryCacheSettings>(() =>
    loadDirectoryCacheSettings(),
  );
  const [state, setState] = useState<AppState | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [thumbnailImages, setThumbnailImages] = useState<Record<string, string>>({});
  const [thumbnailStats, setThumbnailStats] = useState<ThumbnailCacheStats>({ count: 0, totalBytes: 0 });
  const [playbackProgressStats, setPlaybackProgressStats] = useState<PlaybackProgressStats>({ count: 0, totalBytes: 0 });
  const [directoryCacheStats, setDirectoryCacheStats] = useState<DirectoryCacheStats>({
    count: 0,
    totalEntries: 0,
    totalBytes: 0,
  });
  const [directoryScrollPositionCount, setDirectoryScrollPositionCount] = useState(0);
  const [cacheCount, setCacheCount] = useState(0);
  const [currentPath, setCurrentPath] = useState("/");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeVideo, setActiveVideo] = useState<ActiveVideo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");
  const [ttlInput, setTtlInput] = useState("30");
  const [directoryCacheTTLInput, setDirectoryCacheTTLInput] = useState(String(directoryCacheSettings.ttlMinutes));
  const [directoryCacheMaxSizeInput, setDirectoryCacheMaxSizeInput] = useState(String(directoryCacheSettings.maxSizeMB));
  const [thumbnailMaxAgeInput, setThumbnailMaxAgeInput] = useState("30");
  const [thumbnailMaxSizeInput, setThumbnailMaxSizeInput] = useState("512");
  const [thumbnailOffsetInput, setThumbnailOffsetInput] = useState("5");
  const [playbackMaxAgeInput, setPlaybackMaxAgeInput] = useState("365");
  const [playbackMaxSizeInput, setPlaybackMaxSizeInput] = useState("16");
  const directoryRequestId = useRef(0);
  const directoryRequest = useRef<ReturnType<typeof AppService.ListDirectory> | null>(null);
  const directoryAbortController = useRef<AbortController | null>(null);
  const thumbnailAbortController = useRef<AbortController | null>(null);
  const directoryScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const directoryScrollPositions = useRef(new Map<string, number>());
  const pendingDirectoryScrollRestore = useRef<{ path: string; scrollTop: number } | null>(null);
  const currentPathRef = useRef("/");
  const directoryBackHistory = useRef<string[]>([]);
  const directoryForwardHistory = useRef<string[]>([]);
  const thumbnailReloadNeeded = useRef(false);
  const directoryCache = useRef(new Map<string, DirectoryCacheItem>());
  const directoryCacheSettingsRef = useRef(directoryCacheSettings);

  useEffect(() => {
    AppService.GetState()
      .then(async (nextState) => {
        setState(nextState);
        setTtlInput(String(nextState.cacheTTLMinutes));
        setThumbnailMaxAgeInput(String(nextState.thumbnailMaxAgeDays));
        setThumbnailMaxSizeInput(String(nextState.thumbnailMaxSizeMB));
        setThumbnailOffsetInput(String(nextState.thumbnailOffsetSeconds));
        setPlaybackMaxAgeInput(String(nextState.playbackMaxAgeDays));
        setPlaybackMaxSizeInput(String(nextState.playbackMaxSizeMB));

        if (!nextState.connected && nextState.username && nextState.password) {
          try {
            const restoredState = await AppService.Login(nextState.username, nextState.password);
            setState(restoredState);
            setTtlInput(String(restoredState.cacheTTLMinutes));
            setThumbnailMaxAgeInput(String(restoredState.thumbnailMaxAgeDays));
            setThumbnailMaxSizeInput(String(restoredState.thumbnailMaxSizeMB));
            setThumbnailOffsetInput(String(restoredState.thumbnailOffsetSeconds));
            setPlaybackMaxAgeInput(String(restoredState.playbackMaxAgeDays));
            setPlaybackMaxSizeInput(String(restoredState.playbackMaxSizeMB));
          } catch (err) {
            setError(`自动登录失败：${errorMessage(err)}`);
          }
        }
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setRestoringSession(false));
  }, []);

  useEffect(
    () => () => {
      directoryRequest.current?.cancel("component unmounted");
      directoryAbortController.current?.abort();
      thumbnailAbortController.current?.abort();
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

  const getCachedDirectory = useCallback((remotePath: string) => {
    const now = Date.now();
    const cache = directoryCache.current;
    const stats = pruneDirectoryCache(cache, directoryCacheSettingsRef.current, now);
    const item = cache.get(remotePath);
    if (!item) {
      setDirectoryCacheStats(stats);
      return null;
    }
    item.lastAccess = now;
    setDirectoryCacheStats(directoryCacheStatsFor(cache));
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
    setDirectoryCacheStats(
      pruneDirectoryCache(directoryCache.current, directoryCacheSettingsRef.current, now),
    );
  }, []);

  const clearDirectoryCacheMemory = useCallback(() => {
    directoryCache.current.clear();
    setDirectoryCacheStats({ count: 0, totalEntries: 0, totalBytes: 0 });
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
    setDirectoryScrollPositionCount(cache.size);
  }, []);

  const getDirectoryScrollPosition = useCallback((remotePath: string) => {
    const cache = directoryScrollPositions.current;
    const scrollTop = cache.get(remotePath);
    if (scrollTop === undefined) return 0;
    cache.delete(remotePath);
    cache.set(remotePath, scrollTop);
    return scrollTop;
  }, []);

  const clearDirectoryScrollPositions = useCallback(() => {
    directoryScrollPositions.current.clear();
    setDirectoryScrollPositionCount(0);
  }, []);

  const startThumbnailLoading = useCallback((sourceEntries: FileEntry[], requestId: number) => {
    thumbnailAbortController.current?.abort();
    const controller = new AbortController();
    thumbnailAbortController.current = controller;
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
            const cached = await AppService.GetThumbnail(entry.path, entry.modifiedAt);
            if (controller.signal.aborted || requestId !== directoryRequestId.current) return;
            if (cached.found && cached.dataUrl) {
              setThumbnailImages((current) => ({ ...current, [entry.path]: cached.dataUrl }));
              continue;
            }

            const playbackURL = await AppService.GetPlaybackURL(entry.path);
            if (controller.signal.aborted || requestId !== directoryRequestId.current) return;
            const dataURL = await captureVideoThumbnail(
              playbackURL,
              state?.thumbnailOffsetSeconds ?? 5,
              controller.signal,
            );
            if (controller.signal.aborted || requestId !== directoryRequestId.current) return;
            await AppService.SaveThumbnail(entry.path, entry.modifiedAt, dataURL);
            if (controller.signal.aborted || requestId !== directoryRequestId.current) return;
            setThumbnailImages((current) => ({ ...current, [entry.path]: dataURL }));
          } catch (err) {
            if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
            // A codec or seek failure for one video should not block the directory or other thumbnails.
          }
        }
      };

      const workerCount = Math.min(THUMBNAIL_CONCURRENCY, videos.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    })();
  }, [state?.thumbnailOffsetSeconds]);

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
    thumbnailAbortController.current?.abort();
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

  const resetDirectoryHistory = useCallback(() => {
    directoryBackHistory.current = [];
    directoryForwardHistory.current = [];
    syncDirectoryHistoryState();
  }, [syncDirectoryHistoryState]);

  const navigateDirectory = useCallback((targetPath: string) => {
    const normalized = normalizePath(targetPath);
    const current = currentPathRef.current;
    if (normalized === current) return;

    const back = directoryBackHistory.current;
    back.push(current);
    if (back.length > DIRECTORY_HISTORY_LIMIT) back.shift();
    directoryForwardHistory.current = [];
    syncDirectoryHistoryState();
    void loadDirectory(normalized);
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
    if (state?.connected) {
      void loadDirectory(currentPath);
    }
    // Only run when a session becomes connected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.connected]);

  const refreshCache = useCallback(async () => {
    try {
      setCacheCount(((await AppService.ListRedirectCache()) ?? []).length);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const refreshThumbnailStats = useCallback(async () => {
    try {
      setThumbnailStats(await AppService.GetThumbnailCacheStats());
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

  const login = async (username: string, password: string) => {
    const nextState = await AppService.Login(username, password);
    clearDirectoryCacheMemory();
    setState(nextState);
    setTtlInput(String(nextState.cacheTTLMinutes));
    setThumbnailMaxAgeInput(String(nextState.thumbnailMaxAgeDays));
    setThumbnailMaxSizeInput(String(nextState.thumbnailMaxSizeMB));
    setThumbnailOffsetInput(String(nextState.thumbnailOffsetSeconds));
    setPlaybackMaxAgeInput(String(nextState.playbackMaxAgeDays));
    setPlaybackMaxSizeInput(String(nextState.playbackMaxSizeMB));
    currentPathRef.current = "/";
    clearDirectoryScrollPositions();
    resetDirectoryHistory();
    setCurrentPath("/");
    setShowSettings(false);
  };

  const logout = async () => {
    directoryAbortController.current?.abort();
    thumbnailAbortController.current?.abort();
    const nextState = await AppService.Logout();
    setState(nextState);
    setEntries([]);
    currentPathRef.current = "/";
    clearDirectoryScrollPositions();
    resetDirectoryHistory();
    setThumbnailImages({});
    setThumbnailStats({ count: 0, totalBytes: 0 });
    setPlaybackProgressStats({ count: 0, totalBytes: 0 });
    clearDirectoryCacheMemory();
    setCacheCount(0);
    setActiveVideo(null);
    setError("");
  };

  const openEntry = async (entry: FileEntry) => {
    if (entry.isDirectory) {
      navigateDirectory(entry.path);
      return;
    }
    if (!isVideo(entry)) return;
    try {
      thumbnailAbortController.current?.abort();
      const [url, progress] = await Promise.all([
        AppService.GetPlaybackURL(entry.path),
        AppService.GetPlaybackProgress(entry.path).catch(() => null),
      ]);
      setActiveVideo({
        name: entry.name,
        path: entry.path,
        url,
        resumePosition: progress?.found ? progress.position : 0,
      });
      window.setTimeout(() => void refreshCache(), 600);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const closeVideo = () => {
    setActiveVideo(null);
    if (!loading && entries.length > 0) {
      startThumbnailLoading(entries, directoryRequestId.current);
    }
  };

  const persistPlaybackProgress = useCallback((remotePath: string, position: number, duration: number) => {
    void AppService.SavePlaybackProgress(remotePath, position, duration).catch(() => {
      // Progress persistence must never interrupt playback or closing the player.
    });
  }, []);

  const saveTTL = async () => {
    const minutes = Number.parseInt(ttlInput, 10);
    setSettingsMessage("");
    setError("");
    if (!Number.isFinite(minutes)) {
      setError("请输入有效的缓存分钟数");
      return;
    }
    try {
      const nextState = await AppService.SetCacheTTL(minutes);
      setState(nextState);
      setTtlInput(String(nextState.cacheTTLMinutes));
      setSettingsMessage("缓存时间已保存，并立即应用到现有缓存。 ");
      await refreshCache();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const clearCache = async () => {
    try {
      await AppService.ClearRedirectCache();
      setCacheCount(0);
      setSettingsMessage("URL 缓存已清空。 ");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const saveDirectoryCacheSettings = () => {
    const ttlMinutes = Number.parseInt(directoryCacheTTLInput, 10);
    const maxSizeMB = Number.parseInt(directoryCacheMaxSizeInput, 10);
    setSettingsMessage("");
    setError("");
    if (
      !Number.isInteger(ttlMinutes) ||
      ttlMinutes < MIN_DIRECTORY_CACHE_TTL_MINUTES ||
      ttlMinutes > MAX_DIRECTORY_CACHE_TTL_MINUTES
    ) {
      setError(`文件列表缓存时间必须在 ${MIN_DIRECTORY_CACHE_TTL_MINUTES} 到 ${MAX_DIRECTORY_CACHE_TTL_MINUTES} 分钟之间`);
      return;
    }
    if (
      !Number.isInteger(maxSizeMB) ||
      maxSizeMB < MIN_DIRECTORY_CACHE_MAX_SIZE_MB ||
      maxSizeMB > MAX_DIRECTORY_CACHE_MAX_SIZE_MB
    ) {
      setError(`文件列表缓存上限必须在 ${MIN_DIRECTORY_CACHE_MAX_SIZE_MB} 到 ${MAX_DIRECTORY_CACHE_MAX_SIZE_MB} MB 之间`);
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
    setDirectoryCacheStats(pruneDirectoryCache(directoryCache.current, nextSettings));
    setSettingsMessage("文件列表缓存设置已保存。 ");
  };

  const clearDirectoryCache = () => {
    clearDirectoryCacheMemory();
    setSettingsMessage("文件列表缓存已清空。 ");
  };

  const saveThumbnailSettings = async () => {
    const maxAgeDays = Number.parseInt(thumbnailMaxAgeInput, 10);
    const maxSizeMB = Number.parseInt(thumbnailMaxSizeInput, 10);
    const offsetSeconds = Number.parseInt(thumbnailOffsetInput, 10);
    setSettingsMessage("");
    setError("");
    if (![maxAgeDays, maxSizeMB, offsetSeconds].every(Number.isFinite)) {
      setError("请输入有效的缩略图缓存设置");
      return;
    }
    try {
      const previousOffset = state?.thumbnailOffsetSeconds;
      const nextState = await AppService.SetThumbnailSettings(maxAgeDays, maxSizeMB, offsetSeconds);
      setState(nextState);
      setThumbnailMaxAgeInput(String(nextState.thumbnailMaxAgeDays));
      setThumbnailMaxSizeInput(String(nextState.thumbnailMaxSizeMB));
      setThumbnailOffsetInput(String(nextState.thumbnailOffsetSeconds));
      if (previousOffset !== nextState.thumbnailOffsetSeconds) {
        setThumbnailImages({});
        thumbnailReloadNeeded.current = true;
      }
      setSettingsMessage("缩略图缓存设置已保存。 ");
      await refreshThumbnailStats();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const clearThumbnailCache = async () => {
    try {
      setThumbnailStats(await AppService.ClearThumbnailCache());
      setThumbnailImages({});
      thumbnailReloadNeeded.current = true;
      setSettingsMessage("缩略图缓存已清空。 ");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const savePlaybackProgressSettings = async () => {
    const maxAgeDays = Number.parseInt(playbackMaxAgeInput, 10);
    const maxSizeMB = Number.parseInt(playbackMaxSizeInput, 10);
    setSettingsMessage("");
    setError("");
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 3650) {
      setError("播放进度保留时间必须在 1 到 3650 天之间");
      return;
    }
    if (!Number.isInteger(maxSizeMB) || maxSizeMB < 1 || maxSizeMB > 1024) {
      setError("播放进度存储上限必须在 1 到 1024 MB 之间");
      return;
    }
    try {
      const nextState = await AppService.SetPlaybackProgressSettings(maxAgeDays, maxSizeMB);
      setState(nextState);
      setPlaybackMaxAgeInput(String(nextState.playbackMaxAgeDays));
      setPlaybackMaxSizeInput(String(nextState.playbackMaxSizeMB));
      setSettingsMessage("播放进度设置已保存。 ");
      await refreshPlaybackProgressStats();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const clearPlaybackProgress = async () => {
    try {
      setPlaybackProgressStats(await AppService.ClearPlaybackProgress());
      setSettingsMessage("播放进度已清空。 ");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const openStorageDirectory = async () => {
    try {
      await AppService.OpenStorageDirectory();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const pathParts = useMemo(() => breadcrumbs(currentPath), [currentPath]);
  const visibleEntries = useMemo(
    () => entries.filter((entry) => entry.isDirectory || isVideo(entry)),
    [entries],
  );

  if (restoringSession || !state) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoaderCircle className="size-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!state.connected) {
    return <LoginView state={state} onLogin={login} initialError={error} />;
  }

  const directoryCacheSettingsChanged =
    Number.parseInt(directoryCacheTTLInput, 10) !== directoryCacheSettings.ttlMinutes ||
    Number.parseInt(directoryCacheMaxSizeInput, 10) !== directoryCacheSettings.maxSizeMB;
  const urlCacheSettingsChanged = Number.parseInt(ttlInput, 10) !== state.cacheTTLMinutes;
  const thumbnailSettingsChanged =
    Number.parseInt(thumbnailMaxAgeInput, 10) !== state.thumbnailMaxAgeDays ||
    Number.parseInt(thumbnailMaxSizeInput, 10) !== state.thumbnailMaxSizeMB ||
    Number.parseInt(thumbnailOffsetInput, 10) !== state.thumbnailOffsetSeconds;
  const playbackProgressSettingsChanged =
    Number.parseInt(playbackMaxAgeInput, 10) !== state.playbackMaxAgeDays ||
    Number.parseInt(playbackMaxSizeInput, 10) !== state.playbackMaxSizeMB;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HardDrive className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate font-semibold">Drive Player</div>
            <div className="truncate text-xs text-muted-foreground">123 云盘 · {state.username}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showSettings ? "secondary" : "outline"}
            size="sm"
            onClick={() => {
              if (showSettings) {
                setShowSettings(false);
                if (thumbnailReloadNeeded.current) {
                  thumbnailReloadNeeded.current = false;
                  void loadDirectory(currentPath);
                }
                return;
              }
              setShowSettings(true);
              setSettingsMessage("");
              void refreshCache();
              setDirectoryCacheStats(
                pruneDirectoryCache(directoryCache.current, directoryCacheSettingsRef.current),
              );
              void refreshThumbnailStats();
              void refreshPlaybackProgressStats();
            }}
          >
            <Settings />
            设置
          </Button>
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            <LogOut />
            退出
          </Button>
        </div>
      </header>

      <Separator />

      <main className="min-h-0 flex-1 overflow-hidden p-4 md:p-6">
        {error && (
          <Alert variant="destructive" className="mb-4">
            <CircleAlert className="size-4" />
            <AlertTitle>请求失败</AlertTitle>
            <AlertDescription className="flex items-start justify-between gap-4">
              <span>{error}</span>
              <Button variant="ghost" size="sm" className="-my-1" onClick={() => setError("")}>
                关闭
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {!showSettings ? (
          <Card className="flex h-full min-h-0 flex-col gap-0 py-0">
              <CardHeader className="border-b py-3">
                <div className="flex min-w-0 items-center gap-2">
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
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => void loadDirectory(currentPath, true)}
                    aria-label="刷新目录"
                  >
                    <RefreshCw className={loading ? "animate-spin" : ""} />
                  </Button>
                  <Breadcrumb className="min-w-0 flex-1 overflow-hidden px-1">
                    <BreadcrumbList className="flex-nowrap overflow-hidden">
                      <BreadcrumbItem>
                        {currentPath === "/" ? (
                          <BreadcrumbPage>根目录</BreadcrumbPage>
                        ) : (
                          <button
                            type="button"
                            className="transition-colors hover:text-foreground"
                            onClick={() => navigateDirectory("/")}
                          >
                            根目录
                          </button>
                        )}
                      </BreadcrumbItem>
                      {pathParts.map((part, index) => (
                        <Fragment key={part.path}>
                          <BreadcrumbSeparator />
                          <BreadcrumbItem>
                            {index === pathParts.length - 1 ? (
                              <BreadcrumbPage>{part.name}</BreadcrumbPage>
                            ) : (
                              <button
                                type="button"
                                className="transition-colors hover:text-foreground"
                                onClick={() => navigateDirectory(part.path)}
                              >
                                {part.name}
                              </button>
                            )}
                          </BreadcrumbItem>
                        </Fragment>
                      ))}
                    </BreadcrumbList>
                  </Breadcrumb>
                </div>
              </CardHeader>

              <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                <Table className="table-fixed">
                  <colgroup>
                    <col />
                    <col className="w-32" />
                    <col className="w-48" />
                  </colgroup>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>名称</TableHead>
                      <TableHead>大小</TableHead>
                      <TableHead>修改时间</TableHead>
                    </TableRow>
                  </TableHeader>
                </Table>
                <ScrollArea viewportRef={directoryScrollViewportRef} className="min-h-0 flex-1">
                  <Table className="table-fixed">
                    <colgroup>
                      <col />
                      <col className="w-32" />
                      <col className="w-48" />
                    </colgroup>
                    <TableBody>
                      {loading ? (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={3} className="h-40 text-center text-muted-foreground">
                            <LoaderCircle className="mx-auto size-5 animate-spin" />
                          </TableCell>
                        </TableRow>
                      ) : visibleEntries.length === 0 ? (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={3} className="h-40 text-center text-muted-foreground">
                            当前目录为空
                          </TableCell>
                        </TableRow>
                      ) : (
                        visibleEntries.map((entry) => {
                          return (
                            <TableRow
                              key={entry.path}
                              className="cursor-pointer"
                              onClick={() => void openEntry(entry)}
                            >
                              <TableCell>
                                <div className="flex min-w-0 items-center gap-3">
                                  <div className="flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                                    {entry.isDirectory ? (
                                      <Folder className="size-8" />
                                    ) : thumbnailImages[entry.path] ? (
                                      <img
                                        src={thumbnailImages[entry.path]}
                                        alt=""
                                        className="h-full w-full object-cover"
                                      />
                                    ) : (
                                      <Play className="size-4" />
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="truncate font-medium">{entry.name}</div>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {entry.isDirectory ? "—" : formatSize(entry.size)}
                              </TableCell>
                              <TableCell className="text-muted-foreground">{formatDate(entry.modifiedAt)}</TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
          </Card>
        ) : (
          <div className="h-full overflow-auto p-px">
            <div className="mx-auto grid w-full max-w-3xl gap-4">
              {settingsMessage && (
                <Alert>
                  <RotateCcw className="size-4" />
                  <AlertTitle>已更新</AlertTitle>
                  <AlertDescription>{settingsMessage}</AlertDescription>
                </Alert>
              )}
              <Card>
                <CardHeader>
                  <CardTitle>文件列表缓存</CardTitle>
                  <CardDescription>
                    缓存在当前前端窗口内存中，命中时同步恢复目录列表，不经过 Wails 或 WebDAV。默认保留 30 分钟、上限 32 MB；过期自动失效，超过上限按最近最少使用淘汰，手动刷新会绕过缓存。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="directory-cache-ttl">缓存时间（分钟）</Label>
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
                      <Label htmlFor="directory-cache-max-size">总大小上限（MB）</Label>
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
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">估算内存占用</span>
                      <Badge variant="outline">
                        {directoryCacheStats.totalBytes === 0 ? "0 B" : formatSize(directoryCacheStats.totalBytes)} / {directoryCacheSettings.maxSizeMB} MB
                      </Badge>
                      <Badge variant="outline">{directoryCacheStats.count} 个目录</Badge>
                      <Badge variant="outline">{directoryCacheStats.totalEntries} 个条目</Badge>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void clearDirectoryCache()}
                      disabled={directoryCacheStats.count === 0}
                    >
                      <Trash2 />
                      清空列表缓存
                    </Button>
                  </div>
                  <Separator />
                  <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                    <div>
                      <div className="font-medium">滚动位置缓存</div>
                      <div className="text-muted-foreground">
                        固定上限 {DIRECTORY_SCROLL_POSITION_CACHE_LIMIT} 个目录，超过后按最近最少使用淘汰。
                      </div>
                    </div>
                    <Badge variant="outline">
                      {directoryScrollPositionCount} / {DIRECTORY_SCROLL_POSITION_CACHE_LIMIT} 个目录
                    </Badge>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>URL 缓存</CardTitle>
                  <CardDescription>
                    设置 GET 请求 302 Location 的缓存时间。默认 30 分钟，范围 1–1440 分钟。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid max-w-sm gap-2">
                    <Label htmlFor="cache-ttl">缓存时间（分钟）</Label>
                    <Input
                      id="cache-ttl"
                      type="number"
                      min={1}
                      max={1440}
                      value={ttlInput}
                      onChange={(event) => setTtlInput(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={() => void saveTTL()} disabled={!urlCacheSettingsChanged}>
                      保存
                    </Button>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">当前缓存</span>
                      <Badge variant="outline">{cacheCount} 条</Badge>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void clearCache()} disabled={cacheCount === 0}>
                      <Trash2 />
                      清空缓存
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>视频缩略图</CardTitle>
                  <CardDescription>
                    仅为当前打开目录的视频加载缩略图。生成结果会持久化，并按最近使用时间自动淘汰。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="grid gap-2">
                      <Label htmlFor="thumbnail-max-age">最长保留时间（天）</Label>
                      <Input
                        id="thumbnail-max-age"
                        type="number"
                        min={1}
                        max={3650}
                        value={thumbnailMaxAgeInput}
                        onChange={(event) => setThumbnailMaxAgeInput(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="thumbnail-max-size">总大小上限（MB）</Label>
                      <Input
                        id="thumbnail-max-size"
                        type="number"
                        min={16}
                        max={10240}
                        value={thumbnailMaxSizeInput}
                        onChange={(event) => setThumbnailMaxSizeInput(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="thumbnail-offset">缩略图偏移（秒）</Label>
                      <Input
                        id="thumbnail-offset"
                        type="number"
                        min={0}
                        max={3600}
                        value={thumbnailOffsetInput}
                        onChange={(event) => setThumbnailOffsetInput(event.target.value)}
                      />
                    </div>
                  </div>
                  <Button
                    onClick={() => void saveThumbnailSettings()}
                    disabled={!thumbnailSettingsChanged}
                  >
                    保存
                  </Button>
                  <Separator />
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">空间占用</span>
                      <Badge variant="outline">
                        {thumbnailStats.totalBytes === 0 ? "0 B" : formatSize(thumbnailStats.totalBytes)} / {state.thumbnailMaxSizeMB} MB
                      </Badge>
                      <Badge variant="outline">{thumbnailStats.count} 张</Badge>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void clearThumbnailCache()}
                      disabled={thumbnailStats.count === 0}
                    >
                      <Trash2 />
                      清空缩略图
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
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1.5">
                      <CardTitle>本地存储</CardTitle>
                      <CardDescription>应用配置、视频缩略图和播放进度都保存在这个应用数据目录下。</CardDescription>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void openStorageDirectory()}>
                      <FolderOpen />
                      打开目录
                    </Button>
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
                    <span className="text-muted-foreground">缩略图目录</span>
                    <code className="break-all rounded bg-muted px-2 py-1">{state.thumbnailDirectory}</code>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-muted-foreground">播放进度文件</span>
                    <code className="break-all rounded bg-muted px-2 py-1">{state.playbackProgressPath}</code>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>WebDAV 代理</CardTitle>
                  <CardDescription>
                    本地代理仅监听 127.0.0.1，本机访问无需账号、密码或 token；代理内部自动使用已保存的 123 云盘 WebDAV 凭据访问上游。
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 text-sm">
                  <div className="grid gap-1">
                    <span className="text-muted-foreground">123 云盘 WebDAV</span>
                    <code className="break-all rounded bg-muted px-2 py-1">{state.endpoint}</code>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-muted-foreground">本地代理</span>
                    <code className="break-all rounded bg-muted px-2 py-1">{state.proxyBaseUrl}</code>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-muted-foreground">转发策略</span>
                    <span>GET：缓存并复用 302 Location；其他 WebDAV 方法：直接透传。</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </main>

      <Dialog
        open={Boolean(activeVideo)}
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
        <DialogContent className="flex h-[90vh] w-[95vw] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[95vw]">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle className="truncate pr-8">{activeVideo?.name ?? "视频播放"}</DialogTitle>
            <DialogDescription className="truncate font-mono text-xs">
              {activeVideo?.path}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 bg-black">
            {activeVideo && (
              <VideoPlayer
                key={activeVideo.url}
                src={activeVideo.url}
                initialPosition={activeVideo.resumePosition}
                onPersistProgress={(position, duration) => {
                  persistPlaybackProgress(activeVideo.path, position, duration);
                }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default App;
