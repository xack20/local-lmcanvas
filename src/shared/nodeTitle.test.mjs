// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { cleanNodeTitle, nodeTitleInput, shownTitle } from "./nodeTitle.ts";

const LONG = "I want to learn how Java threads map onto the cores of an Apple silicon Mac in detail";
function node(title, messages) {
  return { id: "n", type: "custom", position: { x: 0, y: 0 }, data: { title, chat: { parentIds: [], childIds: [], messages } } };
}
const user = (text) => ({ id: "u", role: "user", createdAt: 1, blocks: [{ type: "text", text }] });
const reply = (text, status = "complete") => ({ id: "a", role: "assistant", createdAt: 2, status, blocks: [{ type: "text", text }] });

describe("shownTitle", () => {
  test("hides the automatic title, which only repeats the start of the prompt", () => {
    expect(shownTitle(node(LONG.slice(0, 60), [user(LONG)]))).toBeUndefined();
    expect(shownTitle(node(undefined, [user(LONG)]))).toBeUndefined();
  });

  test("shows a title that says something the prompt doesn't", () => {
    expect(shownTitle(node("Java threads on Apple silicon", [user(LONG)]))).toBe("Java threads on Apple silicon");
    expect(shownTitle(node("Summary", []))).toBe("Summary");
  });
});

describe("nodeTitleInput", () => {
  test("is the first prompt and the start of the first finished reply, cut short", () => {
    const input = nodeTitleInput(node(undefined, [user(LONG), reply("r".repeat(2000))]));
    expect(input.prompt).toBe(LONG);
    expect(input.reply.length).toBeLessThanOrEqual(601);
  });

  test("is nothing until the node has a prompt and a finished reply", () => {
    expect(nodeTitleInput(node(undefined, [user(LONG)]))).toBeNull();
    expect(nodeTitleInput(node(undefined, [user(LONG), reply("partial", "streaming")]))).toBeNull();
    expect(nodeTitleInput(node(undefined, []))).toBeNull();
  });
});

describe("cleanNodeTitle", () => {
  test("strips quotes and closing punctuation and keeps at most 60 characters", () => {
    expect(cleanNodeTitle('"Java thread scheduling."')).toBe("Java thread scheduling");
    expect(cleanNodeTitle("x".repeat(300))).toHaveLength(60);
    expect(cleanNodeTitle("   ")).toBe("");
  });
});
