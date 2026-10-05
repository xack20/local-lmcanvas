// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { CLAUDE_EFFORTS, isClaudeEffort } from "./types.ts";

describe("Claude effort levels", () => {
  test("match the levels the claude CLI accepts for --effort", () => {
    expect([...CLAUDE_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test.each(["low", "medium", "high", "xhigh", "max"])("accepts %s", (effort) => {
    expect(isClaudeEffort(effort)).toBe(true);
  });

  test.each([["ultra"], [undefined], [""], ["HIGH"], [3]])(
    "rejects %p, which claude --effort would refuse",
    (value) => {
      expect(isClaudeEffort(value)).toBe(false);
    },
  );
});
