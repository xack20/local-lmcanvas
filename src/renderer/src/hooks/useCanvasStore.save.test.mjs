// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CANVAS_LOCKED_MESSAGE } from "../../../shared/canvasLock.ts";
import { createCanvasStoreApi, makeBlankNode } from "./useCanvasStore.ts";

const CANVAS_ID = "canvas-1";

// `failWith` makes the next writes reject with that error until cleared.
function stubApi() {
  const net = { failWith: null };
  const writes = [];
  const node = makeBlankNode({ x: 0, y: 0 });
  const canvas = { id: CANVAS_ID, name: "Notes", createdAt: 1, updatedAt: 1, nodes: [node], edges: [] };
  globalThis.window = {
    api: {
      canvases: {
        read: async () => canvas,
        write: async (c) => {
          if (net.failWith) throw net.failWith;
          writes.push(c);
        },
      },
      settings: { read: async () => ({}) },
      canvasLock: { acquire: async () => ({ ok: true }), release: async () => {}, takeOver: async () => {} },
    },
    dispatchEvent: () => true,
  };
  return { net, writes, nodeId: node.id };
}

describe("canvas store saving", () => {
  let store;
  beforeEach(() => {
    store = createCanvasStoreApi();
  });
  afterEach(() => store.getState().releaseLock());

  test("a failed save keeps the canvas on screen and dirty, and reports a save error", async () => {
    const { net } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setName("Renamed");
    net.failWith = new TypeError("Failed to fetch");

    await store.getState().save();

    const state = store.getState();
    expect(state.saveError).toBe("Failed to fetch");
    expect(state.error).toBeNull();
    expect(state.dirty.count).toBeGreaterThan(0);
    expect(state.lock).toBe("held");
    expect(state.saving).toBe(false);
  });

  test("a later successful save clears the save error", async () => {
    const { net, writes } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setName("Renamed");
    net.failWith = new Error("Request failed (502)");
    await store.getState().save();
    net.failWith = null;

    await store.getState().save();

    expect(store.getState().saveError).toBeNull();
    expect(store.getState().dirty.count).toBe(0);
    expect(writes.at(-1).name).toBe("Renamed");
  });

  test.each([
    ["in the browser", new Error(CANVAS_LOCKED_MESSAGE)],
    ["in the desktop app", new Error(`Error invoking remote method 'canvases:write': Error: ${CANVAS_LOCKED_MESSAGE}`)],
  ])("a refusal because another client holds the lock marks it lost (%s)", async (_where, refusal) => {
    const { net } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setName("Renamed");
    net.failWith = refusal;

    await store.getState().save();

    expect(store.getState().lock).toBe("lost");
    expect(store.getState().saveError).toBeNull();
    expect(store.getState().error).toBeNull();
  });

  test("loading a canvas starts with no save error", async () => {
    const { net } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    net.failWith = new Error("disk full");
    await store.getState().save();
    net.failWith = null;
    await store.getState().loadCanvas(CANVAS_ID);
    expect(store.getState().saveError).toBeNull();
  });
});
