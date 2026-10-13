import { expect, test } from "bun:test";
import type { FileEntry } from "../bindings/drive-player";
import { reconcileDirectoryEntries } from "../src/lib/directory-refresh";

const file = (path: string, size = 100): FileEntry => ({ path, name: path.slice(1), size, modifiedAt: "2026-10-14", isDirectory: false, contentType: "video/mp4" });

test("目录无变化时保留列表和条目引用", () => {
  const previous = [file("/a.mp4"), file("/b.mp4")];
  const result = reconcileDirectoryEntries(previous, previous.map((entry) => ({ ...entry })));
  expect(result.entries).toBe(previous);
  expect(result.changedMediaPaths.size).toBe(0);
});

test("增删与内容变化只影响对应条目", () => {
  const previous = [file("/a.mp4"), file("/b.mp4"), file("/deleted.mp4")];
  const result = reconcileDirectoryEntries(previous, [file("/a.mp4"), file("/b.mp4", 200), file("/new.mp4")]);
  expect(result.entries[0]).toBe(previous[0]);
  expect(result.entries[1]).not.toBe(previous[1]);
  expect([...result.changedMediaPaths]).toEqual(["/b.mp4", "/new.mp4"]);
  expect(result.entries.map((entry) => entry.path)).toEqual(["/a.mp4", "/b.mp4", "/new.mp4"]);
});
