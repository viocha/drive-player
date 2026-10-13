import type { FileEntry } from "../../bindings/drive-player";

// 保留未改变条目的引用和顺序，只替换有变化的数据。
export function reconcileDirectoryEntries(previous: FileEntry[], incoming: FileEntry[]) {
  const byPath = new Map(previous.map((entry) => [entry.path, entry]));
  const changedMediaPaths = new Set<string>();
  const entries = incoming.map((entry) => {
    const cached = byPath.get(entry.path);
    if (!cached || cached.modifiedAt !== entry.modifiedAt || cached.size !== entry.size || cached.contentType !== entry.contentType || cached.isDirectory !== entry.isDirectory) {
      changedMediaPaths.add(entry.path);
    }
    return cached && cached.name === entry.name && !changedMediaPaths.has(entry.path) ? cached : entry;
  });
  const unchanged = entries.length === previous.length && entries.every((entry, index) => entry === previous[index]);
  return { entries: unchanged ? previous : entries, changedMediaPaths };
}
