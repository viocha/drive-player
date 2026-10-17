// 取消时立即结束等待，同时接住底层任务的迟到结果与错误。
export async function withAbortSignal<T>(signal: AbortSignal, operation: () => T | PromiseLike<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export async function withTimeout<T>(signal: AbortSignal, timeoutMS: number, operation: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const taskSignal = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new DOMException("视频预览加载超时", "TimeoutError")), timeoutMS);
  try { return await withAbortSignal(taskSignal, () => operation(taskSignal)); }
  finally { clearTimeout(timer); }
}

export function withCancellableRequest<T>(signal: AbortSignal, start: () => PromiseLike<T> & { cancel: (reason?: unknown) => unknown }) {
  return withAbortSignal(signal, async () => {
    const request = start();
    const cancel = () => { void Promise.resolve(request.cancel(signal.reason)).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try { return await request; }
    finally { signal.removeEventListener("abort", cancel); }
  });
}
