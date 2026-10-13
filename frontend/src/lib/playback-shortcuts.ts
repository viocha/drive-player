type PlaybackAction = "togglePaused" | "seekStep";

// 捕获阶段优先处理播放按键，避免侧栏按钮和 Tabs 消费空格、方向键。
export function bindPlaybackShortcuts(target: Document, activate: (action: PlaybackAction, key: string, value?: number) => void) {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const element = event.target as Element | null;
    if (element?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    const paused = event.code === "Space" || event.key === " ";
    const seek = event.key === "ArrowLeft" ? -5 : event.key === "ArrowRight" ? 5 : undefined;
    if (!paused && seek === undefined) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (paused && event.repeat) return;
    activate(paused ? "togglePaused" : "seekStep", paused ? "Space" : event.key, seek);
  };
  target.addEventListener("keydown", handleKeyDown, true);
  return () => target.removeEventListener("keydown", handleKeyDown, true);
}
