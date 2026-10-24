// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promptToCanvasName } from "../../../shared/canvasName.ts";
import { createCanvasStoreApi } from "./useCanvasStore.ts";

const CANVAS_ID = "canvas-1";
const FIRST = "I want to learn Computer architecture through Java threads";
const settle = () => new Promise((r) => setTimeout(r, 0));

// `reply` resolves the namer's pending call with that name.
function stubApi(canvasExtra = {}) {
  const writes = [];
  const asked = [];
  let reply = () => {};
  const node = {
    id: "n1",
    type: "custom",
    position: { x: 0, y: 0 },
    data: {
      chat: {
        parentIds: [],
        childIds: [],
        messages: [
          { id: "u1", role: "user", createdAt: 1, blocks: [{ type: "text", text: FIRST }] },
          { id: "a1", role: "assistant", createdAt: 2, status: "complete", blocks: [{ type: "text", text: "Threads run on cores." }] },
        ],
      },
    },
  };
  const canvas = { id: CANVAS_ID, name: promptToCanvasName(FIRST), createdAt: 1, updatedAt: 1, nodes: [node], edges: [], ...canvasExtra };
  globalThis.window = {
    api: {
      canvases: { read: async () => canvas, write: async (c) => void writes.push(c) },
      settings: { read: async () => ({}) },
      canvasLock: { acquire: async () => ({ ok: true }), release: async () => {}, takeOver: async () => {} },
      canvasName: {
        generate: (args) => {
          asked.push(args);
          return new Promise((resolve) => (reply = resolve));
        },
      },
    },
    dispatchEvent: () => true,
  };
  return { writes, asked, reply: (name) => reply(name) };
}

describe("automatic canvas names", () => {
  let store;
  beforeEach(() => {
    store = createCanvasStoreApi();
  });
  afterEach(() => store.getState().releaseLock());

  test("an opened canvas that only has its first-prompt name gets a real one and saves it", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    expect(net.asked).toHaveLength(1);
    expect(net.asked[0].prompts).toEqual([FIRST]);
    expect(net.asked[0].currentName).toBeUndefined();

    net.reply("Java threads and CPU cores");
    await settle();

    expect(store.getState().name).toBe("Java threads and CPU cores");
    expect(store.getState().nameSource).toBe("auto");
    expect(net.writes.at(-1)).toMatchObject({ name: "Java threads and CPU cores", nameSource: "auto" });
  });

  test("a later check sends the current name so the namer can keep it", async () => {
    const net = stubApi({ name: "Java threads and CPU cores", nameSource: "auto" });
    await store.getState().loadCanvas(CANVAS_ID);
    expect(net.asked).toHaveLength(0);

    void store.getState().autoName();
    expect(net.asked[0].currentName).toBe("Java threads and CPU cores");
  });

  test("a name the user gave is never sent to the namer", async () => {
    const net = stubApi({ name: "My Java notes", nameSource: "user" });
    await store.getState().loadCanvas(CANVAS_ID);
    await store.getState().autoName();
    expect(net.asked).toHaveLength(0);
    expect(store.getState().name).toBe("My Java notes");
  });

  test("a rename typed while the namer is working wins", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().rename("My Java notes");

    net.reply("Java threads and CPU cores");
    await settle();

    expect(store.getState().name).toBe("My Java notes");
    expect(store.getState().nameSource).toBe("user");
  });

  test("clearing the name hands it back to the namer", async () => {
    const net = stubApi({ name: "My Java notes", nameSource: "user" });
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().rename("");

    expect(store.getState().name).toBe(promptToCanvasName(FIRST));
    expect(store.getState().nameSource).toBe("auto");
    expect(net.asked).toHaveLength(1);
  });
});
