import { Controls, Time, Tooltip, useHotkey } from '@videojs/react';
import type { ComponentProps } from 'react';
import { PanelRight } from 'lucide-react';
import { FullscreenEnterIcon, FullscreenExitIcon } from '@videojs/react/icons';
import { Button } from '@/components/videojs/ui/button';

import { AirPlayButton } from '@/components/videojs/ui/airplay-button';
import { ButtonTooltip } from '@/components/videojs/ui/button-tooltip';
import { CaptionsButton } from '@/components/videojs/ui/captions-button';
import { CastButton } from '@/components/videojs/ui/cast-button';
import { FullscreenButton } from '@/components/videojs/ui/fullscreen-button';
import { PiPButton } from '@/components/videojs/ui/pip-button';
import { PlayButton } from '@/components/videojs/ui/play-button';
import { TimeSlider } from '@/components/videojs/ui/time-slider';
import { VolumePopover } from '@/components/videojs/ui/volume-popover';
import { cn } from '@/lib/resolve-class-name';

import { VideoSettingsMenu } from '../menus/settings-menu';

export interface DefaultVideoControlsProps {
  renderThumbnail?: NonNullable<ComponentProps<typeof TimeSlider>>['renderThumbnail'];
  nativeFullscreen?: { active: boolean; onToggle: () => void };
  sidePanelControl?: { active: boolean; onToggle: () => void };
  onTimeSliderProgress?: (progress: { position: number; duration: number; dragging: boolean }) => void;
  touchVisible?: boolean | null;
  mobile?: boolean;
}

function NativeFullscreenControl({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  useHotkey({ keys: 'f', target: 'document', onActivate: onToggle });
  const label = active ? '退出全屏' : '进入全屏';
  return <ButtonTooltip side="top" label={label}>
    <Button className="media-fullscreen-button" aria-label={label} onClick={onToggle}>
      {active ? <FullscreenExitIcon className="media-button-icon" /> : <FullscreenEnterIcon className="media-button-icon" />}
    </Button>
  </ButtonTooltip>;
}

function SidePanelControl({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  useHotkey({ keys: 's', target: 'document', onActivate: onToggle });
  const label = active ? '关闭播放器侧栏' : '打开播放器侧栏';
  return <ButtonTooltip side="top" label={label}>
    <Button aria-label={label} aria-pressed={active} onClick={onToggle}>
      <PanelRight className="media-button-icon" />
    </Button>
  </ButtonTooltip>;
}

export function DefaultVideoControls({ renderThumbnail, nativeFullscreen, sidePanelControl, onTimeSliderProgress, touchVisible, mobile = false }: DefaultVideoControlsProps = {}) {
  const fullscreenControl = nativeFullscreen ? <NativeFullscreenControl {...nativeFullscreen} /> : <ButtonTooltip side="top"><FullscreenButton /></ButtonTooltip>;
  const visible = (state: { visible: boolean; userActive: boolean }) => touchVisible ?? (state.visible && (!mobile || state.userActive));
  return (
    <Controls.Root>
      <Controls.Backdrop className={'video-controls-backdrop'} render={(props, state) => <div {...props} data-visible={visible(state) ? '' : undefined} />} />
      <Controls.Content className={cn('video-controls', 'video-controls-content', 'media-controls--root')}
        render={(props, state) => <div {...props} data-visible={visible(state) ? '' : undefined} />}>
        <Tooltip.Provider>
          <Controls.Group className={'video-controls-primary'}>
            <ButtonTooltip side="top">
              <PlayButton />
            </ButtonTooltip>
            <VolumePopover className={'video-controls-volume-button'} />

            <Controls.Group className={'video-time-slider-group'}>
              <Time.Value className={cn('media-time-value', 'video-time-value')} type="current" />
              <TimeSlider renderThumbnail={renderThumbnail} onProgress={onTimeSliderProgress} />
              <Time.Value className={cn('media-time-toggle', 'video-time-value')} type="remaining" toggle />
            </Controls.Group>

            <ButtonTooltip side="top">
              <CaptionsButton className={'video-controls-captions-button'} />
            </ButtonTooltip>
            <VideoSettingsMenu className={'video-controls-settings-button'} />
            {mobile && fullscreenControl}
          </Controls.Group>

          <Controls.Group className={'video-controls-secondary'}>
            <ButtonTooltip side="top">
              <CastButton />
            </ButtonTooltip>
            <ButtonTooltip side="top">
              <AirPlayButton />
            </ButtonTooltip>
            <ButtonTooltip side="top">
              <PiPButton />
            </ButtonTooltip>
            {!mobile && fullscreenControl}
            {sidePanelControl && <SidePanelControl {...sidePanelControl} />}
          </Controls.Group>
        </Tooltip.Provider>
      </Controls.Content>
    </Controls.Root>
  );
}
