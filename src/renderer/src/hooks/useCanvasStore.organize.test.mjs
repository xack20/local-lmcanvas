// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { organizeFingerprint } from "../../../shared/canvasOrganize.ts";
import { createCanvasStoreApi } from "./useCanvasStore.ts";

const CANVAS_ID = "canvas-1";
const settle = () => new Promise((r) => setTimeout(r, 0));
const measure = () => 300;

function chatNode(id, parentIds, createdAt, position, title) {
  return {
    id,
    type: "custom",
    position,
    data: {
      title,
      chat: {
        parentIds,
        childIds: [],
        messages: [
          { id: `${id}-u`, role: "user", createdAt, blocks: [{ type: "text", text: `prompt ${id}` }] },
          { id: `${id}-a`, role: "assistant", createdAt: createdAt + 1, status: "complete", blocks: [{ type: "text", text: `reply ${id}` }] },
        ],
      },
    },
  };
}

// r → a → b down the main line, d a deep dive off r. Placed messily on purpose.
const baseNodes = () => [
  chatNode("r", [], 1, { x: 0, y: 0 }, "prompt r"),
  chatNode("a", ["r"], 3, { x: 900, y: 40 }, "prompt a"),
  chatNode("b", ["a"], 5, { x: -300, y: 2000 }, "prompt b"),
  chatNode("d", ["r"], 7, { x: 50, y: 50 }, "prompt d"),
];
// Aliases follow creation order: n1 r, n2 a, n3 b, n4 d.
const ALIAS_PLAN = {
  n1: { title: "Threads", next: "n2", kind: "main" },
  n2: { title: "Cores" },
  n3: { title: "Schedulers" },
  n4: { title: "Deep dive · Locks", kind: "deep-dive" },
};

function stubApi(canvasExtra = {}) {
  const writes = [];
  const asked = [];
  let answer = () => {};
  const canvas = { id: CANVAS_ID, name: "Java threads", nameSource: "user", createdAt: 1, updatedAt: 1, nodes: baseNodes(), edges: [], ...canvasExtra };
  globalThis.window = {
    api: {
      canvases: { read: async () => canvas, write: async (c) => void writes.push(c) },
      settings: { read: async () => ({}) },
      canvasLock: { acquire: async () => ({ ok: true }), release: async () => {}, takeOver: async () => {} },
      canvasName: { generate: async () => null },
      canvasOrganize: {
        plan: (request) => {
          asked.push(request);
          return new Promise((resolve) => (answer = resolve));
        },
      },
    },
    dispatchEvent: () => true,
  };
  return { writes, asked, answer: (plan) => answer(plan) };
}

const positions = (store) => Object.fromEntries(Object.values(store.getState().nodes).map((n) => [n.id, n.position]));
const titles = (store) => Object.fromEntries(Object.values(store.getState().nodes).map((n) => [n.id, n.data.title]));

describe("organize", () => {
  let store;
  beforeEach(() => {
    store = createCanvasStoreApi();
  });
  afterEach(() => store.getState().releaseLock());

  async function organizeWithAnswer(net, plan = ALIAS_PLAN) {
    const done = store.getState().organize(measure);
    await settle();
    net.answer(plan);
    await done;
  }

  test("organizing a changed canvas asks Claude once and saves the plan, the titles and an undo snapshot", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);

    await organizeWithAnswer(net);

    expect(net.asked).toHaveLength(1);
    expect(titles(store)).toEqual({ r: "Threads", a: "Cores", b: "Schedulers", d: "Deep dive · Locks" });
    // 300 px measured + the 21 px title line each node gains: 321 + 180 gap per step; columns 1100 + 200 apart.
    expect(positions(store)).toEqual({ r: { x: 0, y: 0 }, a: { x: 0, y: 501 }, b: { x: 0, y: 1002 }, d: { x: 1300, y: 0 } });
    const { organized } = store.getState();
    expect(organized.plan.r).toEqual({ title: "Threads", next: "a", kind: "main" });
    expect(organized.undo.a).toEqual({ x: 900, y: 40, title: "prompt a" });
    expect(net.writes.at(-1).organized.plan.d.kind).toBe("deep-dive");
    expect(store.getState().organizing).toBe(false);
  });

  test("organizing an unchanged canvas reuses its saved plan without asking Claude", async () => {
    const nodes = baseNodes();
    const organized = {
      fingerprint: organizeFingerprint(nodes),
      plan: { r: { title: "Threads", next: "a" }, d: { kind: "deep-dive" } },
      undo: {},
    };
    const net = stubApi({ nodes, organized });
    await store.getState().loadCanvas(CANVAS_ID);

    await store.getState().organize(measure);

    expect(net.asked).toHaveLength(0);
    expect(positions(store).d).toEqual({ x: 1300, y: 0 });
    expect(net.writes.length).toBeGreaterThan(0);
  });

  test("when Claude doesn't answer, nothing moves and the error says so", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    const before = positions(store);

    await organizeWithAnswer(net, null);

    expect(positions(store)).toEqual(before);
    expect(store.getState().organizeError).toBe("Couldn't organize this canvas. Claude didn't answer.");
    expect(store.getState().organized).toBeUndefined();
  });

  test("a reply started while Claude was working stops organizing and nothing moves", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    const before = positions(store);

    store.getState().chatStarted("chat-1");
    await store.getState().organize(measure);
    expect(store.getState().organizeError).toBe("Wait for the reply to finish, then organize.");
    expect(net.asked).toHaveLength(0);
    store.getState().chatSettled("chat-1");

    const done = store.getState().organize(measure);
    await settle();
    store.getState().chatStarted("chat-2");
    net.answer(ALIAS_PLAN);
    await done;

    expect(store.getState().organizeError).toBe("A reply started while organizing. Try again when it finishes.");
    expect(positions(store)).toEqual(before);
  });

  test("organizing twice and then undoing returns to the look from before the first organize", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    const before = { positions: positions(store), titles: titles(store) };

    await organizeWithAnswer(net);
    await store.getState().organize(measure);
    expect(net.asked).toHaveLength(1);
    store.getState().undoOrganize();

    expect(positions(store)).toEqual(before.positions);
    expect(titles(store)).toEqual(before.titles);
    expect(store.getState().organized).toBeUndefined();
  });

  test("undo leaves a node created after organizing where it is, and clears the plan", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    await organizeWithAnswer(net);
    store.getState().addNode({ id: "z", type: "custom", position: { x: 5, y: 6 }, data: { chat: { parentIds: ["b"], childIds: [], messages: [] } } });

    store.getState().undoOrganize();

    expect(positions(store).z).toEqual({ x: 5, y: 6 });
    expect(positions(store).a).toEqual({ x: 900, y: 40 });
    expect(store.getState().organized).toBeUndefined();
    expect(net.writes.at(-1).organized).toBeUndefined();
  });

  test("organizing again gives the same positions, counting the title line the first organize adds", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    // Like the screen: a node is 21 px taller once it shows an organize title.
    const screen = (id) => 300 + (store.getState().organized?.plan[id]?.title ? 21 : 0);

    const first = store.getState().organize(screen);
    await settle();
    net.answer(ALIAS_PLAN);
    await first;
    const once = positions(store);
    await store.getState().organize(screen);

    expect(positions(store)).toEqual(once);
    expect(once.a).toEqual({ x: 0, y: 501 });
  });

  test("a node added while Claude was working is organized and titled next time", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);

    const done = store.getState().organize(measure);
    await settle();
    store.getState().addNode(chatNode("late", ["b"], 20, { x: 9, y: 9 }, "prompt late"));
    net.answer(ALIAS_PLAN);
    await done;
    void store.getState().organize(measure);
    await settle();

    expect(net.asked).toHaveLength(2);
  });

  test("if another window takes the canvas during the wait, the result is dropped", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    const before = positions(store);

    const done = store.getState().organize(measure);
    await settle();
    store.getState().markLockLost(CANVAS_ID);
    net.answer(ALIAS_PLAN);
    await done;

    expect(positions(store)).toEqual(before);
    expect(store.getState().organized).toBeUndefined();
  });

  test("a second Organize while one is running doesn't start another", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);

    const first = store.getState().organize(measure);
    await settle();
    await store.getState().organize(measure);
    expect(net.asked).toHaveLength(1);
    expect(store.getState().organizing).toBe(true);

    net.answer(ALIAS_PLAN);
    await first;
    expect(store.getState().organizing).toBe(false);
  });

  test("each node's height is read once per organize", async () => {
    const nodes = baseNodes();
    stubApi({ nodes, organized: { fingerprint: organizeFingerprint(nodes), plan: {}, undo: {} } });
    await store.getState().loadCanvas(CANVAS_ID);
    const reads = [];

    await store.getState().organize((id) => {
      reads.push(id);
      return 300;
    });

    expect(reads.sort()).toEqual(["a", "b", "d", "r"]);
  });

  test("switching the pane to another canvas during the wait drops the result", async () => {
    const net = stubApi();
    const read = window.api.canvases.read;
    window.api.canvases.read = async (id) => ({ ...(await read(id)), id });
    await store.getState().loadCanvas(CANVAS_ID);

    const done = store.getState().organize(measure);
    await settle();
    await store.getState().loadCanvas("canvas-2");
    const before = positions(store);
    net.answer(ALIAS_PLAN);
    await done;

    expect(store.getState().canvasId).toBe("canvas-2");
    expect(positions(store)).toEqual(before);
    expect(store.getState().organized).toBeUndefined();
    expect(store.getState().organizing).toBe(false);
  });

  test("organizing and undoing keep the canvas's place in the list; an ordinary edit still moves it up", async () => {
    const net = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);

    await organizeWithAnswer(net);
    expect(net.writes.at(-1).updatedAt).toBe(1);
    store.getState().undoOrganize();
    expect(net.writes.at(-1).updatedAt).toBe(1);

    store.getState().setName("Renamed", "user");
    await store.getState().save();
    expect(net.writes.at(-1).updatedAt).toBeGreaterThan(1);
  });

  test("the planner is sent the current titles and the previous plan's choices", async () => {
    const organized = { fingerprint: "stale", plan: { r: { next: "a", kind: "main" }, d: { kind: "deep-dive" } }, undo: {} };
    const net = stubApi({ organized });
    await store.getState().loadCanvas(CANVAS_ID);

    void store.getState().organize(measure);
    await settle();

    const [request] = net.asked;
    expect(request.nodes[0]).toMatchObject({ id: "n1", title: "prompt r", previous: { next: "n2", kind: "main" } });
    expect(request.nodes[3]).toMatchObject({ id: "n4", previous: { kind: "deep-dive" } });
  });
});
