// src/main/claude/overflowRetry.test.mjs
import { describe, expect, test } from "bun:test";
import { isPromptTooLongEvent, overflowRetryTarget } from "./overflowRetry.ts";

describe("overflowRetryTarget", () => {
  test("compacts the node's own session in place", () => {
    expect(overflowRetryTarget({ current: { provider: "claude", id: "c" }, parent: { provider: "claude", id: "p" } })).toEqual({ sessionId: "c", fork: false });
  });
  test("compacts a fork of the parent's session so the parent and its other branches stay intact", () => {
    expect(overflowRetryTarget({ parent: { provider: "claude", id: "p" } })).toEqual({ sessionId: "p", fork: true });
  });
  test("nothing to compact without a Claude session", () => {
    expect(overflowRetryTarget({})).toBeNull();
    expect(overflowRetryTarget({ current: { provider: "codex", id: "x" } })).toBeNull();
  });
});

describe("isPromptTooLongEvent", () => {
  test("matches the coded error and done events only", () => {
    expect(isPromptTooLongEvent({ kind: "error", message: "x", code: "prompt_too_long" })).toBe(true);
    expect(isPromptTooLongEvent({ kind: "done", isError: true, code: "prompt_too_long" })).toBe(true);
    expect(isPromptTooLongEvent({ kind: "error", message: "x", code: "auth_required" })).toBe(false);
    expect(isPromptTooLongEvent({ kind: "text_delta", text: "prompt is too long" })).toBe(false);
  });
});
