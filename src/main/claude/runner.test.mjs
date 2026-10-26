// src/main/claude/runner.test.mjs
import { describe, expect, test } from "bun:test";
import { runClaude } from "./runner.ts";

function fakeQuery(messages) {
  return () => Object.assign((async function* () {
    for (const m of messages) yield m;
  })(), { getContextUsage: async () => null });
}

async function run(messages) {
  const events = [];
  await runClaude("hi", {
    cwd: "/tmp",
    chatOnly: true,
    client: {},
    nodeId: "n1",
    onEvent: (ev) => events.push(ev),
    queryFn: fakeQuery(messages),
  });
  return events;
}

const main = (content) => ({ type: "assistant", parent_tool_use_id: null, message: { content, stop_reason: "end_turn" } });
const agentCall = { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }], stop_reason: "tool_use" } };
const agentStarted = { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "t1", task_type: "local_agent", is_backgrounded: true };
const agentSearch = { type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", id: "s1", name: "WebSearch", input: {} }] } };
const agentSearchResult = { type: "user", parent_tool_use_id: "t1", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "results" }] } };
const agentDone = { type: "system", subtype: "task_notification", task_id: "a1", status: "completed" };
const result = (text, usage, cost) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, usage, total_cost_usd: cost });

describe("runClaude with a background agent", () => {
  test("keeps the agent's own calls out of the reply and ends after Claude Code answers its report", async () => {
    const events = await run([
      agentCall,
      agentStarted,
      agentSearch,
      main([{ type: "text", text: "Part A" }]),
      result("Part A", { input_tokens: 4, output_tokens: 100, cache_creation_input_tokens: 1000 }, 0.5),
      agentSearchResult,
      agentDone,
      main([{ type: "text", text: "Follow-up" }]),
      result("Follow-up", { input_tokens: 2, output_tokens: 50 }, 0.7),
    ]);
    expect(events.filter((e) => e.kind === "tool_use").map((e) => e.toolUseId)).toEqual(["t1"]);
    expect(events.some((e) => e.kind === "tool_result")).toBe(false);
    const dones = events.filter((e) => e.kind === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ result: "Follow-up", usage: { inputTokens: 6, outputTokens: 150, cacheCreationInputTokens: 1000, totalTokens: 156, totalCostUsd: 0.7 } });
    expect(events.filter((e) => e.kind === "response_complete")).toHaveLength(1);
    expect(events.findIndex((e) => e.kind === "response_complete")).toBeGreaterThan(events.findIndex((e) => e.kind === "tool_use"));
  });

  test("an agent that reported back during the reply doesn't hold it open", async () => {
    const events = await run([agentCall, agentStarted, agentDone, main([{ type: "text", text: "Done." }]), result("Done.", { input_tokens: 1, output_tokens: 1 }, 0.1)]);
    expect(events.filter((e) => e.kind === "done")).toMatchObject([{ result: "Done." }]);
  });

  test("a shell command left in the background doesn't hold the reply open", async () => {
    const shellStarted = { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "t2", task_type: "local_bash", is_backgrounded: true };
    const events = await run([shellStarted, main([{ type: "text", text: "Server started." }]), result("Server started.", {}, 0.1), main([{ type: "text", text: "never read" }])]);
    expect(events.filter((e) => e.kind === "done")).toMatchObject([{ result: "Server started." }]);
  });

  test("an agent resumed with SendMessage holds the reply open until it reports again", async () => {
    const resumed = { ...agentStarted, tool_use_id: "send1" };
    const events = await run([
      agentCall, agentStarted, agentDone,
      main([{ type: "text", text: "Sent it back for a fix." }]),
      resumed,
      result("Sent it back for a fix.", {}, 0.1),
      agentDone,
      main([{ type: "text", text: "Fixed." }]),
      result("Fixed.", {}, 0.2),
    ]);
    expect(events.filter((e) => e.kind === "done")).toMatchObject([{ result: "Fixed." }]);
  });

  test("the turn after an agent's report starts a new paragraph", async () => {
    const delta = (text) => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    const events = await run([
      agentCall, agentStarted,
      delta("Waiting."), main([{ type: "text", text: "Waiting." }]), result("Waiting.", {}, 0.1),
      agentDone,
      delta("It passed."), main([{ type: "text", text: "It passed." }]), result("It passed.", {}, 0.2),
    ]);
    expect(events.filter((e) => e.kind === "text_delta").map((e) => e.text).join("")).toBe("Waiting.\n\nIt passed.");
  });

  test("an error result still ends the run while an agent is working", async () => {
    const failed = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, errors: ["boom"] };
    const events = await run([agentCall, agentStarted, failed, agentDone, result("never read", {}, 0.1)]);
    expect(events.filter((e) => e.kind === "done")).toMatchObject([{ isError: true, result: "boom" }]);
  });
});
