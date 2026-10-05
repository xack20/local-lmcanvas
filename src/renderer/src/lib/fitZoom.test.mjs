// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { fitZoom } from "./fitZoom.ts";

describe("fitZoom", () => {
  test("keeps the requested zoom when the node already fits", () => {
    expect(fitZoom(1.5, 450, 1200)).toBe(1.5);
  });

  test("zooms out so a wide node fits the visible width with a margin", () => {
    const zoom = fitZoom(1.5, 1100, 1200);
    expect(zoom).toBeLessThan(1.5);
    expect(1100 * zoom).toBeLessThanOrEqual(1200);
    expect(1100 * zoom).toBeGreaterThan(1200 * 0.85);
  });

  test("never zooms in past the requested zoom", () => {
    expect(fitZoom(0.8, 300, 3000)).toBe(0.8);
  });

  test.each([
    [0, 1200],
    [1100, 0],
    [-5, 1200],
  ])("falls back to the requested zoom for unusable sizes (%p, %p)", (width, visible) => {
    expect(fitZoom(1.5, width, visible)).toBe(1.5);
  });
});
