// 保留原始分辨率，以异步 PNG 编码和异步读取替代同步 toDataURL。
export function encodeCanvasPNG(canvas: HTMLCanvasElement, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let reader: FileReader | null = null;
    const finish = (error?: unknown, data?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(data!);
    };
    const abort = () => {
      finish(new DOMException("截图编码已取消", "AbortError"));
      reader?.abort();
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    try {
      canvas.toBlob((blob) => {
        if (settled) return;
        if (!blob) { finish(new Error("PNG 编码失败")); return; }
        reader = new FileReader();
        reader.onload = () => finish(undefined, String(reader!.result));
        reader.onerror = () => finish(reader!.error ?? new Error("PNG 读取失败"));
        reader.readAsDataURL(blob);
      }, "image/png");
    } catch (error) { finish(error); }
  });
}
