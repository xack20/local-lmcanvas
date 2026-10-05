// src/renderer/src/hooks/useCanvasStore.context.test.mjs
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCanvasStoreApi, makeBlankNode } from "./useCanvasStore.ts";

const CANVAS_ID = "canvas-ctx";
function stubApi() {
  const node = makeBlankNode({ x: 0, y: 0 });
  const writes = [];
  globalThis.window = {
    api: {
      canvases: { read: async () => ({ id: CANVAS_ID, name: "C", createdAt: 1, updatedAt: 1, nodes: [node], edges: [] }), write: async (c) => { writes.push(c); } },
      settings: { read: async () => ({}), write: async (s) => s },
      canvasLock: { acquire: async () => ({ ok: true }), release: async () => {}, takeOver: async () => {} },
    },
    dispatchEvent: () => true,
  };
  return { nodeId: node.id, writes };
}

describe("context in the canvas store", () => {
  let store;
  beforeEach(() => { store = createCanvasStoreApi(); });
  afterEach(() => store.getState().releaseLock());

  test("setNodeContext stores the snapshot on the node and saves it", async () => {
    const { nodeId, writes } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    const context = { tokens: 42_000, window: 1_000_000, autoCompactEnabled: true, exact: true, measuredAt: 1 };
    store.getState().setNodeContext(nodeId, context);
    expect(store.getState().nodes[nodeId].data.context).toEqual(context);
    await store.getState().save();
    expect(writes.at(-1).nodes[0].data.context).toEqual(context);
  });

  test("clearing the size (a node re-running) removes it, so a failed measurement shows an estimate", async () => {
    const { nodeId } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setNodeContext(nodeId, { tokens: 5, window: 10, autoCompactEnabled: true, exact: true, measuredAt: 1 });
    store.getState().setNodeContext(nodeId, undefined);
    expect("context" in store.getState().nodes[nodeId].data).toBe(false);
  });

  test("compacting state is per node and never saved", async () => {
    const { nodeId, writes } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setCompacting(nodeId, true);
    expect(store.getState().compactingNodeIds[nodeId]).toBe(true);
    store.getState().setNodeContext(nodeId, { tokens: 1, window: 2, autoCompactEnabled: false, exact: true, measuredAt: 1 });
    await store.getState().save();
    expect(JSON.stringify(writes.at(-1))).not.toContain("compacting");
    store.getState().setCompacting(nodeId, false);
    expect(store.getState().compactingNodeIds[nodeId]).toBeUndefined();
  });
});
