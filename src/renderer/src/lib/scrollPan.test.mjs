// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { keepSidewaysScroll } from "./scrollPan.ts";

/** A wheel event over a code area 300px wide showing 1000px of code, scrolled to `scrollLeft`. */
function wheel({ deltaX = 0, deltaY = 0, ctrlKey = false, scrollLeft = 0, scrollWidth = 1000 }) {
  const event = {
    deltaX,
    deltaY,
    ctrlKey,
    currentTarget: { scrollLeft, clientWidth: 300, scrollWidth },
    stopped: false,
    stopPropagation() {
      event.stopped = true;
    },
  };
  return event;
}

describe("keepSidewaysScroll", () => {
  test("a sideways scroll stays in code that can still scroll that way", () => {
    const right = wheel({ deltaX: 40, deltaY: 2 });
    keepSidewaysScroll(right);
    expect(right.stopped).toBe(true);

    const left = wheel({ deltaX: -40, scrollLeft: 200 });
    keepSidewaysScroll(left);
    expect(left.stopped).toBe(true);
  });

  test("an up or down scroll over code moves the canvas", () => {
    const down = wheel({ deltaX: 3, deltaY: 50, scrollLeft: 200 });
    keepSidewaysScroll(down);
    expect(down.stopped).toBe(false);
  });

  test("a sideways scroll moves the canvas once the code is at that edge, or fits", () => {
    const atLeftEdge = wheel({ deltaX: -40, scrollLeft: 0 });
    keepSidewaysScroll(atLeftEdge);
    expect(atLeftEdge.stopped).toBe(false);

    const atRightEdge = wheel({ deltaX: 40, scrollLeft: 700 });
    keepSidewaysScroll(atRightEdge);
    expect(atRightEdge.stopped).toBe(false);

    const fits = wheel({ deltaX: 40, scrollWidth: 300 });
    keepSidewaysScroll(fits);
    expect(fits.stopped).toBe(false);
  });

  test("a trackpad pinch over code zooms the canvas", () => {
    const pinch = wheel({ deltaX: 40, ctrlKey: true });
    keepSidewaysScroll(pinch);
    expect(pinch.stopped).toBe(false);
  });
});
