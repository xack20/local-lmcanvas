// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import {
  canvasNameInput,
  isAutoNameCheckpoint,
  isAutoNamed,
  nameAfterRename,
  promptToCanvasName,
} from "./canvasName.ts";

const text = (t) => [{ type: "text", text: t }];
const msg = (role, createdAt, blocks, status = "complete") => ({ id: `${role}-${createdAt}`, role, createdAt, blocks, status });
const node = (id, messages) => ({ id, type: "custom", position: { x: 0, y: 0 }, data: { chat: { messages, parentIds: [], childIds: [] } } });

const FIRST = "I want to learn ISO 8583 card payments from zero";
const lesson = [node("a", [msg("user", 1, text(FIRST)), msg("assistant", 2, text("Level 0: who is in a card payment"))])];

describe("isAutoNamed", () => {
  test("an older canvas is the app's to name while its name is blank or the first-prompt fallback", () => {
    expect(isAutoNamed("", undefined, lesson)).toBe(true);
    expect(isAutoNamed(promptToCanvasName(FIRST), undefined, lesson)).toBe(true);
    expect(isAutoNamed("LLMs & transformers, 1948 → 2026", undefined, lesson)).toBe(false);
  });

  test("a saved name source decides on its own", () => {
    expect(isAutoNamed("ISO 8583 card payments", "auto", lesson)).toBe(true);
    expect(isAutoNamed(promptToCanvasName(FIRST), "user", lesson)).toBe(false);
  });
});

describe("isAutoNameCheckpoint", () => {
  test("names after the first reply, then looks again every 3 replies", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(isAutoNameCheckpoint)).toEqual([true, false, false, true, false, false, true]);
    expect(isAutoNameCheckpoint(0)).toBe(false);
  });
});

describe("canvasNameInput", () => {
  test("reads every prompt on the canvas oldest first, cut short, and the text of the first reply", () => {
    const nodes = [
      node("child", [msg("user", 5, text("Now   show me\na race condition")), msg("assistant", 6, text("Here it is"))]),
      node("root", [
        msg("user", 1, text("x".repeat(500))),
        msg("assistant", 2, [
          { type: "text", text: "Threads first." },
          { type: "tool_use", id: "t", name: "Bash", input: { command: "java ThreadDemo" } },
          { type: "text", text: "Then cores." },
        ]),
      ]),
    ];

    const input = canvasNameInput(nodes);

    expect(input.prompts).toHaveLength(2);
    expect(input.prompts[0].length).toBeLessThan(250);
    expect(input.prompts[1]).toBe("Now show me a race condition");
    expect(input.firstReply).toBe("Threads first.\nThen cores.");
  });
});

describe("nameAfterRename", () => {
  test("a typed name is the user's", () => {
    expect(nameAfterRename("Java threads", lesson, "old")).toEqual({ name: "Java threads", nameSource: "user" });
  });

  test("an empty name hands naming back to the app, starting from the first-prompt fallback", () => {
    expect(nameAfterRename("", lesson, "Java threads")).toEqual({ name: promptToCanvasName(FIRST), nameSource: "auto" });
  });

  test("with no prompt to fall back on, an empty name keeps the current one so the canvas stays listed", () => {
    expect(nameAfterRename("", [node("a", [])], "Scratch")).toEqual({ name: "Scratch", nameSource: "auto" });
  });
});
