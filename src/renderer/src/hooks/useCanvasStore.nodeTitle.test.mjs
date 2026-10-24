// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCanvasStoreApi } from "./useCanvasStore.ts";

const CANVAS_ID = "canvas-1";
const PROMPT = "How do Java threads get scheduled onto the cores of my Mac?";
const settle = () => new Promise((r) => setTimeout(r, 0));

function chatNode(id, title, withReply = true) {
  return {
    id,
    type: "custom",
    position: { x: 0, y: 0 },
    data: {
      title,
      chat: {
        parentIds: [],
        childIds: [],
        messages: [
          { id: `${id}-u`, role: "user", createdAt: 1, blocks: [{ type: "text", text: PROMPT }] },
          ...(withReply ? [{ id: `${id}-a`, role: "assistant", createdAt: 2, status: "complete", blocks: [{ type: "text", text: "The OS schedules them." }] }] : []),
        ],
      },
    },
  };
}

function stubApi(nodes) {
  const writes = [];
  const asked = [];
  let answer = () => {};
  const canvas = { id: CANVAS_ID, name: "Java", nameSource: "user", createdAt: 1, updatedAt: 1, nodes, edges: [] };
  globalThis.window = {
    api: {
      canvases: { read: async () => canvas, write: async (c) => void writes.push(c) },
      settings: { read: async () => ({}) },
      canvasLock: { acquire: async () => ({ ok: true }), release: async () => {}, takeOver: async () => {} },
      canvasName: { generate: async () => null },
      nodeTitle: {
        generate: (input) => {
          asked.push(input);
          return new Promise((resolve) => (answer = resolve));
        },
      },
    },
    dispatchEvent: () => true,
  };
  return { writes, asked, answer: (title) => answer(title) };
}

const titleOf = (store, id) => store.getState().nodes[id].data.title;

describe("AI node titles", () => {
  let store;
  beforeEach(() => {
    store = createCanvasStoreApi();
  });
  afterEach(() => store.getState().releaseLock());

  test("a node with its automatic title gets an AI title after its first reply, and it's saved", async () => {
    const net = stubApi([chatNode("n", PROMPT.slice(0, 60))]);
    await store.getState().loadCanvas(CANVAS_ID);

    const done = store.getState().autoTitleNode("n");
    await settle();
    expect(net.asked).toEqual([{ prompt: PROMPT, reply: "The OS schedules them." }]);
    net.answer("Java thread scheduling");
    await done;

    expect(titleOf(store, "n")).toBe("Java thread scheduling");
    expect(net.writes.at(-1).nodes[0].data.title).toBe("Java thread scheduling");
  });

  test("a node that already has a real title, or no finished reply yet, isn't sent", async () => {
    const net = stubApi([chatNode("titled", "Java thread scheduling"), chatNode("waiting", PROMPT.slice(0, 60), false)]);
    await store.getState().loadCanvas(CANVAS_ID);

    await store.getState().autoTitleNode("titled");
    await store.getState().autoTitleNode("waiting");

    expect(net.asked).toHaveLength(0);
  });

  test("a title that changed while Claude was working is kept", async () => {
    const net = stubApi([chatNode("n", PROMPT.slice(0, 60))]);
    await store.getState().loadCanvas(CANVAS_ID);

    const done = store.getState().autoTitleNode("n");
    await settle();
    store.getState().patchNode("n", { title: "Set by Organize" });
    net.answer("Java thread scheduling");
    await done;

    expect(titleOf(store, "n")).toBe("Set by Organize");
  });

  test("asking twice for the same node while one is running sends one request", async () => {
    const net = stubApi([chatNode("n", PROMPT.slice(0, 60))]);
    await store.getState().loadCanvas(CANVAS_ID);

    void store.getState().autoTitleNode("n");
    await settle();
    await store.getState().autoTitleNode("n");

    expect(net.asked).toHaveLength(1);
  });

  test("when Claude doesn't answer, the automatic title stays", async () => {
    const net = stubApi([chatNode("n", PROMPT.slice(0, 60))]);
    await store.getState().loadCanvas(CANVAS_ID);

    const done = store.getState().autoTitleNode("n");
    await settle();
    net.answer(null);
    await done;

    expect(titleOf(store, "n")).toBe(PROMPT.slice(0, 60));
  });
});
