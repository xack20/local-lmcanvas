// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { createActiveChats } from "./activeChats.ts";

const clientA = { id: "a", kind: "browser" };
const clientB = { id: "b", kind: "desktop" };

function chat(nodeId, client) {
  return { controller: new AbortController(), nodeId, client };
}

describe("createActiveChats", () => {
  test("abortForClient stops only that client's chats", () => {
    const chats = createActiveChats();
    const mine = chat("n1", clientA);
    const theirs = chat("n2", clientB);
    chats.add("c1", mine);
    chats.add("c2", theirs);
    chats.abortForClient(clientA);
    expect(mine.controller.signal.aborted).toBe(true);
    expect(theirs.controller.signal.aborted).toBe(false);
    expect(chats.has("c1")).toBe(false);
    expect(chats.has("c2")).toBe(true);
  });

  test("abortForNode stops every chat on that node", () => {
    const chats = createActiveChats();
    const first = chat("n1", clientA);
    const second = chat("n1", clientB);
    chats.add("c1", first);
    chats.add("c2", second);
    chats.abortForNode("n1");
    expect(first.controller.signal.aborted && second.controller.signal.aborted).toBe(true);
    expect(chats.has("c1") || chats.has("c2")).toBe(false);
  });

  test("abort stops one chat; finish forgets without aborting", () => {
    const chats = createActiveChats();
    const done = chat("n1", clientA);
    const stopped = chat("n2", clientA);
    chats.add("done", done);
    chats.add("stopped", stopped);
    chats.finish("done");
    chats.abort("stopped");
    expect(done.controller.signal.aborted).toBe(false);
    expect(stopped.controller.signal.aborted).toBe(true);
    expect(chats.has("done") || chats.has("stopped")).toBe(false);
  });
});
