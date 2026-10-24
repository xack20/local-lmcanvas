// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { buildMergeContext, getMessageHistoryForNode, getReplayHistoryForNode } from "./history.ts";

const text = (role, id, t) => ({ id, role, createdAt: 1, blocks: [{ type: "text", text: t }] });
function node(id, parentIds, prompt, extra = {}) {
  return {
    id,
    type: "custom",
    position: { x: 0, y: 0 },
    data: { chat: { parentIds, childIds: [], messages: [text("user", `${id}-u`, prompt), text("assistant", `${id}-a`, `answer ${id}`)], ...extra } },
  };
}

describe("getReplayHistoryForNode", () => {
  test("a branch made from a selection replays with the quoted text before its prompt", () => {
    const nodes = {
      root: node("root", [], "Teach me threads"),
      kid: node("kid", ["root"], "What does this do?", { addedContext: "Thread.start()\nruns run()" }),
    };

    const history = getReplayHistoryForNode("kid", nodes);

    expect(history.map((m) => m.id)).toEqual(["root-u", "root-a", "kid-u", "kid-a"]);
    expect(history[2].blocks).toEqual([
      { type: "text", text: "> Thread.start()\n> runs run()" },
      { type: "text", text: "What does this do?" },
    ]);
  });

  test("a merge node replays with its parents' context before its prompt", () => {
    const nodes = {
      a: node("a", [], "Explain mutexes"),
      b: node("b", [], "Explain semaphores"),
      m: node("m", ["a", "b"], "Compare them"),
    };

    const history = getReplayHistoryForNode("m", nodes);
    const prompt = history.find((msg) => msg.id === "m-u");

    expect(prompt.blocks[0]).toEqual({ type: "text", text: `${buildMergeContext([nodes.a, nodes.b])}\n\n---` });
    expect(prompt.blocks[1]).toEqual({ type: "text", text: "Compare them" });
  });

  test("nodes without either replay unchanged, and the stored messages are not changed", () => {
    const nodes = {
      root: node("root", [], "Teach me threads"),
      kid: node("kid", ["root"], "Why?", { addedContext: "volatile" }),
    };
    const plain = { root: nodes.root, leaf: node("leaf", ["root"], "And then?") };

    expect(getReplayHistoryForNode("leaf", plain)).toEqual(getMessageHistoryForNode("leaf", plain));
    getReplayHistoryForNode("kid", nodes);
    expect(nodes.kid.data.chat.messages[0].blocks).toEqual([{ type: "text", text: "Why?" }]);
  });
});
