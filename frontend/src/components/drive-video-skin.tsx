import {
  type CSSProperties,
  type ComponentProps,
  forwardRef,
  type PropsWithChildren,
  type ReactNode,
  useEffect,
} from "react";
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
  CastEnterIcon,
  CastExitIcon,
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
  CastButton,
  Container,
  Controls,
  ErrorDialog,
  FullscreenButton,
  Gesture,
  Hotkey,
  Menu,
  MuteButton,
  PiPButton,
  PlayButton,
  usePlaybackRateOptions,
  Popover,
  useQualityOptions,
  SeekIndicator,
  Slider,
  StatusAnnouncer,
  StatusIndicator,
  Time,
  TimeSlider,
  Tooltip,
  usePlayer,
  useTranslator,
  VolumeIndicator,
  VolumeSlider,
} from "@videojs/react";

const TOP_STATUS_ACTIONS = ["toggleSubtitles", "toggleFullscreen", "togglePictureInPicture"] as const;
const SEEK_TIME = 10;

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

function CastControl() {
  return (
    <Tooltip.Root side="top">
      <Tooltip.Trigger
        render={
          <CastButton className="media-button--cast" render={<Button />}>
            <CastEnterIcon className="media-icon media-icon--cast-enter" />
            <CastExitIcon className="media-icon media-icon--cast-exit" />
          </CastButton>
        }
      />
      <Tooltip.Popup className="media-surface media-tooltip">
        <Tooltip.Label />
        <Tooltip.Shortcut className="media-tooltip__kbd" />
      </Tooltip.Popup>
    </Tooltip.Root>
  );
}

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

function PiPControl() {
  return (
    <Tooltip.Root side="top">
      <Tooltip.Trigger
        render={
          <PiPButton className="media-button--pip" render={<Button />}>
            <PipEnterIcon className="media-icon media-icon--pip-enter" />
            <PipExitIcon className="media-icon media-icon--pip-exit" />
          </PiPButton>
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
  nativeFullscreen?: {
    active: boolean;
    onToggle: () => void;
  };
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

/**
 * Ejected from the Video.js v10 default React video skin so the application's
 * gesture semantics are explicit instead of overriding preset behavior later.
 */
export function DriveVideoSkin({
  children,
  className,
  style,
  nativeFullscreen,
  onTimeSliderProgress,
}: DriveVideoSkinProps): ReactNode {
  return (
    <Container className={`media-default-skin media-default-skin--video ${className ?? ""}`} style={style}>
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

      <Controls.Root className="media-surface media-controls media-controls--root">
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
              {nativeFullscreen ? (
                <NativeFullscreenControl active={nativeFullscreen.active} onToggle={nativeFullscreen.onToggle} />
              ) : null}
            </div>
          </div>

          {!nativeFullscreen ? (
            <div className="media-surface media-controls media-controls--secondary">
              <div className="media-button-group">
                <CastControl />
                <AirPlayControl />
                <PiPControl />
                <FullscreenControl />
              </div>
            </div>
          ) : null}
        </Tooltip.Provider>
      </Controls.Root>

      <div className="media-overlay" />

      <Hotkey keys="Space" action="togglePaused" />
      <Hotkey keys="k" action="togglePaused" />
      <Hotkey keys="m" action="toggleMuted" />
      <Hotkey keys="f" action="toggleFullscreen" />
      <Hotkey keys="c" action="toggleSubtitles" />
      <Hotkey keys="i" action="togglePictureInPicture" />
      <Hotkey keys="ArrowRight" action="seekStep" value={SEEK_TIME / 2} />
      <Hotkey keys="ArrowLeft" action="seekStep" value={-(SEEK_TIME / 2)} />
      <Hotkey keys="l" action="seekStep" value={SEEK_TIME} />
      <Hotkey keys="j" action="seekStep" value={-SEEK_TIME} />
      <Hotkey keys="ArrowUp" action="volumeStep" value={0.05} />
      <Hotkey keys="ArrowDown" action="volumeStep" value={-0.05} />
      <Hotkey keys="0-9" action="seekToPercent" />
      <Hotkey keys="Home" action="seekToPercent" value={0} />
      <Hotkey keys="End" action="seekToPercent" value={100} />
      <Hotkey keys=">" action="speedUp" />
      <Hotkey keys="<" action="speedDown" />

      <Gesture type="tap" action="togglePaused" pointer="mouse" region="center" />
      <Gesture type="tap" action="toggleControls" pointer="touch" />
      <Gesture type="doubletap" action="seekStep" value={-SEEK_TIME} region="left" />
      {/* Application policy: center double-tap toggles playback, not fullscreen. */}
      <Gesture type="doubletap" action="togglePaused" region="center" />
      <Gesture type="doubletap" action="seekStep" value={SEEK_TIME} region="right" />

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
    </Container>
  );
}
