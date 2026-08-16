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
  Trash2,
} from "lucide-react";
import { Events, System } from "@wailsio/runtime";
import { AppService } from "../bindings/drive-player";
import type {
  AppState,
  FileEntry,
  PlaybackProgressStats,
  QuarkIDCacheStats,
  ThumbnailCacheStats,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

function VideoPlayer({
  src,
  initialPosition,
  onPersistProgress,
  isAndroid,
  fullscreenHUDEnabled,
  fullscreenHUDSideOffsetPX,
}: {
  src: string;
  initialPosition: number;
  onPersistProgress: (position: number, duration: number) => void;
  isAndroid: boolean;
  fullscreenHUDEnabled: boolean;
  fullscreenHUDSideOffsetPX: number;
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
  const miniProgressRef = useRef<HTMLDivElement | null>(null);
  const gestureFeedbackRef = useRef<HTMLDivElement | null>(null);
  const gestureFeedbackHideTimerRef = useRef<number | null>(null);
  const lastPersistedAt = useRef(0);
  const endedRef = useRef(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const nativeFullscreenRef = useRef(false);
  const [webFullscreen, setWebFullscreen] = useState(false);
  const [hudClock, setHUDClock] = useState(() => Date.now());
  const [hudBatteryPercent, setHUDBatteryPercent] = useState<number | null>(null);
  const [hudProgress, setHUDProgress] = useState({ position: initialPosition, duration: 0 });
  const hudSliderDraggingRef = useRef(false);
  const hudGestureDraggingRef = useRef(false);
  const hudSeekPendingRef = useRef(false);
  const fullscreenHUDVisible = fullscreenHUDEnabled && (nativeFullscreen || webFullscreen);
  const gesture = useRef<{
    pointerId: number;
    mode: GestureMode;
    startX: number;
    startY: number;
    startTime: number;
    startBrightness: number;
    targetTime: number;
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
    onPersistProgress(position, duration);
  }, [onPersistProgress]);

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
    const root = frame?.querySelector<HTMLElement>(".media-default-skin");
    if (!frame || !root) return;

    const systemPointerIds = new Set<number>();
    const systemTouchIds = new Set<number>();
    let suppressSystemGestureClickUntil = 0;

    const isControlsTarget = (target: EventTarget | null) => {
      return target instanceof Element && Boolean(target.closest(
        ".media-controls--root, button, [role='slider'], input, select, textarea, a",
      ));
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

    const onPointerDown = (event: PointerEvent) => {
      if (!isAndroid) return;
      const video = videoRef.current;
      if (!video) return;
      const rect = root.getBoundingClientRect();
      const relativeX = event.clientX - rect.left;
      const relativeY = event.clientY - rect.top;
      const guards = getSystemGestureGuards();
      const startsInSystemGestureZone = nativeFullscreenRef.current
        && (relativeY <= guards.top || relativeY >= rect.height - guards.bottom);
      if (startsInSystemGestureZone) {
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
        startTime: video.currentTime,
        startBrightness,
        targetTime: video.currentTime,
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
      const current = gesture.current;
      const video = videoRef.current;
      if (!current || current.pointerId !== event.pointerId || !video) return;
      if (!isAndroid) return;

      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (current.mode === "pending") {
        if (absX >= 8 && absX > absY * 1.05) {
          current.mode = "seek";
          hudGestureDraggingRef.current = true;
          hudSeekPendingRef.current = true;
          hideGestureFeedback();
        }
        else if (current.side && absY >= 8 && absY > absX * 1.05) {
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
        const rawPercent = (current.startBrightness - dy / current.rect.height) * 100;
        const percent = Math.max(5, Math.min(100, Math.round(rawPercent / 5) * 5));
        androidBridge()?.playerSetBrightness?.(percent);
        showGestureFeedback(`亮度 ${percent}%`);
        return;
      }

      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      current.targetTime = Math.max(
        0,
        Math.min(duration, current.startTime + (dx / current.viewportWidth) * duration),
      );
      hudSeekPendingRef.current = true;
      if (fullscreenHUDVisible) {
        setHUDProgress({ position: current.targetTime, duration });
      }
      // Seek continuously so the decoder can load/display frames while the finger moves.
      video.currentTime = current.targetTime;
    };

    const finishPointer = (event: PointerEvent) => {
      if (systemPointerIds.delete(event.pointerId)) {
        suppressSystemGestureClickUntil = performance.now() + 1000;
        event.stopImmediatePropagation();
        return;
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
      if (performance.now() >= suppressSystemGestureClickUntil) return;
      event.preventDefault();
      event.stopImmediatePropagation();
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

    return () => {
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
    };
  }, [androidBridge, clearGestureFeedbackHideTimer, fullscreenHUDVisible, hideGestureFeedback, isAndroid, persistProgress, scheduleGestureFeedbackHide, showGestureFeedback]);

  return (
    <div
      ref={frameRef}
      className={`video-player-frame${isAndroid ? " video-player-frame--android" : ""}${nativeFullscreen ? " video-player-frame--fullscreen" : ""}`}
    >
      <Player.Provider>
        <DriveVideoSkin
          nativeFullscreen={isAndroid ? { active: nativeFullscreen, onToggle: toggleAndroidFullscreen } : undefined}
          onTimeSliderProgress={syncHUDWithTimeSlider}
        >
          <Video
            ref={videoRef}
            src={src}
            playsInline
            autoPlay
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              hudSliderDraggingRef.current = false;
              hudGestureDraggingRef.current = false;
              hudSeekPendingRef.current = false;
              if (initialPosition > 0 && initialPosition <= video.duration) {
                video.currentTime = Math.min(initialPosition, Math.max(0, video.duration - 0.1));
              }
              setHUDProgress({ position: video.currentTime, duration: video.duration });
            }}
            onTimeUpdate={(event) => {
              if (fullscreenHUDVisible && !hudSeekPendingRef.current) {
                setHUDProgress({ position: event.currentTarget.currentTime, duration: event.currentTarget.duration });
              }
              if (Date.now() - lastPersistedAt.current >= 3_000) {
                persistProgress(event.currentTarget);
              }
            }}
            onSeeked={(event) => {
              if (hudGestureDraggingRef.current || hudSliderDraggingRef.current) return;
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
                onPersistProgress(video.duration, video.duration);
              }
            }}
          />
          <div className="video-mini-progress" aria-hidden="true">
            <div ref={miniProgressRef} className="video-mini-progress__fill" />
          </div>
          <div ref={gestureFeedbackRef} className="video-gesture-feedback" hidden aria-live="polite" />
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
      const normalizedPercent = Math.max(0, Math.min(100, offsetPercent));
      const target = duration > 0
        ? Math.min((duration * normalizedPercent) / 100, Math.max(0, duration - 0.25))
        : 0;
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
  const [thumbnailStats, setThumbnailStats] = useState<ThumbnailCacheStats>({ count: 0, totalBytes: 0 });
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [webdavCacheTTLInput, setWebDAVCacheTTLInput] = useState("30");
  const [quarkDownloadCacheTTLInput, setQuarkDownloadCacheTTLInput] = useState("30");
  const [quarkIDCacheTTLInput, setQuarkIDCacheTTLInput] = useState("30");
  const [directoryCacheTTLInput, setDirectoryCacheTTLInput] = useState(String(directoryCacheSettings.ttlMinutes));
  const [directoryCacheMaxSizeInput, setDirectoryCacheMaxSizeInput] = useState(String(directoryCacheSettings.maxSizeMB));
  const [thumbnailMaxAgeInput, setThumbnailMaxAgeInput] = useState("30");
  const [thumbnailMaxSizeInput, setThumbnailMaxSizeInput] = useState("512");
  const [thumbnailOffsetPercentInput, setThumbnailOffsetPercentInput] = useState("10");
  const [playbackMaxAgeInput, setPlaybackMaxAgeInput] = useState("365");
  const [playbackMaxSizeInput, setPlaybackMaxSizeInput] = useState("16");
  const [fullscreenHUDEnabledInput, setFullscreenHUDEnabledInput] = useState(false);
  const [fullscreenHUDSideOffsetInput, setFullscreenHUDSideOffsetInput] = useState("0");
  const [fullscreenHUDToggleSaving, setFullscreenHUDToggleSaving] = useState(false);
  const directoryRequestId = useRef(0);
  const directoryRequest = useRef<ReturnType<typeof AppService.ListDirectory> | null>(null);
  const directoryAbortController = useRef<AbortController | null>(null);
  const thumbnailAbortController = useRef<AbortController | null>(null);
  const directoryScrollViewportRef = useRef<HTMLDivElement | null>(null);
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
  const thumbnailReloadNeeded = useRef(false);
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
    setThumbnailMaxAgeInput(String(nextState.thumbnailMaxAgeDays));
    setThumbnailMaxSizeInput(String(nextState.thumbnailMaxSizeMB));
    setThumbnailOffsetPercentInput(String(nextState.thumbnailOffsetPercent));
    setPlaybackMaxAgeInput(String(nextState.playbackMaxAgeDays));
    setPlaybackMaxSizeInput(String(nextState.playbackMaxSizeMB));
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
              state?.thumbnailOffsetPercent ?? 10,
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
  }, [state?.thumbnailOffsetPercent]);

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

  const navigateDirectory = useCallback((targetPath: string) => {
    const normalized = normalizePath(targetPath);
    const current = currentPathRef.current;
    if (normalized === current) return;

    const back = directoryBackHistory.current;
    back.push(current);
    if (back.length > DIRECTORY_HISTORY_LIMIT) back.shift();
    directoryForwardHistory.current.length = 0;
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

  const saveActiveBrowseSession = useCallback(() => {
    const viewport = directoryScrollViewportRef.current;
    if (viewport) {
      rememberDirectoryScrollPosition(currentPathRef.current, viewport.scrollTop);
    }
    const session = providerBrowseSessions.current[activeBrowseProvider.current];
    session.currentPath = currentPathRef.current;
    session.entries = entries.slice();
    session.thumbnailImages = { ...thumbnailImages };
  }, [entries, rememberDirectoryScrollPosition, thumbnailImages]);

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
      setEntries([]);
      setThumbnailImages({});
      void loadDirectory(session.currentPath);
      return;
    }

    const visibleEntries = cached.filter((entry) => entry.isDirectory || isVideo(entry));
    session.entries = visibleEntries.slice();
    setEntries(visibleEntries);
    setThumbnailImages({ ...session.thumbnailImages });
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
    thumbnailAbortController.current?.abort();
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
    thumbnailAbortController.current?.abort();
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
    thumbnailAbortController.current?.abort();
    const nextState = await AppService.Logout();
    resetProviderBrowseSession(loggedOutProvider);
    syncBackendState(nextState);
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
    setCurrentPath("/");
    syncDirectoryHistoryState();
    refreshProviderBrowseStats();
    setWebDAVCacheCount(0);
    setQuarkDownloadCacheCount(0);
    setQuarkIDCacheStats({ count: 0 });
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
      window.setTimeout(() => void refreshProviderCaches(), 600);
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

  const closeSettings = useCallback(() => {
    setShowSettings(false);
    if (thumbnailReloadNeeded.current) {
      thumbnailReloadNeeded.current = false;
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

  const saveThumbnailSettings = async () => {
    const maxAgeDays = Number.parseInt(thumbnailMaxAgeInput, 10);
    const maxSizeMB = Number.parseInt(thumbnailMaxSizeInput, 10);
    const offsetPercent = Number.parseInt(thumbnailOffsetPercentInput, 10);
    if (![maxAgeDays, maxSizeMB, offsetPercent].every(Number.isFinite)) {
      toast.add({ title: "设置无效", description: "请输入有效的缩略图缓存设置", type: "error" });
      return;
    }
    try {
      const previousOffset = state?.thumbnailOffsetPercent;
      const nextState = await AppService.SetThumbnailSettings(maxAgeDays, maxSizeMB, offsetPercent);
      setState(nextState);
      setThumbnailMaxAgeInput(String(nextState.thumbnailMaxAgeDays));
      setThumbnailMaxSizeInput(String(nextState.thumbnailMaxSizeMB));
      setThumbnailOffsetPercentInput(String(nextState.thumbnailOffsetPercent));
      if (previousOffset !== nextState.thumbnailOffsetPercent) {
        setThumbnailImages({});
        thumbnailReloadNeeded.current = true;
      }
      await refreshThumbnailStats();
    } catch (err) {
      toast.add({ title: "保存失败", description: errorMessage(err), type: "error" });
    }
  };

  const clearThumbnailCache = async () => {
    try {
      setThumbnailStats(await AppService.ClearThumbnailCache());
      setThumbnailImages({});
      thumbnailReloadNeeded.current = true;
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

  const saveFullscreenHUDSettings = async () => {
    const offsetPX = Number.parseInt(fullscreenHUDSideOffsetInput, 10);
    if (!Number.isInteger(offsetPX) || offsetPX < 0 || offsetPX > 200) {
      toast.add({ title: "设置无效", description: "全屏信息左右偏移必须在 0 到 200 px 之间", type: "error" });
      return;
    }
    try {
      const nextState = await AppService.SetFullscreenHUDSettings(fullscreenHUDEnabledInput, offsetPX);
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
      if (backWindow.__drivePlayerExitFullscreen?.()) return true;
      if (activeVideo) {
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
      if (canGoBack) {
        goBackDirectory();
        return true;
      }
      return false;
    };

    return () => {
      delete backWindow.__drivePlayerHandleBack;
    };
  }, [activeVideo, canGoBack, closeSettings, goBackDirectory, isAndroid, loginProvider, showLogoutConfirm, showSettings]);

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
  const thumbnailSettingsChanged =
    Number.parseInt(thumbnailMaxAgeInput, 10) !== state.thumbnailMaxAgeDays ||
    Number.parseInt(thumbnailMaxSizeInput, 10) !== state.thumbnailMaxSizeMB ||
    Number.parseInt(thumbnailOffsetPercentInput, 10) !== state.thumbnailOffsetPercent;
  const playbackProgressSettingsChanged =
    Number.parseInt(playbackMaxAgeInput, 10) !== state.playbackMaxAgeDays ||
    Number.parseInt(playbackMaxSizeInput, 10) !== state.playbackMaxSizeMB;
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
              void refreshThumbnailStats();
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

      <main className="min-h-0 flex-1 overflow-hidden p-2 sm:p-4 md:p-6">
        {error && !showSettings && (
          <Alert variant="destructive" className="mb-4">
            <CircleAlert className="size-4" />
            <AlertTitle>请求失败</AlertTitle>
            <AlertDescription className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:gap-4">
              <span>{error}</span>
              <Button variant="ghost" size="sm" className="-my-1" onClick={() => setError("")}>
                关闭
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <Card className="flex h-full min-h-0 flex-col gap-0 py-0">
              <CardHeader className="border-b px-3 py-3 sm:px-6">
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
                          <BreadcrumbLink
                            render={<button type="button" />}
                            onClick={() => navigateDirectory("/")}
                          >
                            根目录
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                      {pathParts.map((part, index) => (
                        <Fragment key={part.path}>
                          <BreadcrumbSeparator />
                          <BreadcrumbItem>
                            {index === pathParts.length - 1 ? (
                              <BreadcrumbPage>{part.name}</BreadcrumbPage>
                            ) : (
                              <BreadcrumbLink
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
              </CardHeader>

              <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                {!isMobile && (
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
                )}
                <ScrollArea viewportRef={directoryScrollViewportRef} className="min-h-0 flex-1">
                  <Table className="table-fixed">
                    <colgroup>
                      <col />
                      {!isMobile && <col className="w-32" />}
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
                          return (
                            <TableRow
                              key={entry.path}
                              className="cursor-pointer"
                              onClick={() => void openEntry(entry)}
                            >
                              <TableCell>
                                <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                                  <div className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted sm:h-14 sm:w-24">
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
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate font-medium">{entry.name}</div>
                                    {isMobile && (
                                      <div className="mt-1 flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
                                        <span>{entry.isDirectory ? "文件夹" : formatSize(entry.size)}</span>
                                        <span className="shrink-0">{formatDate(entry.modifiedAt)}</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </TableCell>
                              {!isMobile && (
                                <TableCell className="text-muted-foreground">
                                  {entry.isDirectory ? "—" : formatSize(entry.size)}
                                </TableCell>
                              )}
                              {!isMobile && (
                                <TableCell className="text-muted-foreground">{formatDate(entry.modifiedAt)}</TableCell>
                              )}
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
        </Card>
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
              variant="destructive"
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
        <DialogContent className="flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[90vh] sm:w-[92vw] sm:max-w-4xl sm:rounded-xl">
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
                      <Label htmlFor="thumbnail-offset">缩略图偏移（%）</Label>
                      <Input
                        id="thumbnail-offset"
                        type="number"
                        min={0}
                        max={100}
                        value={thumbnailOffsetPercentInput}
                        onChange={(event) => setThumbnailOffsetPercentInput(event.target.value)}
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
                  <CardTitle>全屏顶部信息</CardTitle>
                  <CardDescription>
                    进入全屏后，左上角用一个标签显示时间和电量百分比，右上角显示当前播放进度。标签始终贴着顶部，左右偏移只调整距屏幕两侧的距离。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex max-w-xs items-center justify-between gap-4">
                    <Label htmlFor="fullscreen-hud-enabled">显示顶部信息</Label>
                    <Switch
                      id="fullscreen-hud-enabled"
                      checked={fullscreenHUDEnabledInput}
                      className="data-disabled:cursor-default"
                      disabled={fullscreenHUDToggleSaving}
                      onCheckedChange={(checked) => void setFullscreenHUDEnabled(checked)}
                    />
                  </div>
                  <div className="grid max-w-xs gap-2">
                    <Label htmlFor="fullscreen-hud-side-offset">左右偏移（px）</Label>
                    <Input
                      id="fullscreen-hud-side-offset"
                      type="number"
                      min={0}
                      max={200}
                      className="transition-none"
                      value={fullscreenHUDSideOffsetInput}
                      onChange={(event) => setFullscreenHUDSideOffsetInput(event.target.value)}
                      disabled={!fullscreenHUDEnabledInput}
                    />
                  </div>
                  <Button
                    onClick={() => void saveFullscreenHUDSettings()}
                    disabled={!fullscreenHUDEnabledInput || !fullscreenHUDSettingsChanged}
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
                      <CardDescription>应用配置、视频缩略图和播放进度都保存在这个应用数据目录下。</CardDescription>
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
                    <span className="text-muted-foreground">缩略图目录</span>
                    <code className="break-all rounded bg-muted px-2 py-1">{state.thumbnailDirectory}</code>
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
        <DialogContent
          className={isAndroid
            ? "flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-none"
            : "flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[90vh] sm:w-[95vw] sm:max-w-[95vw] sm:rounded-xl"}
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
                key={activeVideo.url}
                src={activeVideo.url}
                initialPosition={activeVideo.resumePosition}
                isAndroid={isAndroid}
                fullscreenHUDEnabled={state.fullscreenHudEnabled}
                fullscreenHUDSideOffsetPX={state.fullscreenHudSideOffsetPx}
                onPersistProgress={(position, duration) => {
                  persistPlaybackProgress(activeVideo.path, position, duration);
                }}
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
