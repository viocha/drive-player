import { useLayoutEffect, useRef, useState } from "react";
import { fileTitleClassName } from "@/lib/file-title";
import { cn } from "@/lib/utils";

export function TruncatedName({ name, lines = 1, className }: { name: string; lines?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setTruncated(element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", update);
    return () => { observer.disconnect(); document.fonts.removeEventListener("loadingdone", update); };
  }, [name, lines]);

  return <span ref={ref} className={cn("w-fit max-w-full", fileTitleClassName(lines), className)} title={truncated ? name : undefined}>{name}</span>;
}
