import {
  type CSSProperties,
  type ComponentProps,
  forwardRef,
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { PanelRight } from "lucide-react";
import {
  audioText,
  captionsText,
  playbackRateText,
  qualityText,
  settingsText,
  speedText,
} from "@videojs/core/i18n/text/menu";
import {
  AirPlayEnterIcon,
  AirPlayExitIcon,
  CaptionsOffIcon,
  CaptionsOnIcon,
  CheckIcon,
  ChevronIcon,
  FullscreenEnterIcon,
  FullscreenExitIcon,
  GearIcon,
  PauseIcon,
  PipEnterIcon,
  PipExitIcon,
  PlayIcon,
  QualityIcon,
  RestartIcon,
  SpeechIcon,
  SpeedIcon,
  SpinnerIcon,
  VolumeHighIcon,
  VolumeLowIcon,
  VolumeOffIcon,
} from "@videojs/react/icons";
import {
  AirPlayButton,
  useAudioTrackOptions,
  BufferingIndicator,
  CaptionsButton,
  useCaptionsOptions,
  Container,
  Controls,
  ErrorDialog,
  FullscreenButton,
  Hotkey,
  Menu,
  MuteButton,
  PlayButton,
  usePlaybackRateOptions,
  Popover,
  useQualityOptions,
  SeekIndicator,
  selectControls,
  selectPlayback,
  Slider,
  StatusAnnouncer,
  StatusIndicator,
  Time,
  TimeSlider,
  Tooltip,
  useContainer,
  useHotkey,
  usePlayer,
  useTranslator,
  VolumeIndicator,
  VolumeSlider,
} from "@videojs/react";
import {
  type AnyPlayerStore,
  type GestureMatchResult,
  type GestureRecognizer,
  getGestureCoordinator,
  resolveGestureAction,
} from "@videojs/core/dom";

const TOP_STATUS_ACTIONS = ["toggleSubtitles", "toggleFullscreen", "togglePictureInPicture"] as const;
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

function MenuChevron({ flipped = false }: { flipped?: boolean }): ReactNode {
  return <ChevronIcon className={`media-icon media-menu__chevron ${flipped ? "media-icon--flipped" : ""}`} />;
}

function SettingsMenu(): ReactNode {
  const t = useTranslator();
  const playbackRate = usePlaybackRateOptions();
  const quality = useQualityOptions();
  const audioTrack = useAudioTrackOptions();
  const captions = useCaptionsOptions();
  const hasPlaybackRate = playbackRate?.state.availability === "available";
  const hasQuality = quality?.state.availability === "available";
  const hasAudioTrack = audioTrack?.state.availability === "available";
  const hasCaptions = captions?.state.availability === "available";

  if (!hasPlaybackRate && !hasQuality && !hasAudioTrack && !hasCaptions) return null;

  return (
    <Menu.Root side="top" align="center">
      <Menu.Trigger aria-label={t(settingsText)} className="media-button--settings" render={<Button />}>
        <GearIcon className="media-icon media-icon--settings" />
      </Menu.Trigger>
      <Menu.Content className="media-surface media-popover media-menu media-menu--settings">
        <Menu.View className="media-menu__panel">
          <div className="media-menu__group">
            {hasQuality ? (
              <Menu.Root>
                <Menu.Trigger
                  type="quality"
                  className="media-menu__item media-menu__item--submenu"
                  render={(props) => (
                    <div {...props}>
                      <QualityIcon className="media-icon" />
                      <span>{t(qualityText)}</span>
                      <span className="media-menu__hint">
                        <Menu.ItemValue className="media-menu__hint-label" />
                        <MenuChevron />
                      </span>
                    </div>
                  )}
                />
                <Menu.Content className="media-menu__panel">
                  <Menu.Back className="media-menu__back">
                    <MenuChevron flipped />
                    {t(qualityText)}
                  </Menu.Back>
                  <Menu.Separator className="media-menu__separator" />
                  <Menu.RadioGroup
                    className="media-menu__group"
                    value={quality.value}
                    onValueChange={quality.setValue}
                    aria-label={t(qualityText)}
                  >
                    {quality.options.map((option) => (
                      <Menu.RadioItem
                        key={option.value}
                        className="media-menu__item"
                        value={option.value}
                        disabled={option.disabled}
                      >
                        <span>
                          {option.label}
                          {option.tier ? <sup className="media-menu__tier">{option.tier}</sup> : null}
                        </span>
                        {option.badge ? <span className="media-badge">{option.badge}</span> : null}
                        <Menu.ItemIndicator
                          checked={option.value === quality.value}
                          forceMount
                          className="media-menu__indicator"
                        >
                          <CheckIcon className="media-icon" />
                        </Menu.ItemIndicator>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Content>
              </Menu.Root>
            ) : null}

            {hasAudioTrack ? (
              <Menu.Root>
                <Menu.Trigger
                  type="audio-track"
                  className="media-menu__item media-menu__item--submenu"
                  render={(props) => (
                    <div {...props}>
                      <SpeechIcon className="media-icon" />
                      <span>{t(audioText)}</span>
                      <span className="media-menu__hint">
                        <Menu.ItemValue className="media-menu__hint-label" />
                        <MenuChevron />
                      </span>
                    </div>
                  )}
                />
                <Menu.Content className="media-menu__panel">
                  <Menu.Back className="media-menu__back">
                    <MenuChevron flipped />
                    {t(audioText)}
                  </Menu.Back>
                  <Menu.Separator className="media-menu__separator" />
                  <Menu.RadioGroup
                    className="media-menu__group"
                    value={audioTrack.value}
                    onValueChange={audioTrack.setValue}
                    aria-label={t(audioText)}
                  >
                    {audioTrack.options.map((option) => (
                      <Menu.RadioItem
                        key={option.value}
                        className="media-menu__item"
                        value={option.value}
                        disabled={option.disabled}
                      >
                        <span>{option.label}</span>
                        <Menu.ItemIndicator
                          checked={option.value === audioTrack.value}
                          forceMount
                          className="media-menu__indicator"
                        >
                          <CheckIcon className="media-icon" />
                        </Menu.ItemIndicator>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Content>
              </Menu.Root>
            ) : null}

            {hasPlaybackRate ? (
              <Menu.Root>
                <Menu.Trigger
                  type="playback-rate"
                  className="media-menu__item media-menu__item--submenu"
                  render={(props) => (
                    <div {...props}>
                      <SpeedIcon className="media-icon" />
                      <span>{t(speedText)}</span>
                      <span className="media-menu__hint">
                        <Menu.ItemValue className="media-menu__hint-label" />
                        <MenuChevron />
                      </span>
                    </div>
                  )}
                />
                <Menu.Content className="media-menu__panel">
                  <Menu.Back className="media-menu__back">
                    <MenuChevron flipped />
                    {t(speedText)}
                  </Menu.Back>
                  <Menu.Separator className="media-menu__separator" />
                  <Menu.RadioGroup
                    className="media-menu__group"
                    value={playbackRate.value}
                    onValueChange={playbackRate.setValue}
                    aria-label={t(playbackRateText)}
                  >
                    {playbackRate.options.map((option) => (
                      <Menu.RadioItem
                        key={option.value}
                        className="media-menu__item"
                        value={option.value}
                        disabled={option.disabled}
                      >
                        <span>{option.label}</span>
                        <Menu.ItemIndicator
                          checked={option.value === playbackRate.value}
                          forceMount
                          className="media-menu__indicator"
                        >
                          <CheckIcon className="media-icon" />
                        </Menu.ItemIndicator>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Content>
              </Menu.Root>
            ) : null}

            {hasCaptions ? (
              <Menu.Root>
                <Menu.Trigger
                  type="captions"
                  className="media-menu__item media-menu__item--submenu"
                  render={(props) => (
                    <div {...props}>
                      <CaptionsOffIcon className="media-icon" />
                      <span>{t(captionsText)}</span>
                      <span className="media-menu__hint">
                        <Menu.ItemValue className="media-menu__hint-label" />
                        <MenuChevron />
                      </span>
                    </div>
                  )}
                />
                <Menu.Content className="media-menu__panel">
                  <Menu.Back className="media-menu__back">
                    <MenuChevron flipped />
                    {t(captionsText)}
                  </Menu.Back>
                  <Menu.Separator className="media-menu__separator" />
                  <Menu.RadioGroup
                    className="media-menu__group"
                    value={captions.value}
                    onValueChange={captions.setValue}
                    aria-label={t(captionsText)}
                  >
                    {captions.options.map((option) => (
                      <Menu.RadioItem
                        key={option.value}
                        className="media-menu__item"
                        value={option.value}
                        disabled={option.disabled}
                      >
                        <span>{option.label}</span>
                        <Menu.ItemIndicator
                          checked={option.value === captions.value}
                          forceMount
                          className="media-menu__indicator"
                        >
                          <CheckIcon className="media-icon" />
                        </Menu.ItemIndicator>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Content>
              </Menu.Root>
            ) : null}
          </div>
        </Menu.View>
      </Menu.Content>
    </Menu.Root>
  );
}

const Button = forwardRef<HTMLButtonElement, ComponentProps<"button">>(function Button({ className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`media-button media-button--subtle media-button--icon ${className ?? ""}`}
      {...props}
    />
  );
});

function AirPlayControl() {
  return (
    <Tooltip.Root side="top">
      <Tooltip.Trigger
        render={
          <AirPlayButton className="media-button--airplay" render={<Button />}>
            <AirPlayEnterIcon className="media-icon media-icon--airplay-enter" />
            <AirPlayExitIcon className="media-icon media-icon--airplay-exit" />
          </AirPlayButton>
        }
      />
      <Tooltip.Popup className="media-surface media-tooltip">
        <Tooltip.Label />
        <Tooltip.Shortcut className="media-tooltip__kbd" />
      </Tooltip.Popup>
    </Tooltip.Root>
  );
}

function FullscreenControl() {
  return (
    <Tooltip.Root side="top">
      <Tooltip.Trigger
        render={
          <FullscreenButton className="media-button--fullscreen" render={<Button />}>
            <FullscreenEnterIcon className="media-icon media-icon--fullscreen-enter" />
            <FullscreenExitIcon className="media-icon media-icon--fullscreen-exit" />
          </FullscreenButton>
        }
      />
      <Tooltip.Popup className="media-surface media-tooltip">
        <Tooltip.Label />
        <Tooltip.Shortcut className="media-tooltip__kbd" />
      </Tooltip.Popup>
    </Tooltip.Root>
  );
}

function VolumePopover(): ReactNode {
  const volumeUnsupported = usePlayer((s) => s.volumeAvailability === "unsupported");
  const muteButton = (
    <MuteButton className="media-button--mute" render={<Button />}>
      <VolumeOffIcon className="media-icon media-icon--volume-off" />
      <VolumeLowIcon className="media-icon media-icon--volume-low" />
      <VolumeHighIcon className="media-icon media-icon--volume-high" />
    </MuteButton>
  );

  if (volumeUnsupported) return muteButton;

  return (
    <Popover.Root openOnHover delay={200} closeDelay={100} side="top">
      <Popover.Trigger render={muteButton} />
      <Popover.Popup className="media-surface media-popover media-popover--volume">
        <VolumeSlider.Root className="media-slider" orientation="vertical" thumbAlignment="edge">
          <VolumeSlider.Track className="media-slider__track">
            <VolumeSlider.Fill className="media-slider__fill" />
          </VolumeSlider.Track>
          <VolumeSlider.Thumb className="media-slider__thumb media-slider__thumb--persistent" />
        </VolumeSlider.Root>
      </Popover.Popup>
    </Popover.Root>
  );
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

function TimeSliderProgressSync({
  position,
  duration,
  dragging,
  onProgress,
}: {
  position: number;
  duration: number;
  dragging: boolean;
  onProgress?: DriveVideoSkinProps["onTimeSliderProgress"];
}) {
  useEffect(() => {
    onProgress?.({ position, duration, dragging });
  }, [dragging, duration, onProgress, position]);
  return null;
}

function NativeFullscreenControl({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const label = active ? "退出全屏" : "进入全屏";
  return (
    <Button
      className="media-button--fullscreen"
      data-fullscreen={active ? "" : undefined}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <FullscreenEnterIcon className="media-icon media-icon--fullscreen-enter" />
      <FullscreenExitIcon className="media-icon media-icon--fullscreen-exit" />
    </Button>
  );
}

function SidePanelControl({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  useHotkey({
    keys: "s",
    target: "document",
    onActivate: onToggle,
  });

  return (
    <Tooltip.Root side="top">
      <Tooltip.Trigger
        render={
          <Button
            className="media-button--side-panel"
            aria-label={active ? "关闭播放器侧栏" : "打开播放器侧栏"}
            aria-pressed={active}
            aria-keyshortcuts="S"
            onClick={onToggle}
          >
            <PanelRight className="media-icon" />
          </Button>
        }
      />
      <Tooltip.Popup className="media-surface media-tooltip">
        <Tooltip.Label>{active ? "关闭播放器侧栏" : "打开播放器侧栏"}</Tooltip.Label>
        <Tooltip.Shortcut className="media-tooltip__kbd">S</Tooltip.Shortcut>
      </Tooltip.Popup>
    </Tooltip.Root>
  );
}

/**
 * Ejected from the Video.js v10 default React video skin so the application's
 * gesture semantics are explicit instead of overriding preset behavior later.
 */
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
      onFocus={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.blur();
      }}
      className={`media-default-skin media-default-skin--video${sidePanelOpen ? " media-default-skin--side-panel-open" : ""} ${className ?? ""}`}
      style={style}
    >
      <div className="media-player-pane">
      {children}

      <BufferingIndicator
        render={(props) => (
          <div {...props} className="media-buffering-indicator">
            <SpinnerIcon className="media-icon" />
          </div>
        )}
      />

      <ErrorDialog.Root>
        <ErrorDialog.Popup className="media-error">
          <div className="media-error__dialog media-surface">
            <div className="media-error__content">
              <ErrorDialog.Title className="media-error__title" />
              <ErrorDialog.Description className="media-error__description" />
            </div>
            <div className="media-error__actions">
              <ErrorDialog.Close className="media-button media-button--primary" />
            </div>
          </div>
        </ErrorDialog.Popup>
      </ErrorDialog.Root>

      <Controls.Root
        className="media-surface media-controls media-controls--root"
        render={(props, state) => (
          <div
            {...props}
            data-visible={
              (
                mobile && pausedTouchControlsVisible !== null
                  ? pausedTouchControlsVisible
                  : state.visible && state.userActive
              )
                ? ""
                : undefined
            }
          />
        )}
      >
        <Tooltip.Provider>
          <div className="media-surface media-controls media-controls--primary">
            <div className="media-button-group">
              <Tooltip.Root side="top">
                <Tooltip.Trigger
                  render={
                    <PlayButton className="media-button--play" render={<Button />}>
                      <RestartIcon className="media-icon media-icon--restart" />
                      <PlayIcon className="media-icon media-icon--play" />
                      <PauseIcon className="media-icon media-icon--pause" />
                    </PlayButton>
                  }
                />
                <Tooltip.Popup className="media-surface media-tooltip">
                  <Tooltip.Label />
                  <Tooltip.Shortcut className="media-tooltip__kbd" />
                </Tooltip.Popup>
              </Tooltip.Root>
              <VolumePopover />
            </div>

            <div className="media-time-controls">
              <Time.Value type="current" className="media-time" />
              <TimeSlider.Root
                className="media-slider"
                render={(props, sliderState) => (
                  <div {...props}>
                    <TimeSliderProgressSync
                      position={sliderState.dragging
                        ? sliderState.duration * sliderState.pointerPercent / 100
                        : sliderState.currentTime}
                      duration={sliderState.duration}
                      dragging={sliderState.dragging}
                      onProgress={onTimeSliderProgress}
                    />
                    <TimeSlider.Track className="media-slider__track">
                      <TimeSlider.Fill className="media-slider__fill" />
                      <TimeSlider.Buffer className="media-slider__buffer" />
                    </TimeSlider.Track>
                    <TimeSlider.Thumb className="media-slider__thumb" />
                    <div className="media-surface media-thumbnail media-slider__thumbnail">
                      <Slider.Thumbnail className="media-thumbnail__image" />
                      <TimeSlider.Value type="pointer" className="media-time media-thumbnail__time" />
                      <SpinnerIcon className="media-thumbnail__spinner media-icon" />
                    </div>
                    <TimeSlider.Preview className="media-slider__preview">
                      <TimeSlider.Value type="pointer" className="media-time media-slider__value" />
                    </TimeSlider.Preview>
                  </div>
                )}
              />
              <Time.Value toggle type="remaining" className="media-time" />
            </div>

            <div className="media-button-group">
              <Tooltip.Root side="top">
                <Tooltip.Trigger
                  render={
                    <CaptionsButton className="media-button--captions" render={<Button />}>
                      <CaptionsOffIcon className="media-icon media-icon--captions-off" />
                      <CaptionsOnIcon className="media-icon media-icon--captions-on" />
                    </CaptionsButton>
                  }
                />
                <Tooltip.Popup className="media-surface media-tooltip">
                  <Tooltip.Label />
                  <Tooltip.Shortcut className="media-tooltip__kbd" />
                </Tooltip.Popup>
              </Tooltip.Root>
              <SettingsMenu />
              {sidePanelControl ? (
                <SidePanelControl
                  active={sidePanelControl.active}
                  onToggle={sidePanelControl.onToggle}
                />
              ) : null}
              {nativeFullscreen ? (
                <NativeFullscreenControl active={nativeFullscreen.active} onToggle={nativeFullscreen.onToggle} />
              ) : null}
            </div>
          </div>

          {!nativeFullscreen ? (
            <div className="media-surface media-controls media-controls--secondary">
              <div className="media-button-group">
                <AirPlayControl />
                <FullscreenControl />
              </div>
            </div>
          ) : null}
        </Tooltip.Provider>
      </Controls.Root>

      <div className="media-overlay" />

      <Hotkey target="document" keys="Space" action="togglePaused" />
      <Hotkey target="document" keys="k" action="togglePaused" />
      <Hotkey target="document" keys="m" action="toggleMuted" />
      <Hotkey target="document" keys="f" action="toggleFullscreen" />
      <Hotkey target="document" keys="c" action="toggleSubtitles" />
      <Hotkey target="document" keys="i" action="togglePictureInPicture" />
      <Hotkey target="document" keys="ArrowRight" action="seekStep" value={SEEK_TIME / 2} />
      <Hotkey target="document" keys="ArrowLeft" action="seekStep" value={-(SEEK_TIME / 2)} />
      <Hotkey target="document" keys="l" action="seekStep" value={SEEK_TIME} />
      <Hotkey target="document" keys="j" action="seekStep" value={-SEEK_TIME} />
      <Hotkey target="document" keys="ArrowUp" action="volumeStep" value={0.05} />
      <Hotkey target="document" keys="ArrowDown" action="volumeStep" value={-0.05} />
      <Hotkey target="document" keys="0-9" action="seekToPercent" />
      <Hotkey target="document" keys="Home" action="seekToPercent" value={0} />
      <Hotkey target="document" keys="End" action="seekToPercent" value={100} />
      <Hotkey target="document" keys=">" action="speedUp" />
      <Hotkey target="document" keys="<" action="speedDown" />

      <StatusAnnouncer className="media-sr-only" />
      <div className="media-input-feedback">
        <VolumeIndicator.Root className="media-surface media-input-feedback-island media-input-feedback-island--volume">
          <VolumeIndicator.Fill className="media-input-feedback-island__content">
            <VolumeHighIcon className="media-icon media-icon--volume-high" />
            <VolumeLowIcon className="media-icon media-icon--volume-low" />
            <VolumeOffIcon className="media-icon media-icon--volume-off" />
            <VolumeIndicator.Value className="media-input-feedback-island__value" />
          </VolumeIndicator.Fill>
        </VolumeIndicator.Root>

        <StatusIndicator.Root
          actions={TOP_STATUS_ACTIONS}
          className="media-surface media-input-feedback-island media-input-feedback-island--status"
        >
          <div className="media-input-feedback-island__content">
            <CaptionsOnIcon className="media-icon media-icon--captions-on" />
            <CaptionsOffIcon className="media-icon media-icon--captions-off" />
            <FullscreenEnterIcon className="media-icon media-icon--fullscreen-enter" />
            <FullscreenExitIcon className="media-icon media-icon--fullscreen-exit" />
            <PipEnterIcon className="media-icon media-icon--pip-enter" />
            <PipExitIcon className="media-icon media-icon--pip-exit" />
            <StatusIndicator.Value className="media-input-feedback-island__value" />
          </div>
        </StatusIndicator.Root>

        <SeekIndicator.Root className="media-input-feedback-bubble">
          <ChevronIcon className="media-icon media-icon--seek" />
          <SeekIndicator.Value className="media-time" />
        </SeekIndicator.Root>

      </div>
      </div>
      {sidePanel ?? null}
    </Container>
  );
}
