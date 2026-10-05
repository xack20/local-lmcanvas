// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { keyboardBranchPosition } from "./childPlacement.ts";
import { NODE_WIDTH, RIGHT_LANE_X_OFFSET, RIGHT_LANE_Y_OFFSET } from "./canvasConstants.ts";
import { resolveCollisions } from "./collisionResolution.ts";

const NODE_HEIGHT = 300;
const node = (id, position) => ({
  id,
  type: "custom",
  position,
  data: { chat: { messages: [], parentIds: [], childIds: [] } },
});

const overlaps = (a, b) =>
  a.position.x < b.position.x + NODE_WIDTH &&
  b.position.x < a.position.x + NODE_WIDTH &&
  a.position.y < b.position.y + NODE_HEIGHT &&
  b.position.y < a.position.y + NODE_HEIGHT;

describe("keyboardBranchPosition", () => {
  test("places the child in the right lane, clear of a full-width parent", () => {
    const position = keyboardBranchPosition(node("p", { x: 100, y: 200 }));
    expect(position).toEqual({ x: 100 + RIGHT_LANE_X_OFFSET, y: 200 + RIGHT_LANE_Y_OFFSET });
    expect(position.x - 100).toBeGreaterThan(NODE_WIDTH);
  });

  test("repeated presses never move the parent or leave nodes on top of each other", () => {
    const parent = node("p", { x: 0, y: 0 });
    let nodes = { p: parent };
    for (const id of ["c1", "c2", "c3"]) {
      nodes = { ...nodes, [id]: node(id, keyboardBranchPosition(nodes.p)) };
      const moves = resolveCollisions(id, nodes, () => NODE_HEIGHT, {
        fixedWidth: NODE_WIDTH,
        excludeIds: ["p"],
      });
      for (const [movedId, position] of Object.entries(moves)) {
        nodes = { ...nodes, [movedId]: { ...nodes[movedId], position } };
      }
    }
    expect(nodes.p.position).toEqual({ x: 0, y: 0 });
    const all = Object.values(nodes);
    for (const a of all) {
      for (const b of all) {
        if (a.id < b.id) expect(overlaps(a, b)).toBe(false);
      }
    }
  });
});
