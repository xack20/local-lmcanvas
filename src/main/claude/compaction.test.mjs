// src/main/claude/compaction.test.mjs
import { describe, expect, test } from "bun:test";
import { compactFocus, runCompaction } from "./compaction.ts";

function fakeQuery(messages, { usage, summary } = {}) {
  const seen = {};
  const queryFn = ({ prompt, options }) => {
    seen.options = options;
    seen.prompt = prompt;
    async function* stream() {
      if (summary !== undefined) await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: "PostCompact", trigger: "manual", compact_summary: summary }, undefined, { signal: new AbortController().signal });
      for (const m of messages) yield m;
    }
    const it = stream();
    return Object.assign(it, { getContextUsage: async () => usage });
  };
  return { queryFn, seen };
}

const BOUNDARY = { type: "system", subtype: "compact_boundary", session_id: "s2", compact_metadata: { trigger: "manual", pre_tokens: 412_000, post_tokens: 38_000 } };
const RESULT = { type: "result", subtype: "success", is_error: false, session_id: "s2", result: "", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 };
const USAGE = { totalTokens: 38_500, maxTokens: 1_000_000, isAutoCompactEnabled: true, categories: [] };

describe("runCompaction", () => {
  test("compacts a fork with the focus and returns the new session, sizes, summary and context", async () => {
    const { queryFn, seen } = fakeQuery([BOUNDARY, RESULT], { usage: USAGE, summary: "We decided X." });
    const out = await runCompaction({ sessionId: "s1", fork: true, focus: "keep X", cwd: "/tmp", queryFn });
    expect(out).toMatchObject({ sessionId: "s2", before: 412_000, after: 38_000, summary: "We decided X." });
    expect(out.context.tokens).toBe(38_500);
    expect(out.usage.totalCostUsd).toBe(0.01);
    expect(seen.options).toMatchObject({ resume: "s1", forkSession: true, cwd: "/tmp" });
    const first = await seen.prompt[Symbol.asyncIterator]().next();
    expect(first.value.message.content).toBe("/compact keep X");
  });

  test("never lets Claude Code use a tool while it compacts", async () => {
    const { queryFn, seen } = fakeQuery([BOUNDARY, RESULT], { usage: USAGE });
    await runCompaction({ sessionId: "s1", fork: false, cwd: "/tmp", queryFn });
    expect(seen.options.permissionMode).not.toBe("bypassPermissions");
    expect(seen.options.allowDangerouslySkipPermissions).toBeUndefined();
    const decision = await seen.options.canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t1" });
    expect(decision.behavior).toBe("deny");
  });

  test("in place resumes without forking", async () => {
    const { queryFn, seen } = fakeQuery([BOUNDARY, RESULT], { usage: USAGE });
    const out = await runCompaction({ sessionId: "s1", fork: false, cwd: "/tmp", queryFn });
    expect(seen.options.forkSession).toBeUndefined();
    expect(out.summary).toBeNull();
  });

  test("fails clearly when Claude Code didn't compact", async () => {
    const { queryFn } = fakeQuery([RESULT], { usage: USAGE });
    await expect(runCompaction({ sessionId: "s1", fork: false, cwd: "/tmp", queryFn })).rejects.toThrow("didn't compact");
  });

  test("fails with Claude Code's error text on an error result", async () => {
    const { queryFn } = fakeQuery([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Not enough messages to compact"] }]);
    await expect(runCompaction({ sessionId: "s1", fork: false, cwd: "/tmp", queryFn })).rejects.toThrow("Not enough messages to compact");
  });

  test("fails with Claude Code's compact_error when its status reports a failed compaction", async () => {
    const failed = { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Not enough messages to compact.", session_id: "s1" };
    const { queryFn } = fakeQuery([failed, { ...RESULT, result: "Not enough messages to compact." }], { usage: USAGE });
    await expect(runCompaction({ sessionId: "s1", fork: false, cwd: "/tmp", queryFn })).rejects.toThrow("Not enough messages to compact.");
  });

  test("keeps only the summary from Claude Code's analysis-then-summary text", async () => {
    const summary = "<analysis>\nworking notes\n</analysis>\n\n<summary>\nWe decided X.\n</summary>";
    const { queryFn } = fakeQuery([BOUNDARY, RESULT], { usage: USAGE, summary });
    const out = await runCompaction({ sessionId: "s1", fork: true, cwd: "/tmp", queryFn });
    expect(out.summary).toBe("We decided X.");
  });

  test("drops a leading analysis block when there's no summary tag", async () => {
    const { queryFn } = fakeQuery([BOUNDARY, RESULT], { usage: USAGE, summary: "<analysis>notes</analysis>\n\nWe decided X." });
    const out = await runCompaction({ sessionId: "s1", fork: true, cwd: "/tmp", queryFn });
    expect(out.summary).toBe("We decided X.");
  });
});

describe("compactFocus", () => {
  test("keeps one short line", () => {
    expect(compactFocus("  keep the API decisions ")).toBe("keep the API decisions");
    expect(compactFocus("a\nb")).toBe("a b");
    expect(compactFocus("x".repeat(501))).toBeUndefined();
    expect(compactFocus("")).toBeUndefined();
    expect(compactFocus(7)).toBeUndefined();
  });
});
