import { expect, test } from "bun:test";
import { withAbortSignal, withCancellableRequest, withTimeout } from "../src/lib/abortable-task";

test("总超时中止子任务，即使底层 Promise 不响应取消也结束等待", async () => {
  const late = Promise.withResolvers<string>();
  let taskSignal!: AbortSignal;
  await expect(withTimeout(new AbortController().signal, 5, signal => {
    taskSignal = signal;
    return late.promise;
  })).rejects.toMatchObject({ name: "TimeoutError" });
  expect(taskSignal.aborted).toBe(true);
  late.reject(new Error("迟到的错误"));
  await new Promise(resolve => setImmediate(resolve));
});

test("任务开始前取消不会启动操作，运行中取消保留原因", async () => {
  const controller = new AbortController();
  const reason = new DOMException("目录已切换", "AbortError");
  let started = false;
  controller.abort(reason);
  await expect(withAbortSignal(controller.signal, () => { started = true; })).rejects.toBe(reason);
  expect(started).toBe(false);

  const active = new AbortController();
  const entered = Promise.withResolvers<void>();
  const job = withTimeout(active.signal, 30_000, () => { entered.resolve(); return new Promise(() => {}); });
  await entered.promise;
  active.abort(reason);
  await expect(job).rejects.toBe(reason);
});

test("取消调用底层 cancel，结束后的任务不再被取消", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<number>();
  let cancelled = 0;
  const job = withCancellableRequest(controller.signal, () => {
    entered.resolve();
    return Object.assign(pending.promise, { cancel() { cancelled++; pending.reject(new Error("调用已取消")); } });
  });
  await entered.promise;
  controller.abort();
  await expect(job).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toBe(1);

  const completed = new AbortController();
  expect(await withCancellableRequest(completed.signal, () => Object.assign(Promise.resolve(42), { cancel() { cancelled++; } }))).toBe(42);
  completed.abort();
  expect(cancelled).toBe(1);
});
