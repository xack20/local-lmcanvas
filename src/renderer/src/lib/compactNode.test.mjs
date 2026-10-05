// src/renderer/src/lib/compactNode.test.mjs
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCanvasStoreApi, makeBlankNode } from "../hooks/useCanvasStore.ts";
import { SUMMARY_FALLBACK_TEXT, canCompact, compactNode } from "./compactNode.ts";

const CANVAS_ID = "canvas-compact";
function setup() {
  const node = makeBlankNode({ x: 0, y: 0 });
  node.data.chat.providerSession = { provider: "claude", id: "s1" };
  node.data.chat.messages = [
    { id: "u", role: "user", createdAt: 1, blocks: [{ type: "text", text: "hi" }] },
    { id: "a", role: "assistant", createdAt: 2, status: "complete", provider: "claude", blocks: [{ type: "text", text: "hello" }] },
  ];
  globalThis.window = {
    api: {
      canvases: { read: async () => ({ id: CANVAS_ID, name: "C", createdAt: 1, updatedAt: 1, nodes: [node], edges: [] }), write: async () => {} },
      settings: { read: async () => ({}), write: async (s) => s },
      canvasLock: { acquire: async () => ({ ok: true }), release: async () => {}, takeOver: async () => {} },
    },
    dispatchEvent: () => true,
  };
  return node.id;
}
const CONTEXT = { tokens: 38_000, window: 1_000_000, autoCompactEnabled: true, exact: true, measuredAt: 1 };

describe("compactNode", () => {
  let store;
  beforeEach(() => { store = createCanvasStoreApi(); });
  afterEach(() => store.getState().releaseLock());

  test("in place: new session, divider on the reply, new size", async () => {
    const nodeId = setup();
    await store.getState().loadCanvas(CANVAS_ID);
    const calls = [];
    const compact = async (args) => { calls.push(args); return { sessionId: "s1", before: 412_000, after: 38_000, summary: null, context: CONTEXT }; };
    const out = await compactNode({ store, compact }, { canvasId: CANVAS_ID, nodeId, mode: "inPlace", focus: "keep X" });
    expect(out).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ canvasId: CANVAS_ID, nodeId, mode: "inPlace", focus: "keep X", session: { provider: "claude", id: "s1" } });
    const node = store.getState().nodes[nodeId];
    expect(node.data.context).toEqual(CONTEXT);
    expect(node.data.chat.messages[1].blocks.at(-1)).toEqual({ type: "compaction", trigger: "manual", before: 412_000, after: 38_000 });
    expect(store.getState().compactingNodeIds[nodeId]).toBeUndefined();
  });

  test("summary node: a child with the summary, the fork's session and its size", async () => {
    const nodeId = setup();
    await store.getState().loadCanvas(CANVAS_ID);
    const compact = async () => ({ sessionId: "s2", before: 412_000, after: 38_000, summary: "We decided X.", context: CONTEXT });
    const out = await compactNode({ store, compact }, { canvasId: CANVAS_ID, nodeId, mode: "summaryNode" });
    const child = store.getState().nodes[out.summaryNodeId];
    expect(child.data.chat.parentIds).toEqual([nodeId]);
    expect(child.data.chat.providerSession).toEqual({ provider: "claude", id: "s2" });
    expect(child.data.context).toEqual(CONTEXT);
    expect(child.data.chat.messages[0].blocks[0].text).toBe("Continue from summary");
    expect(child.data.chat.messages[1].blocks).toEqual([
      { type: "compaction", trigger: "manual", before: 412_000, after: 38_000 },
      { type: "text", text: "We decided X." },
    ]);
    expect(store.getState().nodes[nodeId].data.chat.providerSession.id).toBe("s1");
  });

  test("uses the fallback text when no summary was captured", async () => {
    const nodeId = setup();
    await store.getState().loadCanvas(CANVAS_ID);
    const out = await compactNode({ store, compact: async () => ({ sessionId: "s2", before: null, after: null, summary: null, context: null }) }, { canvasId: CANVAS_ID, nodeId, mode: "summaryNode" });
    expect(store.getState().nodes[out.summaryNodeId].data.chat.messages[1].blocks.at(-1)).toEqual({ type: "text", text: SUMMARY_FALLBACK_TEXT });
  });

  test("a failed compaction leaves its reason on the node until the next attempt", async () => {
    const nodeId = setup();
    await store.getState().loadCanvas(CANVAS_ID);
    const args = { canvasId: CANVAS_ID, nodeId, mode: "inPlace" };
    await compactNode({ store, compact: async () => { throw new Error("boom"); } }, args);
    expect(store.getState().compactErrors[nodeId]).toBe("Couldn't compact: boom");
    await compactNode({ store, compact: async () => ({ sessionId: "s1", before: 2, after: 1, summary: null, context: null }) }, args);
    expect(store.getState().compactErrors[nodeId]).toBeUndefined();
  });

  test("shows Claude Code's reason without Electron's IPC wrapper", async () => {
    const nodeId = setup();
    await store.getState().loadCanvas(CANVAS_ID);
    const compact = async () => { throw new Error("Error invoking remote method 'chat:compact': Error: Not enough messages to compact."); };
    const out = await compactNode({ store, compact }, { canvasId: CANVAS_ID, nodeId, mode: "inPlace" });
    expect(out).toEqual({ ok: false, error: "Couldn't compact: Not enough messages to compact." });
  });

  test("refuses while the node is busy, and reports a failed compaction without changing anything", async () => {
    const nodeId = setup();
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setCompacting(nodeId, true);
    expect(canCompact(store.getState(), nodeId)).toBe(false);
    const neverCalled = async () => { throw new Error("should not be called"); };
    expect(await compactNode({ store, compact: neverCalled }, { canvasId: CANVAS_ID, nodeId, mode: "inPlace" })).toEqual({ ok: false, error: "This node is busy." });
    store.getState().setCompacting(nodeId, false);

    const before = JSON.stringify(store.getState().nodes[nodeId]);
    const out = await compactNode({ store, compact: async () => { throw new Error("Not enough messages to compact"); } }, { canvasId: CANVAS_ID, nodeId, mode: "inPlace" });
    expect(out).toEqual({ ok: false, error: "Couldn't compact: Not enough messages to compact" });
    expect(JSON.stringify(store.getState().nodes[nodeId])).toBe(before);
  });
});
