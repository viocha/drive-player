const BLOCK_BYTES = 16 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_BLOCKS = 512;

// 当前提取任务共享读取缓存；只请求有限区间，支持代理返回已缓存的前缀。
export function createVideoByteReader(src: string, size: number, signal: AbortSignal, request: typeof fetch = fetch) {
  const blocks = new Map<number, Uint8Array>();
  const pending = new Map<number, Promise<void>>();
  return async (start: number, end: number) => {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > size || end <= start) throw new Error("视频读取区间无效");
    const output = new Uint8Array(end - start);
    let offset = start;
    while (offset < end) {
      signal.throwIfAborted();
      const base = Math.floor(offset / BLOCK_BYTES) * BLOCK_BYTES;
      if (!blocks.has(base)) {
        if (!pending.has(base)) {
          const readAhead = base === 0 ? BLOCK_BYTES : 64 * 1024;
          let limit = Math.min(size, Math.ceil(Math.max(end, base + readAhead) / BLOCK_BYTES) * BLOCK_BYTES, base + MAX_READ_BYTES);
          for (let next = base + BLOCK_BYTES; next < limit; next += BLOCK_BYTES) {
            if (blocks.has(next) || pending.has(next)) { limit = next; break; }
          }
          const job = readRange(src, size, base, limit, signal, request).then(data => {
            for (let cursor = base; cursor < limit; cursor += BLOCK_BYTES) blocks.set(cursor, data.slice(cursor - base, cursor - base + BLOCK_BYTES));
            while (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value!);
          }).finally(() => {
            for (let cursor = base; cursor < limit; cursor += BLOCK_BYTES) pending.delete(cursor);
          });
          for (let cursor = base; cursor < limit; cursor += BLOCK_BYTES) pending.set(cursor, job);
        }
        await pending.get(base);
      }
      const block = blocks.get(base)!;
      blocks.delete(base); blocks.set(base, block);
      const length = Math.min(end - offset, block.length - (offset - base));
      output.set(block.subarray(offset - base, offset - base + length), offset - start);
      offset += length;
    }
    signal.throwIfAborted();
    return output;
  };
}

async function readRange(src: string, size: number, start: number, end: number, signal: AbortSignal, request: typeof fetch) {
  const output = new Uint8Array(end - start);
  let offset = start;
  while (offset < end) {
    signal.throwIfAborted();
    const response = await request(src, { headers: { Range: `bytes=${offset}-${end - 1}` }, cache: "no-store", signal });
    const range = response.headers.get("Content-Range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (response.status !== 206 || !range || !response.body || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[2]) >= end || Number(range[3]) !== size) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("视频服务器未返回有效 Range 数据");
    }
    const expected = Number(range[2]) - offset + 1;
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (received < expected) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done || received + value.length > expected) throw new Error("视频响应长度无效");
        output.set(value, offset - start + received);
        received += value.length;
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    offset += received;
  }
  return output;
}
