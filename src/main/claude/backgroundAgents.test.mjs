// src/main/claude/backgroundAgents.test.mjs
import { describe, expect, test } from "bun:test";
import { backgroundAgentTracker } from "./backgroundAgents.ts";

const started = (taskId, toolUseId, taskType, isBackgrounded) => ({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, task_type: taskType, is_backgrounded: isBackgrounded });
const notified = (taskId) => ({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed" });
const updated = (taskId, patch) => ({ type: "system", subtype: "task_updated", task_id: taskId, patch });
const fromAgent = (toolUseId) => ({ type: "assistant", parent_tool_use_id: toolUseId, message: { content: [] } });

describe("backgroundAgentTracker", () => {
  test("a background agent runs until its notification", () => {
    const agents = backgroundAgentTracker();
    agents.observe(started("a1", "t1", "local_agent", true));
    expect(agents.running()).toBe(true);
    agents.observe(notified("a1"));
    expect(agents.running()).toBe(false);
  });

  test("foreground agents and background shell commands aren't waited for", () => {
    const agents = backgroundAgentTracker();
    agents.observe(started("a1", "t1", "local_agent", false));
    agents.observe(started("b1", "t2", "local_bash", true));
    expect(agents.running()).toBe(false);
  });

  test("an agent moved to the background later is waited for, and a final status ends the wait", () => {
    const agents = backgroundAgentTracker();
    agents.observe(started("a1", "t1", "local_agent", false));
    agents.observe(updated("a1", { is_backgrounded: true }));
    expect(agents.running()).toBe(true);
    agents.observe(updated("a1", { status: "killed" }));
    expect(agents.running()).toBe(false);
  });

  test("a finished agent isn't waited for again", () => {
    const agents = backgroundAgentTracker();
    agents.observe(started("a1", "t1", "local_agent", false));
    agents.observe(notified("a1"));
    agents.observe(updated("a1", { is_backgrounded: true }));
    expect(agents.running()).toBe(false);
  });

  // Event shapes recorded from Claude Code 2.1.310: SendMessage revives a finished agent as a new
  // task_started run under the same task_id, carrying the SendMessage call's id.
  test("an agent resumed with SendMessage is waited for again", () => {
    const agents = backgroundAgentTracker();
    agents.observe(started("a1", "t1", "local_agent", true));
    agents.observe(notified("a1"));
    agents.observe(started("a1", "send1", "local_agent", true));
    expect(agents.running()).toBe(true);
    agents.observe(notified("a1"));
    expect(agents.running()).toBe(false);
  });

  test("a resumed agent's messages, which carry its first call's id, stay its own", () => {
    const agents = backgroundAgentTracker();
    agents.observe(started("a1", "t1", "local_agent", false));
    agents.observe(notified("a1"));
    agents.observe(started("a1", "send1", "local_agent", true));
    expect(agents.ownsMessage(fromAgent("t1"))).toBe(true);
  });

  test("only a background agent's own messages are its", () => {
    const agents = backgroundAgentTracker();
    agents.observe(started("a1", "t1", "local_agent", true));
    agents.observe(started("a2", "t2", "local_agent", false));
    expect(agents.ownsMessage(fromAgent("t1"))).toBe(true);
    expect(agents.ownsMessage(fromAgent("t2"))).toBe(false);
    expect(agents.ownsMessage(fromAgent(null))).toBe(false);
  });
});
