// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { widthFitViewport } from "./widthFitViewport.ts";

const VISIBLE = { width: 1200, height: 800 };
const ZOOM = { min: 0.1, max: 1 };
const node = (x, y, width = 1100, height = 300) => ({ x, y, width, height });

const screenLeft = (vp, x) => x * vp.zoom + vp.x;
const screenTop = (vp, y) => y * vp.zoom + vp.y;

describe("widthFitViewport", () => {
  test("returns null for an empty canvas", () => {
    expect(widthFitViewport([], VISIBLE, ZOOM)).toBeNull();
  });

  test("fits a single full-width node to the window width, horizontally centred", () => {
    const vp = widthFitViewport([node(0, 0)], VISIBLE, ZOOM);
    const left = screenLeft(vp, 0);
    const right = screenLeft(vp, 1100);
    expect(right - left).toBeGreaterThan(VISIBLE.width * 0.85);
    expect(right).toBeLessThanOrEqual(VISIBLE.width);
    expect(Math.abs(left - (VISIBLE.width - right))).toBeLessThan(1);
  });

  test("centres a short chat vertically", () => {
    const vp = widthFitViewport([node(0, 0, 1100, 200)], VISIBLE, ZOOM);
    const top = screenTop(vp, 0);
    const bottom = screenTop(vp, 200);
    expect(Math.abs(top - (VISIBLE.height - bottom))).toBeLessThan(1);
  });

  test("starts a tall chat at the top instead of shrinking it to fit the height", () => {
    const tall = [node(0, 0, 1100, 1500), node(0, 1650, 1100, 1500)];
    const vp = widthFitViewport(tall, VISIBLE, ZOOM);
    expect(1100 * vp.zoom).toBeGreaterThan(VISIBLE.width * 0.85);
    expect(screenTop(vp, 0)).toBeGreaterThan(0);
    expect(screenTop(vp, 0)).toBeLessThan(100);
  });

  test("fits side-by-side branches across the width", () => {
    const branched = [node(0, 0), node(1200, 400)];
    const vp = widthFitViewport(branched, VISIBLE, ZOOM);
    expect(screenLeft(vp, 0)).toBeGreaterThanOrEqual(0);
    expect(screenLeft(vp, 2300)).toBeLessThanOrEqual(VISIBLE.width);
  });

  test("never zooms in past the max or out past the min", () => {
    expect(widthFitViewport([node(0, 0, 300)], VISIBLE, ZOOM).zoom).toBe(1);
    expect(widthFitViewport([node(0, 0), node(50000, 0)], VISIBLE, ZOOM).zoom).toBe(0.1);
  });
});
