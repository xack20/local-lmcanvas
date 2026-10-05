// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CANVAS_LOCKED_MESSAGE } from "../../../shared/canvasLock.ts";
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

// Each test uses its own canvas id: lock claims are shared by every store in a window.
function claimStub(id, nodeCount = 1) {
  const log = [];
  const net = { failRead: false, readGate: null, acquireGate: null, refuseWrites: false };
  const nodes = Array.from({ length: nodeCount }, (_, i) => makeBlankNode({ x: 0, y: i * 300 }));
  const canvas = { id, name: "Notes", createdAt: 1, updatedAt: 1, nodes, edges: [] };
  globalThis.window = {
    api: {
      canvases: {
        read: async () => {
          if (net.readGate) await net.readGate;
          if (net.failRead) throw new TypeError("Failed to fetch");
          return canvas;
        },
        write: async () => {
          if (net.refuseWrites) throw new Error(CANVAS_LOCKED_MESSAGE);
          log.push("write");
        },
      },
      settings: { read: async () => ({}) },
      canvasLock: {
        acquire: async () => {
          log.push(`acquire ${id}`);
          if (net.acquireGate) await net.acquireGate;
          return { ok: true };
        },
        release: async (canvasId) => {
          log.push(`release ${canvasId}`);
        },
        takeOver: async () => {},
      },
    },
    dispatchEvent: () => true,
  };
  return { log, net };
}

const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};

describe("canvas store lock claims", () => {
  test("a load that fails drops its claim, so a later pane still releases the lock", async () => {
    const { log, net } = claimStub("claim-a");
    const failed = createCanvasStoreApi();
    net.failRead = true;
    await failed.getState().loadCanvas("claim-a");
    expect(failed.getState().error).not.toBeNull();
    failed.getState().releaseLock();

    net.failRead = false;
    const later = createCanvasStoreApi();
    await later.getState().loadCanvas("claim-a");
    later.getState().releaseLock();

    expect(log).toEqual(["acquire claim-a", "release claim-a"]);
  });

  test("a pane that unmounts while reading never takes the lock, and a later pane still releases it", async () => {
    const { log, net } = claimStub("claim-b");
    const read = gate();
    net.readGate = read.promise;
    const racing = createCanvasStoreApi();
    const loading = racing.getState().loadCanvas("claim-b");
    racing.getState().releaseLock();
    net.readGate = null;
    read.open();
    await loading;

    expect(log).toEqual([]);
    expect(racing.getState().lock).toBeNull();

    const later = createCanvasStoreApi();
    await later.getState().loadCanvas("claim-b");
    later.getState().releaseLock();
    expect(log).toEqual(["acquire claim-b", "release claim-b"]);
  });

  test("a pane that unmounts while acquiring releases the lock its late acquire took", async () => {
    const { log, net } = claimStub("claim-b2");
    const acquired = gate();
    net.acquireGate = acquired.promise;
    const racing = createCanvasStoreApi();
    const loading = racing.getState().loadCanvas("claim-b2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(["acquire claim-b2"]);
    racing.getState().releaseLock();
    net.acquireGate = null;
    acquired.open();
    await loading;

    expect(log).toEqual(["acquire claim-b2", "release claim-b2"]);
    expect(racing.getState().lock).toBeNull();
  });

  test("a pane remounted while loading (React StrictMode) keeps the lock its second load took", async () => {
    const { log, net } = claimStub("claim-strict");
    const read = gate();
    net.readGate = read.promise;
    const store = createCanvasStoreApi();
    const first = store.getState().loadCanvas("claim-strict");
    store.getState().releaseLock();
    const second = store.getState().loadCanvas("claim-strict");
    net.readGate = null;
    read.open();
    await Promise.all([first, second]);

    expect(store.getState().lock).toBe("held");
    expect(store.getState().loaded).toBe(true);
    expect(log.filter((entry) => entry.startsWith("release"))).toEqual([]);

    store.getState().releaseLock();
    expect(log.at(-1)).toBe("release claim-strict");
  });

  test("an unmounted pane taken over while two chats run drops its claim once the last chat settles, without releasing", async () => {
    const { log, net } = claimStub("claim-c", 2);
    const s1 = createCanvasStoreApi();
    await s1.getState().loadCanvas("claim-c");
    s1.getState().chatStarted("A");
    s1.getState().chatStarted("B");
    s1.getState().releaseLock();
    net.refuseWrites = true;
    s1.getState().chatSettled("A");
    await s1.getState().save();
    expect(s1.getState().lock).toBe("lost");
    s1.getState().chatSettled("B");
    await s1.getState().save();
    expect(log).toEqual(["acquire claim-c"]);

    net.refuseWrites = false;
    const s2 = createCanvasStoreApi();
    await s2.getState().loadCanvas("claim-c");
    s2.getState().releaseLock();
    expect(log).toEqual(["acquire claim-c", "acquire claim-c", "release claim-c"]);
  });

  test("a lock lost after unmount, with nothing left running, drops the claim at once", async () => {
    const { log } = claimStub("claim-d");
    const s1 = createCanvasStoreApi();
    await s1.getState().loadCanvas("claim-d");
    s1.getState().chatStarted("A");
    s1.getState().releaseLock();
    s1.getState().chatSettled("A");
    s1.getState().markLockLost("claim-d");

    const s2 = createCanvasStoreApi();
    await s2.getState().loadCanvas("claim-d");
    s2.getState().releaseLock();
    expect(log).toEqual(["acquire claim-d", "acquire claim-d", "release claim-d"]);
  });
});

