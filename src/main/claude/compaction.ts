import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CompactResult } from "@shared/ipc";
import { COMPACTION_STOPPED_MESSAGE, MAX_COMPACT_FOCUS_CHARS } from "@shared/contextSize";
import { normalizeUsage } from "../agents/usage";
import { measureContext } from "./contextUsage";
import { heldOpenPrompt } from "./heldOpenPrompt";
import { mapSystemMessage } from "./systemEvents";

const COMPACTION_TIMEOUT_MS = 10 * 60_000;

export type CompactionRequest = {
  executable?: string;
  sessionId: string;
  fork: boolean;
  focus?: string;
  model?: string;
  cwd: string;
  queryFn?: typeof query;
  timeoutMs?: number;
  /** The chat's stop signal, when compacting on a chat's behalf. */
  signal?: AbortSignal;
};


export function compactFocus(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > 0 && line.length <= MAX_COMPACT_FOCUS_CHARS ? line : undefined;
}

/** Claude Code's summary opens with its working notes; keep the summary itself. */
function cleanSummary(raw: string): string | null {
  const tagged = /<summary>([\s\S]*?)<\/summary>/.exec(raw);
  const text = tagged ? tagged[1] : raw.replace(/^\s*<analysis>[\s\S]*?<\/analysis>/, "");
  return text.trim() || null;
}

/** Runs Claude Code's /compact on a session (in place, or on a fork) and reports what changed. */
export async function runCompaction(req: CompactionRequest): Promise<CompactResult> {
  if (req.signal?.aborted) throw new Error(COMPACTION_STOPPED_MESSAGE);
  const queryFn = req.queryFn ?? query;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  req.signal?.addEventListener("abort", stop, { once: true });
  let summary: string | null = null;
  const onPostCompact: HookCallback = async (input) => {
    if (input.hook_event_name === "PostCompact") summary = cleanSummary(input.compact_summary);
    return {};
  };
  const held = heldOpenPrompt({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: req.focus ? `/compact ${req.focus}` : "/compact" },
  });
  const session = queryFn({
    prompt: held.input,
    options: {
      pathToClaudeCodeExecutable: req.executable,
      cwd: req.cwd,
      model: req.model,
      resume: req.sessionId,
      ...(req.fork ? { forkSession: true } : {}),
      // /compact needs no tools, so none are allowed (a browser tab can ask for this too).
      permissionMode: "default",
      canUseTool: async () => ({ behavior: "deny", message: "Tools are off while compacting." }),
      settingSources: ["user", "project"],
      hooks: { PostCompact: [{ hooks: [onPostCompact] }] },
      abortController: controller,
    },
  });
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? COMPACTION_TIMEOUT_MS);
  let sessionId = req.sessionId;
  let before: number | null = null;
  let after: number | null = null;
  let compacted = false;
  // A refused /compact still ends in a "success" result; its status message carries the reason.
  let compactError: string | null = null;
  try {
    for await (const msg of session as AsyncIterable<SDKMessage>) {
      if (req.signal?.aborted) throw new Error(COMPACTION_STOPPED_MESSAGE);
      const id = (msg as { session_id?: unknown }).session_id;
      if (typeof id === "string" && id.length > 0) sessionId = id;
      const event = mapSystemMessage(msg);
      if (event?.kind === "compacting" && event.error) compactError = event.error;
      if (event?.kind === "compacted") {
        compacted = true;
        before = event.before;
        after = event.after;
      }
      if (msg.type === "result") {
        if (msg.is_error || msg.subtype !== "success") {
          const errors = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("\n") : msg.subtype;
          throw new Error(errors || "Compaction failed");
        }
        if (!compacted) throw new Error(compactError ?? "Claude Code didn't compact this session.");
        const context = await measureContext(session);
        const usage = normalizeUsage((msg as { usage?: unknown }).usage, {
          totalCostUsd: (msg as { total_cost_usd?: unknown }).total_cost_usd,
        });
        return { sessionId, before, after, summary, context, ...(usage ? { usage } : {}) };
      }
    }
    throw new Error("Claude Code ended before compacting.");
  } catch (error) {
    // Stopping kills Claude Code, and the SDK then throws its own abort error.
    if (req.signal?.aborted) throw new Error(COMPACTION_STOPPED_MESSAGE);
    throw error;
  } finally {
    req.signal?.removeEventListener("abort", stop);
    clearTimeout(timer);
    held.release();
    controller.abort();
  }
}
