// src/main/claude/contextUsage.test.mjs
import { describe, expect, test } from "bun:test";
import { CONTEXT_MEASURE_TIMEOUT_MS, measureContext, toContextSnapshot } from "./contextUsage.ts";

const USAGE = {
  totalTokens: 412_000, maxTokens: 1_000_000, percentage: 41.2, autoCompactThreshold: 950_000, isAutoCompactEnabled: true,
  model: "claude-opus-5-5",
  categories: [{ name: "System prompt", tokens: 9_000 }, { name: "Messages", tokens: 380_000 }],
  messageBreakdown: { toolCallTokens: 2_000, toolResultTokens: 120_000, attachmentTokens: 0 },
};

describe("toContextSnapshot", () => {
  test("keeps totals, window, auto-compact and a short breakdown", () => {
    expect(toContextSnapshot(USAGE, 7)).toEqual({
      tokens: 412_000, window: 1_000_000, autoCompactAt: 950_000, autoCompactEnabled: true, model: "claude-opus-5-5",
      breakdown: { setup: 32_000, conversation: 260_000, toolResults: 120_000 },
      exact: true, measuredAt: 7,
    });
  });
  test("rejects a response without totals", () => {
    expect(toContextSnapshot({ maxTokens: 5 }, 1)).toBeNull();
    expect(toContextSnapshot(null, 1)).toBeNull();
  });
});

describe("measureContext", () => {
  test("waits long enough for a cold Claude Code session", () => {
    // Measured with the runner's options on Claude Code 2.1.289: 5.2 s cold, 1.3 s warm.
    expect(CONTEXT_MEASURE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  test("returns the snapshot", async () => {
    expect((await measureContext({ getContextUsage: async () => USAGE }, 100, () => 3))?.tokens).toBe(412_000);
  });
  test("gives up after the limit", async () => {
    const started = Date.now();
    expect(await measureContext({ getContextUsage: () => new Promise(() => {}) }, 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
  test("a failing call is null, not a throw", async () => {
    expect(await measureContext({ getContextUsage: async () => { throw new Error("closed"); } }, 100)).toBeNull();
  });
});
