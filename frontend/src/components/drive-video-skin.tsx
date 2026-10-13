import type { CSSProperties, PropsWithChildren, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Hotkey, selectControls, selectPlayback, useContainer, usePlayer } from "@videojs/react";
import { type AnyPlayerStore, type GestureMatchResult, type GestureRecognizer, getGestureCoordinator, resolveGestureAction, resolveHotkeyAction } from "@videojs/core/dom";
import { bindPlaybackShortcuts } from "@/lib/playback-shortcuts";
import { bindControlsHover } from "@/lib/controls-hover";
import { Container } from "@/components/videojs/ui/container";
import { BufferingIndicator } from "@/components/videojs/ui/buffering-indicator";
import { ErrorDialog } from "@/components/videojs/ui/error-dialog";
import { DefaultVideoControls } from "@/components/videojs/video/layout/controls";
import { VideoStatusIndicators } from "@/components/videojs/video/display/status-indicators";
import "@/components/videojs/styles/video/base.css";
import "@/components/videojs/video/skin.css";

const SEEK_TIME = 10;
const DOUBLE_TAP_WINDOW = 300;
export const DRIVE_VIDEO_CONTROLS_ACTIVITY_EVENT = "drive-video-controls-activity";

function restartControlsIdle(container: HTMLElement | null): void {
  if (!container) return;
  container.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse" }));
}

class DriveTapRecognizer implements GestureRecognizer {
  private lastTapTime = 0;
  private tapTimer: number | null = null;

  handleUp(matches: GestureMatchResult, event: PointerEvent): void {
    if (matches.resolve("doubletap").length === 0) {
      matches.resolve("tap")[0]?.onActivate(event);
      return;
    }

    const now = Date.now();
    if (now - this.lastTapTime <= DOUBLE_TAP_WINDOW) {
      this.clearTimer();
      this.lastTapTime = 0;
      matches.resolve("doubletap")[0]?.onActivate(event);
      return;
    }

    this.lastTapTime = now;
    this.clearTimer();
    this.tapTimer = window.setTimeout(() => {
      this.tapTimer = null;
      this.lastTapTime = 0;
      matches.resolve("tap")[0]?.onActivate(event);
    }, DOUBLE_TAP_WINDOW);
  }

  reset(): void {
    this.clearTimer();
    this.lastTapTime = 0;
  }

  private clearTimer(): void {
    if (this.tapTimer === null) return;
    window.clearTimeout(this.tapTimer);
    this.tapTimer = null;
  }
}

export type DriveVideoSkinProps = PropsWithChildren<{
  className?: string;
  style?: CSSProperties;
  onTimeSliderProgress?: (progress: { position: number; duration: number; dragging: boolean }) => void;
  sidePanel?: ReactNode;
  sidePanelControl?: {
    active: boolean;
    onToggle: () => void;
  };
  nativeFullscreen?: {
    active: boolean;
    onToggle: () => void;
  };
  mobile?: boolean;
}>;

export function DriveVideoSkin({
  children,
  className,
  style,
  nativeFullscreen,
  mobile = false,
  onTimeSliderProgress,
  sidePanel,
  sidePanelControl,
}: DriveVideoSkinProps): ReactNode {
  const sidePanelOpen = sidePanelControl?.active === true;
  const player = usePlayer() as AnyPlayerStore;
  const controls = usePlayer(selectControls);
  const playback = usePlayer(selectPlayback);
  const container = useContainer();
  const controlsRef = useRef(controls);
  const playbackPausedRef = useRef(playback?.paused ?? false);
  const previousPlaybackPausedRef = useRef(playback?.paused ?? false);
  const [pausedTouchControlsVisible, setPausedTouchControlsVisible] = useState<boolean | null>(null);
  const pausedTouchControlsVisibleRef = useRef<boolean | null>(null);
  controlsRef.current = controls;
  playbackPausedRef.current = playback?.paused ?? false;
  pausedTouchControlsVisibleRef.current = pausedTouchControlsVisible;

  useEffect(() => {
    if (mobile || !container) return;
    return bindControlsHover(container, () => controlsRef.current?.requestControlsLock() ?? (() => {}));
  }, [container, mobile]);

  useEffect(() => {
    if (!container) return;
    return bindPlaybackShortcuts(document, (action, key, value) => {
      resolveHotkeyAction(action)?.({ store: player, key, value });
      restartControlsIdle(container);
    });
  }, [container, player]);

  useEffect(() => {
    if (!container) return;

    const recognizer = new DriveTapRecognizer();
    const coordinator = getGestureCoordinator(container);
    const cleanups: Array<() => void> = [];
    const addAction = (
      type: "tap" | "doubletap",
      action: string,
      value?: number,
      pointer?: "mouse" | "touch" | "pen",
      region?: "left" | "center" | "right",
    ) => {
      const resolver = resolveGestureAction(action);
      if (!resolver) return;
      cleanups.push(coordinator.add({
        type,
        recognizer,
        action,
        value,
        pointer,
        region,
        onActivate: (event) => {
          if (mobile && action === "togglePaused") {
            if (playbackPausedRef.current) {
              if (pausedTouchControlsVisibleRef.current === true) {
                restartControlsIdle(container);
              }
            } else if (controlsRef.current?.userActive) {
              pausedTouchControlsVisibleRef.current = true;
              setPausedTouchControlsVisible(true);
            }
          }
          if (
            mobile
            && type === "doubletap"
            && action === "seekStep"
            && !playbackPausedRef.current
            && controlsRef.current?.userActive
          ) {
            restartControlsIdle(container);
          }
          resolver({ store: player, value, event });
        },
      }));
    };

    cleanups.push(coordinator.add({
      type: "tap",
      recognizer,
      action: "toggleControls",
      pointer: "touch",
      onActivate: () => {
        const currentControls = controlsRef.current;
        if (!currentControls) return;
        if (mobile && playbackPausedRef.current) {
          const currentVisible = pausedTouchControlsVisibleRef.current ?? currentControls.userActive;
          const nextVisible = !currentVisible;
          pausedTouchControlsVisibleRef.current = nextVisible;
          setPausedTouchControlsVisible(nextVisible);
          if (nextVisible) {
            restartControlsIdle(container);
          } else if (currentControls.userActive) {
            currentControls.toggleControls();
          }
          return;
        }
        currentControls.toggleControls();
      },
    }));
    addAction("tap", "togglePaused", undefined, "mouse", "center");
    addAction("doubletap", "seekStep", -SEEK_TIME, undefined, "left");
    addAction("doubletap", nativeFullscreen ? "togglePaused" : "toggleFullscreen", undefined, undefined, "center");
    addAction("doubletap", "seekStep", SEEK_TIME, undefined, "right");

    return () => {
      cleanups.forEach((cleanup) => cleanup());
      recognizer.reset();
    };
  }, [container, mobile, nativeFullscreen, player]);

  useEffect(() => {
    const paused = playback?.paused ?? false;
    const wasPaused = previousPlaybackPausedRef.current;
    previousPlaybackPausedRef.current = paused;

    if (!mobile) {
      pausedTouchControlsVisibleRef.current = null;
      setPausedTouchControlsVisible(null);
      return;
    }

    if (!wasPaused && paused) {
      if (controlsRef.current?.userActive) {
        pausedTouchControlsVisibleRef.current = true;
        setPausedTouchControlsVisible(true);
      }
      return;
    }

    if (wasPaused && !paused) {
      if (pausedTouchControlsVisibleRef.current === true) {
        restartControlsIdle(container);
      }
      pausedTouchControlsVisibleRef.current = null;
      setPausedTouchControlsVisible(null);
    }
  }, [container, mobile, playback?.paused]);

  useEffect(() => {
    if (!mobile || !container) return;
    const onExternalControlsActivity = () => {
      if (playbackPausedRef.current) return;
      if (!controlsRef.current?.userActive) return;
      restartControlsIdle(container);
    };
    container.addEventListener(DRIVE_VIDEO_CONTROLS_ACTIVITY_EVENT, onExternalControlsActivity);
    return () => container.removeEventListener(DRIVE_VIDEO_CONTROLS_ACTIVITY_EVENT, onExternalControlsActivity);
  }, [container, mobile]);

  return (
    <Container
      tabIndex={-1}
      data-theme="default"
      data-preset="video"
      onFocus={(event) => { if (event.target === event.currentTarget) event.currentTarget.blur(); }}
      className={`video-skin drive-video-skin${sidePanelOpen ? " drive-video-skin--side-panel-open" : ""} ${className ?? ""}`}
      style={style}
    >
      <div className="media-player-pane">
        {children}
        <BufferingIndicator />
        <ErrorDialog />
        <DefaultVideoControls
          nativeFullscreen={nativeFullscreen}
          sidePanelControl={sidePanelControl}
          onTimeSliderProgress={onTimeSliderProgress}
          touchVisible={mobile ? pausedTouchControlsVisible : null}
          mobile={mobile}
        />
        <Hotkey target="document" keys="Space" action="togglePaused" />
        <Hotkey target="document" keys="k" action="togglePaused" />
        {!nativeFullscreen && <Hotkey target="document" keys="f" action="toggleFullscreen" />}
        <Hotkey target="document" keys="c" action="toggleSubtitles" />
        <Hotkey target="document" keys="i" action="togglePictureInPicture" />
        <Hotkey target="document" keys="ArrowRight" action="seekStep" value={SEEK_TIME / 2} />
        <Hotkey target="document" keys="ArrowLeft" action="seekStep" value={-SEEK_TIME / 2} />
        <Hotkey target="document" keys="l" action="seekStep" value={SEEK_TIME} />
        <Hotkey target="document" keys="j" action="seekStep" value={-SEEK_TIME} />
        <Hotkey target="document" keys="ArrowUp" action="volumeStep" value={0.05} />
        <Hotkey target="document" keys="ArrowDown" action="volumeStep" value={-0.05} />
        <Hotkey target="document" keys="0-9" action="seekToPercent" />
        <Hotkey target="document" keys="Home" action="seekToPercent" value={0} />
        <Hotkey target="document" keys="End" action="seekToPercent" value={100} />
        <Hotkey target="document" keys=">" action="speedUp" />
        <Hotkey target="document" keys="<" action="speedDown" />
        <VideoStatusIndicators />
      </div>
      {sidePanel ?? null}
    </Container>
  );
}
