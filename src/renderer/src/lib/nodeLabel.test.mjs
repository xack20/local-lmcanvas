// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { NODE_LABEL_HIDE_ZOOM, nodeLabelFontSize, nodeLabelReach } from "./nodeLabel.ts";
import { NODE_BOTTOM_CONTROLS_HANG, ORGANIZE_GAP_Y } from "./canvasConstants.ts";

describe("zoomed-out node labels", () => {
  test("keep a readable size on screen, so they take more canvas space the further you zoom out", () => {
    expect(nodeLabelFontSize(1)).toBe(11);
    expect(nodeLabelFontSize(0.25)).toBe(44);
    expect(nodeLabelFontSize(2)).toBe(8);
  });

  test("the organize gap leaves room for a label above every node at the furthest zoom labels show", () => {
    // Just above the zoom where labels hide, on a node with a quote banner, under a node whose
    // buttons hang below it: the label must still clear the node above.
    const furthest = NODE_LABEL_HIDE_ZOOM + 0.001;
    expect(nodeLabelReach(furthest, true) + NODE_BOTTOM_CONTROLS_HANG).toBeLessThanOrEqual(ORGANIZE_GAP_Y);
  });
});
