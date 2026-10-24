// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { decideOrganizeRequest } from "./organizeRequest.ts";

const pane = (extra = {}) => ({ paneCanvasId: "c1", shownCanvasId: "c1", loaded: true, error: null, lock: "held", ...extra });

describe("decideOrganizeRequest", () => {
  test("runs when this pane shows the canvas and holds it", () => {
    expect(decideOrganizeRequest("c1", pane())).toBe("run");
  });

  test("leaves a request for another canvas to that canvas's pane", () => {
    expect(decideOrganizeRequest("c2", pane())).toBe("ignore");
  });

  test("waits while the canvas is still loading", () => {
    expect(decideOrganizeRequest("c1", pane({ loaded: false }))).toBe("wait");
    expect(decideOrganizeRequest("c1", pane({ shownCanvasId: "old" }))).toBe("wait");
  });

  test("refuses at once when the canvas is held elsewhere or failed to load, instead of firing later", () => {
    expect(decideOrganizeRequest("c1", pane({ lock: "conflict" }))).toBe("refuse");
    expect(decideOrganizeRequest("c1", pane({ lock: "lost" }))).toBe("refuse");
    expect(decideOrganizeRequest("c1", pane({ error: "Canvas not found" }))).toBe("refuse");
  });
});
