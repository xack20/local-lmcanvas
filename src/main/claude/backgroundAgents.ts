export type BackgroundAgents = {
  observe(msg: unknown): void;
  /** A background agent the reply started is still working. */
  running(): boolean;
  /** The message comes from a background agent, not from the reply itself. */
  ownsMessage(msg: unknown): boolean;
};

const FINISHED = new Set<unknown>(["completed", "failed", "killed"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Agents a reply sends to the background. Claude Code keeps them working after the reply's result and
 *  answers each one's report with another turn, so the run isn't over until they finish. Background
 *  shell commands aren't waited for: a dev server never finishes. */
export function backgroundAgentTracker(): BackgroundAgents {
  const agentCalls = new Map<string, string>();
  const backgroundCalls = new Set<string>();
  const running = new Set<string>();
  const finished = new Set<string>();

  const toBackground = (taskId: string): void => {
    const toolUseId = agentCalls.get(taskId);
    if (toolUseId === undefined) return;
    backgroundCalls.add(toolUseId);
    if (!finished.has(taskId)) running.add(taskId);
  };
  const finish = (taskId: string): void => {
    finished.add(taskId);
    running.delete(taskId);
  };

  return {
    observe(msg) {
      if (!isRecord(msg) || msg.type !== "system" || typeof msg.task_id !== "string") return;
      if (msg.subtype === "task_started") {
        if (msg.task_type !== "local_agent" || typeof msg.tool_use_id !== "string") return;
        // SendMessage revives a finished agent as a new run of the same task, whose messages still
        // carry the first call's id.
        finished.delete(msg.task_id);
        if (!agentCalls.has(msg.task_id)) agentCalls.set(msg.task_id, msg.tool_use_id);
        if (msg.is_backgrounded === true) toBackground(msg.task_id);
      } else if (msg.subtype === "task_updated" && isRecord(msg.patch)) {
        if (msg.patch.is_backgrounded === true) toBackground(msg.task_id);
        if (FINISHED.has(msg.patch.status)) finish(msg.task_id);
      } else if (msg.subtype === "task_notification") {
        finish(msg.task_id);
      }
    },
    running: () => running.size > 0,
    ownsMessage: (msg) =>
      isRecord(msg) && typeof msg.parent_tool_use_id === "string" && backgroundCalls.has(msg.parent_tool_use_id),
  };
}
