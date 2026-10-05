// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCanvasStoreApi, makeBlankNode } from "./useCanvasStore.ts";
import { useRecentsStore } from "./useRecentsStore.ts";

const CANVAS_ID = "canvas-model";

function stubApi() {
  const node = makeBlankNode({ x: 0, y: 0 });
  const canvas = { id: CANVAS_ID, name: "Models", createdAt: 1, updatedAt: 1, nodes: [node], edges: [] };
  globalThis.window = {
    api: {
      canvases: { read: async () => canvas, write: async () => {} },
      settings: { read: async () => ({}), write: async (s) => s },
      canvasLock: { acquire: async () => ({ ok: true }), release: async () => {}, takeOver: async () => {} },
    },
    dispatchEvent: () => true,
  };
  return { nodeId: node.id };
}

describe("a node's Claude model", () => {
  let store;
  beforeEach(() => {
    store = createCanvasStoreApi();
  });
  afterEach(() => store.getState().releaseLock());

  test("is stored by setNodeSettings and removed when cleared", async () => {
    const { nodeId } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);

    store.getState().setNodeSettings(nodeId, { provider: "claude", model: "opus" });
    expect(store.getState().nodes[nodeId].data.nodeSettings).toEqual({ provider: "claude", model: "opus" });

    store.getState().setNodeSettings(nodeId, { provider: undefined, model: undefined });
    expect(store.getState().nodes[nodeId].data.nodeSettings).toBeUndefined();
  });

  test("on its own counts as an override and becomes the remembered seed for new nodes", async () => {
    const { nodeId } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);

    store.getState().setNodeSettings(nodeId, { model: "haiku" });

    expect(store.getState().nodes[nodeId].data.nodeSettings).toEqual({ model: "haiku" });
    expect(useRecentsStore.getState().lastNodeSettings).toEqual({ model: "haiku" });
  });
});
