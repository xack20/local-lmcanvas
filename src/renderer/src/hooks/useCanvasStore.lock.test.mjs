// .mjs keeps the bun:test import out of `bun run typecheck`.
import { beforeEach, describe, expect, test } from "bun:test";
import { createCanvasStoreApi, makeBlankNode } from "./useCanvasStore.ts";

const CANVAS_ID = "canvas-1";

function stubApi(acquireResult) {
  const writes = [];
  const node = makeBlankNode({ x: 0, y: 0 });
  const canvas = { id: CANVAS_ID, name: "Notes", createdAt: 1, updatedAt: 1, nodes: [node], edges: [] };
  globalThis.window = {
    api: {
      canvases: { read: async () => canvas, write: async (c) => writes.push(c) },
      settings: { read: async () => ({}) },
      canvasLock: { acquire: async () => acquireResult, release: async () => {}, takeOver: async () => {} },
    },
    dispatchEvent: () => true,
  };
  return { writes, nodeId: node.id };
}

const selectedIds = (store) =>
  Object.values(store.getState().nodes)
    .filter((n) => n.selected)
    .map((n) => n.id);

describe("canvas store lock", () => {
  let store;
  beforeEach(() => {
    store = createCanvasStoreApi();
  });

  test("losing the lock makes the pane read-only and closes the drawer by deselecting", async () => {
    const { nodeId } = stubApi({ ok: true });
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setSelectedNodeIds([nodeId]);
    expect(selectedIds(store)).toEqual([nodeId]);

    store.getState().markLockLost(CANVAS_ID);

    expect(store.getState().lock).toBe("lost");
    expect(selectedIds(store)).toEqual([]);
  });

  test("a lost-lock event for another canvas changes nothing", async () => {
    const { nodeId } = stubApi({ ok: true });
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setSelectedNodeIds([nodeId]);

    store.getState().markLockLost("some-other-canvas");

    expect(store.getState().lock).toBe("held");
    expect(selectedIds(store)).toEqual([nodeId]);
  });

  test("a canvas that opens in conflict has no selection and never writes", async () => {
    const { writes } = stubApi({ ok: false, holderKind: "desktop" });
    await store.getState().loadCanvas(CANVAS_ID);

    expect(store.getState().lock).toBe("conflict");
    expect(store.getState().lockHolder).toBe("desktop");
    expect(selectedIds(store)).toEqual([]);
    await store.getState().save();
    expect(writes).toEqual([]);
  });

  test("a held canvas still saves", async () => {
    const { writes } = stubApi({ ok: true });
    await store.getState().loadCanvas(CANVAS_ID);
    await store.getState().save();
    expect(writes.length).toBe(1);
  });
});
