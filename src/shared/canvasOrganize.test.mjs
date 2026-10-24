// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import {
  buildPlanRequest,
  organizeFingerprint,
  parseOrganized,
  planFromAliases,
  restoreFromUndo,
  snapshotFor,
  validatePlanReply,
} from "./canvasOrganize.ts";

const msg = (role, createdAt, text) => ({ id: `${role}-${createdAt}`, role, createdAt, status: "complete", blocks: [{ type: "text", text }] });
function node(id, parentIds, createdAt, extra = {}) {
  const { prompt = `prompt ${id}`, reply = `reply ${id}`, title, x = 0, y = 0, childIds = [] } = extra;
  return {
    id,
    type: "custom",
    position: { x, y },
    data: {
      ...(title ? { title } : {}),
      chat: { parentIds, childIds, messages: [msg("user", createdAt, prompt), msg("assistant", createdAt + 1, reply)] },
    },
  };
}
const sticky = { id: "s", type: "stickyNote", position: { x: 9, y: 9 }, data: { stickyText: "note", chat: { parentIds: [], childIds: [], messages: [] } } };

describe("organizeFingerprint", () => {
  test("the fingerprint changes with a new node or a new reply, not with a move or a title", () => {
    const nodes = [node("a", [], 1), node("b", ["a"], 3)];
    const base = organizeFingerprint(nodes);

    expect(organizeFingerprint([...nodes, node("c", ["a"], 5)])).not.toBe(base);
    const replied = { ...nodes[1], data: { ...nodes[1].data, chat: { ...nodes[1].data.chat, messages: [...nodes[1].data.chat.messages, msg("user", 9, "more")] } } };
    expect(organizeFingerprint([nodes[0], replied])).not.toBe(base);
    expect(organizeFingerprint([{ ...nodes[0], position: { x: 500, y: 500 } }, nodes[1]])).toBe(base);
    expect(organizeFingerprint([{ ...nodes[0], data: { ...nodes[0].data, title: "New" } }, nodes[1]])).toBe(base);
    expect(organizeFingerprint([...nodes, sticky])).toBe(base);
  });
});

describe("buildPlanRequest", () => {
  test("a plan request uses aliases in creation order, cuts prompts and replies to 200, and carries titles and the previous plan", () => {
    const root = node("root", [], 1, { title: "Threads", childIds: ["late", "early"], prompt: "p".repeat(500), reply: "r".repeat(500) });
    const late = node("late", ["root"], 9);
    const early = node("early", ["root"], 5);
    const previous = { root: { next: "late", kind: "main" }, early: { kind: "deep-dive" } };

    const { request, aliasToId } = buildPlanRequest([late, sticky, early, root], previous);

    expect(aliasToId).toEqual({ n1: "root", n2: "early", n3: "late" });
    expect(request.nodes).toHaveLength(3);
    const [r, e] = request.nodes;
    expect(r).toMatchObject({ id: "n1", children: ["n2", "n3"], title: "Threads", previous: { next: "n3", kind: "main" } });
    expect(r.parent).toBeUndefined();
    expect(r.prompt.length).toBeLessThanOrEqual(201);
    expect(r.reply.length).toBeLessThanOrEqual(201);
    expect(e).toMatchObject({ id: "n2", parent: "n1", children: [], prompt: "prompt early", reply: "reply early", previous: { kind: "deep-dive" } });
  });
});

describe("validatePlanReply", () => {
  const request = {
    nodes: [
      { id: "n1", children: ["n2", "n3"], prompt: "", reply: "" },
      { id: "n2", parent: "n1", children: [], prompt: "", reply: "" },
      { id: "n3", parent: "n1", children: [], prompt: "", reply: "" },
    ],
  };

  test("a malformed planner reply falls back instead of failing", () => {
    expect(validatePlanReply("not json", request)).toEqual({});
    expect(validatePlanReply(null, request)).toEqual({});
    expect(validatePlanReply({ nodes: "x" }, request)).toEqual({});
    expect(validatePlanReply({ nodes: [{ id: "n99", title: "Ghost" }, 7] }, request)).toEqual({});

    const plan = validatePlanReply(
      {
        nodes: [
          { id: "n1", title: '"Era 1 · Counting words"', next: "n2", kind: "main" },
          { id: "n2", title: "x".repeat(300), next: "n3", kind: "sideways" },
          { id: "n3", title: 42, kind: "off-topic" },
        ],
      },
      request,
    );

    expect(plan.n1).toEqual({ title: "Era 1 · Counting words", next: "n2", kind: "main" });
    expect(plan.n2.title).toHaveLength(60);
    expect(plan.n2.next).toBeUndefined();
    expect(plan.n2.kind).toBeUndefined();
    expect(plan.n3).toEqual({ kind: "off-topic" });
  });
});

describe("planFromAliases", () => {
  test("an alias plan maps back to real node ids", () => {
    expect(planFromAliases({ n1: { title: "Root", next: "n2" }, n2: { kind: "deep-dive" } }, { n1: "root", n2: "kid" })).toEqual({
      root: { title: "Root", next: "kid" },
      kid: { kind: "deep-dive" },
    });
  });
});

describe("undo", () => {
  test("undo restores positions and titles of nodes that still exist and leaves newer nodes alone", () => {
    const a = node("a", [], 1, { title: "Organized A", x: 1200, y: 0 });
    const c = node("c", ["a"], 7, { title: "New C", x: 50, y: 60 });
    const organized = { fingerprint: "f", plan: {}, undo: { a: { x: 3, y: 4, title: "Old A" }, gone: { x: 1, y: 1 } } };

    const restored = restoreFromUndo([a, c], organized);

    expect(restored[0].position).toEqual({ x: 3, y: 4 });
    expect(restored[0].data.title).toBe("Old A");
    expect(restored[1]).toBe(c);
    expect(restored).toHaveLength(2);
    expect(a.position).toEqual({ x: 1200, y: 0 });
  });

  test("a second snapshot keeps the first one and only adds new nodes", () => {
    const nodes = [node("a", [], 1, { title: "A", x: 10, y: 20 }), sticky];
    const first = snapshotFor(nodes);
    expect(first).toEqual({ a: { x: 10, y: 20, title: "A" } });

    const moved = [node("a", [], 1, { title: "Organized A", x: 999, y: 999 }), node("b", ["a"], 3, { x: 5, y: 6 })];
    const second = snapshotFor(moved, { fingerprint: "f", plan: {}, undo: first });

    expect(second).toEqual({ a: { x: 10, y: 20, title: "A" }, b: { x: 5, y: 6 } });
  });
});

describe("parseOrganized", () => {
  test("a malformed organized field is dropped on load", () => {
    const good = { fingerprint: "f", plan: { a: { title: "A", next: "b", kind: "main" } }, undo: { a: { x: 1, y: 2, title: "Old" } } };
    expect(parseOrganized(good)).toEqual(good);
    expect(parseOrganized(null)).toBeUndefined();
    expect(parseOrganized({ fingerprint: "f", plan: 5, undo: {} })).toBeUndefined();
    expect(parseOrganized({ fingerprint: "f", plan: {} })).toBeUndefined();
    expect(parseOrganized({ plan: {}, undo: {} })).toBeUndefined();
    expect(parseOrganized({ fingerprint: "f", plan: { a: { kind: "weird", title: 3 } }, undo: { a: { x: "1", y: 2 } } })).toEqual({
      fingerprint: "f",
      plan: { a: {} },
      undo: {},
    });
  });
});
