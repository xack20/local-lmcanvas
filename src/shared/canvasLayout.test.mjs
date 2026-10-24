// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { layoutCanvas } from "./canvasLayout.ts";

const GAP = { x: 100, y: 80 };
const WIDTH = 1100;
const PITCH = WIDTH + GAP.x;

function node(id, parentIds, createdAt, position = { x: 0, y: 0 }) {
  return {
    id,
    type: "custom",
    position,
    data: { chat: { parentIds, childIds: [], messages: [{ id: `${id}-u`, role: "user", createdAt, blocks: [{ type: "text", text: id }] }] } },
  };
}
const sticky = { id: "s", type: "stickyNote", position: { x: 7, y: 7 }, data: { stickyText: "note", chat: { parentIds: [], childIds: [], messages: [] } } };

function layout(nodes, plan = {}, heights = {}) {
  const sizeOf = (n) => ({ width: WIDTH, height: heights[n.id] ?? 300 });
  const positions = layoutCanvas(nodes, plan, sizeOf, GAP);
  expectNoOverlap(positions, (id) => heights[id] ?? 300);
  return positions;
}

function expectNoOverlap(positions, heightOf) {
  const rects = Object.entries(positions).map(([id, p]) => ({ id, ...p, h: heightOf(id) }));
  for (const a of rects) {
    for (const b of rects) {
      if (a.id >= b.id) continue;
      const overlaps = a.x < b.x + WIDTH && b.x < a.x + WIDTH && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlaps ? `${a.id} overlaps ${b.id}` : "").toBe("");
    }
  }
}

describe("layoutCanvas", () => {
  test("a single line stacks downward with the gap and no overlap", () => {
    const positions = layout([node("a", [], 1), node("b", ["a"], 2), node("c", ["b"], 3)]);
    expect(positions).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 380 }, c: { x: 0, y: 760 } });
  });

  test("a deep dive goes in the next column right, level with its branch point; off-topic goes left", () => {
    const nodes = [node("r", [], 1), node("m", ["r"], 2), node("d", ["r"], 3), node("o", ["r"], 4)];
    const positions = layout(nodes, { r: { next: "m" }, d: { kind: "deep-dive" }, o: { kind: "off-topic" } });
    expect(positions.m).toEqual({ x: 0, y: 380 });
    expect(positions.d).toEqual({ x: PITCH, y: 0 });
    expect(positions.o).toEqual({ x: -PITCH, y: 0 });
  });

  test("a branch whose column is taken at that height moves to the next free column", () => {
    const nodes = [
      node("r", [], 1), node("a", ["r"], 2), node("b", ["a"], 3),
      node("d1", ["r"], 4), node("d1c", ["d1"], 5),
      node("d2", ["a"], 6),
    ];
    const positions = layout(nodes, { d1: { kind: "deep-dive" }, d2: { kind: "deep-dive" } });
    expect(positions.d1).toEqual({ x: PITCH, y: 0 });
    expect(positions.d1c).toEqual({ x: PITCH, y: 380 });
    expect(positions.d2).toEqual({ x: 2 * PITCH, y: 380 });
  });

  test("plan.next picks which child continues; without it the oldest non-side child does", () => {
    const nodes = [node("r", [], 1), node("c1", ["r"], 2), node("c2", ["r"], 3)];
    expect(layout(nodes, { r: { next: "c2" } })).toMatchObject({ c2: { x: 0, y: 380 }, c1: { x: PITCH, y: 0 } });
    expect(layout(nodes)).toMatchObject({ c1: { x: 0, y: 380 }, c2: { x: PITCH, y: 0 } });
    expect(layout(nodes, { c1: { kind: "deep-dive" } })).toMatchObject({ c2: { x: 0, y: 380 }, c1: { x: PITCH, y: 0 } });
  });

  test("an only child marked deep-dive starts a new column", () => {
    const positions = layout([node("r", [], 1), node("k", ["r"], 2)], { k: { kind: "deep-dive" } });
    expect(positions.k).toEqual({ x: PITCH, y: 0 });
  });

  test("several roots sit side by side with no overlap between trees", () => {
    const nodes = [node("r1", [], 1), node("dd", ["r1"], 2), node("r2", [], 10), node("r2c", ["r2"], 11)];
    const positions = layout(nodes, { dd: { kind: "deep-dive" } });
    expect(positions.r2).toEqual({ x: 2 * PITCH, y: 0 });
    expect(positions.r2c).toEqual({ x: 2 * PITCH, y: 380 });
  });

  test("a later tree's off-topic branch stays right of the earlier tree, never inside it", () => {
    const nodes = [
      node("r1", [], 1), node("m1", ["r1"], 2), node("m2", ["m1"], 3), node("dd", ["m2"], 4),
      node("r2", [], 10), node("c2", ["r2"], 11), node("o2", ["r2"], 12),
    ];
    const positions = layout(nodes, { dd: { kind: "deep-dive" }, o2: { kind: "off-topic" } });
    const rightmostOfTree1 = Math.max(...["r1", "m1", "m2", "dd"].map((id) => positions[id].x));
    for (const id of ["r2", "c2", "o2"]) expect(positions[id].x).toBeGreaterThan(rightmostOfTree1);
    expect(positions.o2.x).toBeLessThan(positions.r2.x);
  });

  test("a cycle or a missing first parent still places every chat node exactly once", () => {
    const nodes = [node("a", ["b"], 1), node("b", ["a"], 2), node("c", ["missing"], 3), node("self", ["self"], 4)];
    const positions = layout(nodes);
    expect(Object.keys(positions).sort()).toEqual(["a", "b", "c", "self"]);
  });

  test("sticky notes get no position, and the same input gives the same output", () => {
    const nodes = [node("r", [], 1, { x: 40, y: -20 }), node("k", ["r"], 2), sticky];
    const first = layout(nodes);
    expect(first.s).toBeUndefined();
    expect(first.r).toEqual({ x: 40, y: -20 });
    expect(layout(nodes)).toEqual(first);
  });

  test("nodes of different widths are spaced by the widest and never overlap", () => {
    const widths = { r: 600, a: 1100, d: 900 };
    const nodes = [node("r", [], 1), node("a", ["r"], 2), node("d", ["r"], 3)];
    const positions = layoutCanvas(nodes, { d: { kind: "deep-dive" } }, (n) => ({ width: widths[n.id], height: 300 }), GAP);

    expect(positions.d.x - positions.r.x).toBe(1100 + GAP.x);
    const rects = Object.entries(positions).map(([id, p]) => ({ id, ...p, w: widths[id] }));
    for (const a of rects) {
      for (const b of rects) {
        if (a.id < b.id) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + 300 && b.y < a.y + 300).toBe(false);
      }
    }
  });

  test("a tall node pushes the nodes below it down", () => {
    const positions = layout([node("a", [], 1), node("b", ["a"], 2)], {}, { a: 900 });
    expect(positions.b).toEqual({ x: 0, y: 980 });
  });
});
