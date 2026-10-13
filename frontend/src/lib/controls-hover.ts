// 持续悬停属于持续交互；使用官方锁保持可见，离开后恢复正常倒计时。
export function bindControlsHover(container: HTMLElement, requestLock: () => () => void) {
  let release: (() => void) | null = null;
  const inControls = (target: EventTarget | null) => {
    const controls = (target as Element | null)?.closest?.(".media-controls--root");
    return Boolean(controls && container.contains(controls));
  };
  const unlock = () => { release?.(); release = null; };
  const onOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (inControls(event.target)) release ??= requestLock();
    else unlock();
  };
  const onOut = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (!inControls(event.relatedTarget)) unlock();
  };
  container.addEventListener("pointerover", onOver);
  container.addEventListener("pointerout", onOut);
  return () => {
    container.removeEventListener("pointerover", onOver);
    container.removeEventListener("pointerout", onOut);
    unlock();
  };
}
