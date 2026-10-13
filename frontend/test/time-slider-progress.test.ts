import { expect, test } from "bun:test";
import { getTimeSliderFillOverride } from "../src/lib/time-slider-progress";

test("连续快进退期间进度条跟随最新目标", () => {
  for (const [currentTime, percent] of [[20, "16.667%"], [25, "20.833%"], [30, "25.000%"], [25, "20.833%"]] as const) {
    expect(getTimeSliderFillOverride({ currentTime, duration: 120, dragging: false }, "12.5%")).toBe(percent);
  }
});

test("正常播放和拖动使用组件自身进度，未知时长不补写", () => {
  expect(getTimeSliderFillOverride({ currentTime: 15, duration: 120, dragging: false }, "12.5%")).toBeUndefined();
  expect(getTimeSliderFillOverride({ currentTime: 20, duration: 120, dragging: true }, "12.5%")).toBeUndefined();
  expect(getTimeSliderFillOverride({ currentTime: 20, duration: 0, dragging: false }, "0%")).toBeUndefined();
});
