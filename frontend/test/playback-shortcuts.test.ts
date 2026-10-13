import { expect, test } from "bun:test";
import { bindPlaybackShortcuts } from "../src/lib/playback-shortcuts";

function key(target: EventTarget, name: string, options: Record<string, unknown> = {}) {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: name, code: name === " " ? "Space" : name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false }, options);
  target.dispatchEvent(event);
  return event;
}

test("全局空格、方向键和监听器清理", () => {
  const target = new EventTarget();
  const actions: unknown[] = [];
  const cleanup = bindPlaybackShortcuts(target as Document, (...args) => actions.push(args));
  expect(key(target, " ").defaultPrevented).toBe(true);
  key(target, "ArrowRight");
  key(target, "ArrowLeft");
  key(target, " ", { repeat: true });
  expect(actions).toEqual([["togglePaused", "Space", undefined], ["seekStep", "ArrowRight", 5], ["seekStep", "ArrowLeft", -5]]);
  expect(key(target, "ArrowLeft", { ctrlKey: true }).defaultPrevented).toBe(false);
  cleanup();
  expect(key(target, " ").defaultPrevented).toBe(false);
});

test("输入框和输入法不触发播放快捷键", () => {
  class EditableTarget extends EventTarget { closest() { return this; } }
  const editor = new EditableTarget();
  const actions: unknown[] = [];
  const cleanup = bindPlaybackShortcuts(editor as unknown as Document, (...args) => actions.push(args));
  expect(key(editor, " ").defaultPrevented).toBe(false);
  expect(key(editor, "ArrowLeft").defaultPrevented).toBe(false);
  expect(actions).toEqual([]);
  cleanup();
  const target = new EventTarget();
  const stop = bindPlaybackShortcuts(target as Document, (...args) => actions.push(args));
  expect(key(target, " ", { isComposing: true }).defaultPrevented).toBe(false);
  expect(actions).toEqual([]);
  stop();
});
