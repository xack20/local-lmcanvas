// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCanvasStoreApi, makeBlankNode } from "./useCanvasStore.ts";

const CANVAS_ID = "canvas-1";

// `log` records writes and lock releases in the order they reach the Mac.
function stubApi(acquireResult) {
  const writes = [];
  const log = [];
  const node = makeBlankNode({ x: 0, y: 0 });
  const canvas = { id: CANVAS_ID, name: "Notes", createdAt: 1, updatedAt: 1, nodes: [node], edges: [] };
  globalThis.window = {
    api: {
      canvases: {
        read: async () => canvas,
        write: async (c) => {
          writes.push(c);
          log.push("write");
        },
      },
      settings: { read: async () => ({}) },
      canvasLock: {
        acquire: async () => acquireResult,
        release: async (id) => {
          log.push(`release ${id}`);
        },
        takeOver: async () => {},
      },
    },
    dispatchEvent: () => true,
  };
  return { writes, log, nodeId: node.id };
}

const streamingReply = (id = "a") => ({ id, role: "assistant", blocks: [], createdAt: 1, status: "streaming" });
const savedMessage = (canvas, nodeId, messageId) =>
  canvas.nodes.find((n) => n.id === nodeId).data.chat.messages.find((m) => m.id === messageId);

const selectedIds = (store) =>
  Object.values(store.getState().nodes)
    .filter((n) => n.selected)
    .map((n) => n.id);

describe("canvas store lock", () => {
  let store;
  beforeEach(() => {
    store = createCanvasStoreApi();
  });
  // Every pane lets go of its lock when it unmounts; do the same so no claim outlives its test.
  afterEach(() => store.getState().releaseLock());

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

  test("a conflict remembers whether a reply is running at the holder, until the lock is lost", async () => {
    stubApi({ ok: false, holderKind: "desktop", replyRunning: true });
    await store.getState().loadCanvas(CANVAS_ID);
    expect(store.getState().lockReplyRunning).toBe(true);
    store.getState().markLockLost(CANVAS_ID);
    expect(store.getState().lockReplyRunning).toBe(false);
  });

  test("a held canvas still saves", async () => {
    const { writes } = stubApi({ ok: true });
    await store.getState().loadCanvas(CANVAS_ID);
    await store.getState().save();
    expect(writes.length).toBe(1);
  });
});

describe("canvas store lock across unmount", () => {
  let store;
  beforeEach(() => {
    store = createCanvasStoreApi();
  });
  // Every pane lets go of its lock when it unmounts; do the same so no claim outlives its test.
  afterEach(() => store.getState().releaseLock());

  test("a reply that finishes after the pane unmounts is still saved, then the lock is released", async () => {
    const { writes, log, nodeId } = stubApi({ ok: true });
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().appendMessage(nodeId, streamingReply());

    store.getState().releaseLock();
    expect(store.getState().lock).toBe("held");
    expect(log).toEqual([]);

    store.getState().appendTextDelta(nodeId, "a", "the reply");
    store.getState().finalizeMessage(nodeId, "a");
    await store.getState().save();

    expect(writes.length).toBe(1);
    expect(savedMessage(writes[0], nodeId, "a").status).toBe("complete");
    expect(log).toEqual(["write", `release ${CANVAS_ID}`]);
    expect(store.getState().lock).toBeNull();
  });

  test("a pane with nothing running releases its lock at once on unmount", async () => {
    const { writes, log } = stubApi({ ok: true });
    await store.getState().loadCanvas(CANVAS_ID);

    store.getState().releaseLock();

    expect(log).toEqual([`release ${CANVAS_ID}`]);
    expect(store.getState().lock).toBeNull();
    await store.getState().save();
    expect(writes).toEqual([]);
  });

  test("a chat still running after its message completed keeps the lock until the chat's final save", async () => {
    const { writes, log, nodeId } = stubApi({ ok: true });
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().appendMessage(nodeId, streamingReply());
    store.getState().chatStarted("chat-1");
    store.getState().releaseLock();

    store.getState().finalizeMessage(nodeId, "a");
    await store.getState().save();
    expect(log).toEqual(["write"]);

    store.getState().setMessageUsage(nodeId, "a", { inputTokens: 3, outputTokens: 5 });
    store.getState().chatSettled("chat-1");
    await store.getState().save();

    expect(savedMessage(writes[1], nodeId, "a").usage).toEqual({ inputTokens: 3, outputTokens: 5 });
    expect(log).toEqual(["write", "write", `release ${CANVAS_ID}`]);
  });

  test("a lost lock keeps blocking saves after unmount and is never released from here", async () => {
    const { writes, log, nodeId } = stubApi({ ok: true });
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().appendMessage(nodeId, streamingReply());
    store.getState().markLockLost(CANVAS_ID);

    store.getState().releaseLock();
    store.getState().finalizeMessage(nodeId, "a");
    await store.getState().save();

    expect(writes).toEqual([]);
    expect(log).toEqual([]);
    expect(store.getState().lock).toBe("lost");
  });

  test("a canvas that opened in conflict keeps blocking saves after unmount", async () => {
    const { writes, log } = stubApi({ ok: false, holderKind: "browser" });
    await store.getState().loadCanvas(CANVAS_ID);

    store.getState().releaseLock();
    await store.getState().save();

    expect(writes).toEqual([]);
    expect(log).toEqual([]);
    expect(store.getState().lock).toBe("conflict");
  });

  test("a finishing reply does not release the lock of the same canvas reopened in a new pane", async () => {
    const { writes, log, nodeId } = stubApi({ ok: true });
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().appendMessage(nodeId, streamingReply());
    store.getState().releaseLock();

    const reopened = createCanvasStoreApi();
    await reopened.getState().loadCanvas(CANVAS_ID);
    store.getState().finalizeMessage(nodeId, "a");
    await store.getState().save();

    expect(writes.length).toBe(1);
    expect(log).toEqual(["write"]);
    expect(store.getState().lock).toBeNull();
    expect(reopened.getState().lock).toBe("held");

    reopened.getState().releaseLock();
    expect(log).toEqual(["write", `release ${CANVAS_ID}`]);
  });
});
