import { Play } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Spinner } from "@/components/ui/spinner";

export function VideoCover({ src, name, refreshing, previewWidth, previewDelayMS }: {
  src?: string; name: string; refreshing: boolean; previewWidth: number; previewDelayMS: number;
}) {
  const cover = <span className="relative flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted sm:h-14 sm:w-24">
    {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : <Play className="size-4" />}
    {refreshing && <span className="absolute inset-0 flex items-center justify-center bg-background/60"><Spinner aria-label="正在刷新封面" className="size-5" /></span>}
  </span>;
  if (!src || !previewWidth) return cover;
  return <HoverCard>
    <HoverCardTrigger render={cover} delay={previewDelayMS} closeDelay={0} />
    <HoverCardContent side="right" align="start" sideOffset={8} className="w-auto max-w-(--available-width) animate-none! p-1" style={{ width: previewWidth }} onClick={(event) => event.stopPropagation()}>
      <img src={src} alt={`${name} 封面预览`} className="max-h-[min(70dvh,var(--available-height))] w-full rounded-md object-contain" />
    </HoverCardContent>
  </HoverCard>;
}
