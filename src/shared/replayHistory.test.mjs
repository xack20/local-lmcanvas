// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { blocksToPlainText, buildMergeContext, getMessageHistoryForNode, getReplayHistoryForNode } from "./history.ts";

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
    // The prompt follows the quote after a blank line, as the model saw it when it was sent.
    expect(blocksToPlainText(history[2].blocks)).toBe("> Thread.start()\n> runs run()\n\nWhat does this do?");
  });

  test("duplicate message ids in a hand-edited canvas don't move a quote onto another node's prompt", () => {
    const root = node("root", [], "Teach me threads");
    const kid = node("kid", ["root"], "What does this do?", { addedContext: "Thread.start()" });
    const dup = { ...kid, data: { ...kid.data, chat: { ...kid.data.chat, messages: kid.data.chat.messages.map((m) => ({ ...m, id: m.id.replace("kid", "root") })) } } };

    const history = getReplayHistoryForNode("kid", { root, kid: dup });

    expect(blocksToPlainText(history[0].blocks)).toBe("Teach me threads");
    expect(blocksToPlainText(history[2].blocks)).toBe("> Thread.start()\n\nWhat does this do?");
  });

  test("the merge context a node was sent with is replayed as sent, and a node sent without one gets none", () => {
    const a = node("a", [], "Explain mutexes");
    const b = node("b", [], "Explain semaphores");
    const stored = node("s", ["a", "b"], "Compare them", { sentMergeContext: "Conversation 1: as it was then" });
    const none = node("n", ["a", "b"], "Later second parent", { sentMergeContext: "" });

    expect(blocksToPlainText(getReplayHistoryForNode("s", { a, b, s: stored }).at(-2).blocks)).toBe(
      "Conversation 1: as it was then\n\n---\n\nCompare them",
    );
    expect(blocksToPlainText(getReplayHistoryForNode("n", { a, b, n: none }).at(-2).blocks)).toBe("Later second parent");
  });

  test("a merge node replays with its parents' context before its prompt", () => {
    const nodes = {
      a: node("a", [], "Explain mutexes"),
      b: node("b", [], "Explain semaphores"),
      m: node("m", ["a", "b"], "Compare them"),
    };

    const history = getReplayHistoryForNode("m", nodes);
    const prompt = history.find((msg) => msg.id === "m-u");

    expect(blocksToPlainText(prompt.blocks)).toBe(`${buildMergeContext([nodes.a, nodes.b])}\n\n---\n\nCompare them`);
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
