import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from "react";
import { Events } from "@wailsio/runtime";
import { AppService } from "../../bindings/drive-player";
import { formatPlayerTime } from "@/lib/player-time";
import { videoSeekControllers } from "@/lib/video-seeking";

type Progress = { position: number; duration: number };
export type FullscreenHUDHandle = { updateProgress: (progress: Progress) => void };

export function FullscreenHUD({ ref, videoRef, isAndroid, androidBridge, sideOffset }: {
  ref: Ref<FullscreenHUDHandle>;
  videoRef: RefObject<HTMLVideoElement | null>;
  isAndroid: boolean;
  androidBridge: () => { playerGetPower?: () => string } | null;
  sideOffset: number;
}) {
  const [clock, setClock] = useState(() => Date.now());
  const [batteryPercent, setBatteryPercent] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress>(() => {
    const video = videoRef.current;
    return { position: video ? videoSeekControllers.get(video)?.position ?? video.currentTime : 0, duration: video?.duration ?? 0 };
  });
  const latest = useRef(progress);
  const frame = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    updateProgress(next) {
      latest.current = next;
      if (frame.current !== null) return;
      // 高频输入合并到一帧，只有实际显示的秒数变化才更新这个小组件。
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const next = latest.current;
        setProgress((current) => formatPlayerTime(current.position) === formatPlayerTime(next.position)
          && formatPlayerTime(current.duration) === formatPlayerTime(next.duration) ? current : next);
      });
    },
  }), []);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  useEffect(() => {
    let cancelled = false;
    const updateBattery = (percent: number) => setBatteryPercent(Number.isFinite(percent) && percent >= 0 ? Math.max(0, Math.min(100, Math.round(percent))) : null);
    const syncAndroidPower = () => {
      try { updateBattery((JSON.parse(androidBridge()?.playerGetPower?.() ?? "{}")?.level ?? -1) * 100); }
      catch { setBatteryPercent(null); }
    };
    const syncDesktopPower = async () => {
      try { const percent = await AppService.GetBatteryPercent(); if (!cancelled) updateBattery(percent); }
      catch { if (!cancelled) setBatteryPercent(null); }
    };
    const cleanup = Events.On("player:BatteryChanged", (event) => {
      if (!isAndroid) { void syncDesktopPower(); return; }
      try {
        const payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        const level = (payload as { level?: unknown } | null)?.level;
        updateBattery(typeof level === "number" ? level * 100 : -1);
      } catch { setBatteryPercent(null); }
    });
    if (isAndroid) syncAndroidPower();
    else void syncDesktopPower();
    let clockTimeout = 0;
    const scheduleClockUpdate = () => {
      clockTimeout = window.setTimeout(() => { setClock(Date.now()); scheduleClockUpdate(); }, 60_000 - Date.now() % 60_000 + 50);
    };
    scheduleClockUpdate();
    return () => { cancelled = true; cleanup(); window.clearTimeout(clockTimeout); };
  }, [androidBridge, isAndroid]);

  return <div className="video-fullscreen-hud" style={{ left: `${sideOffset}px`, right: `${sideOffset}px` }} aria-hidden="true">
    <span className="video-fullscreen-hud__chip video-fullscreen-hud__status">
      <span>{new Date(clock).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
      {batteryPercent !== null && <span>{batteryPercent}%</span>}
    </span>
    <span className="video-fullscreen-hud__chip video-fullscreen-hud__progress">{formatPlayerTime(progress.position)} / {formatPlayerTime(progress.duration)}</span>
  </div>;
}
