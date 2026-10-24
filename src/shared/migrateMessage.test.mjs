// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { migrateMessage } from "./history.ts";

const reply = (extra) => ({
  id: "a1",
  role: "assistant",
  createdAt: 1,
  status: "complete",
  blocks: [{ type: "text", text: "lesson" }],
  ...extra,
});

describe("migrateMessage", () => {
  test("a saved reply keeps its next-step buttons when the canvas is opened", () => {
    const suggestions = [
      { label: "Hint on the timeout puzzle", prompt: "Give me a hint on the timeout puzzle" },
      { label: "Flashcards for level 0", prompt: "Make flashcards for level 0" },
    ];
    expect(migrateMessage(reply({ suggestions }))?.suggestions).toEqual(suggestions);
  });

  test("malformed next steps are dropped", () => {
    const ok = { label: "Next", prompt: "Go on" };
    const loaded = migrateMessage(
      reply({ suggestions: [ok, { label: "No prompt" }, { label: "", prompt: "x" }, null] }),
    );
    expect(loaded?.suggestions).toEqual([ok]);
    expect(migrateMessage(reply({ suggestions: "nope" }))?.suggestions).toBeUndefined();
    expect(migrateMessage(reply({ suggestions: [{ label: 1, prompt: 2 }] }))?.suggestions).toBeUndefined();
  });

  test("a reply saved without next steps loads without them", () => {
    expect(migrateMessage(reply({}))?.suggestions).toBeUndefined();
  });
});
