// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterEach, describe, expect, test } from "bun:test";
import { makeLiveHeightMeasurer } from "./collisionResolution.ts";

afterEach(() => {
  delete globalThis.document;
});

describe("makeLiveHeightMeasurer", () => {
  test("uses the zoom at the moment of measuring, not when it was made", () => {
    // A node 600 px tall in flow units, drawn on screen at the current zoom.
    let zoom = 1;
    globalThis.document = {
      querySelector: () => ({ getBoundingClientRect: () => ({ height: 600 * zoom }) }),
    };
    const measure = makeLiveHeightMeasurer(() => zoom);

    expect(measure("a")).toBe(600);
    zoom = 0.5;
    expect(measure("a")).toBe(600);
  });
});
