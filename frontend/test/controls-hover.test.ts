import { expect, test } from "bun:test";
import { bindControlsHover } from "../src/lib/controls-hover";

test("鼠标停留及控件之间移动保持同一个锁，离开和销毁释放", () => {
  const controls = {};
  const first = { closest: () => controls };
  const second = { closest: () => controls };
  const surface = { closest: () => null };
  const container = Object.assign(new EventTarget(), { contains: (element: unknown) => element === controls });
  let locks = 0;
  let releases = 0;
  const cleanup = bindControlsHover(container as unknown as HTMLElement, () => { locks++; return () => { releases++; }; });
  const send = (type: string, target: unknown, relatedTarget: unknown, pointerType = "mouse") => {
    const event = Object.assign(new Event(type), { pointerType, relatedTarget });
    Object.defineProperty(event, "target", { value: target });
    container.dispatchEvent(event);
  };
  send("pointerover", first, surface, "touch");
  expect(locks).toBe(0);
  send("pointerover", first, surface);
  send("pointerout", first, second);
  send("pointerover", second, first);
  expect(locks).toBe(1);
  expect(releases).toBe(0);
  send("pointerout", second, surface);
  expect(releases).toBe(1);
  send("pointerover", first, surface);
  cleanup();
  expect(releases).toBe(2);
  send("pointerover", first, surface);
  expect(locks).toBe(2);
});
