import type { TimeSliderState } from "@videojs/core";

// 连续 seek 时组件可能保留首次目标；视觉进度应跟随时间状态中的最新目标。
export function getTimeSliderFillOverride(state: Pick<TimeSliderState, "currentTime" | "duration" | "dragging">, visualFill: string | number | undefined) {
  if (state.dragging || !Number.isFinite(state.duration) || state.duration <= 0 || !Number.isFinite(state.currentTime)) return undefined;
  const percent = Math.max(0, Math.min(100, state.currentTime / state.duration * 100));
  const visualPercent = Number.parseFloat(String(visualFill));
  return Number.isFinite(visualPercent) && Math.abs(percent - visualPercent) > 0.001 ? `${percent.toFixed(3)}%` : undefined;
}
