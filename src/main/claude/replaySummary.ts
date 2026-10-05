import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CHARS_PER_TOKEN } from "@shared/contextSize";
import { heldOpenPrompt } from "./heldOpenPrompt";
import { chunkText } from "./replayFit";

const SUMMARY_SYSTEM_PROMPT =
  "You summarize an earlier part of a conversation so it can continue with less context. Keep decisions, facts, names, numbers, open questions and the user's goals. Write plain prose, no preamble.";
const CHUNK_SHARE = 0.6;

const STOPPED_MESSAGE = "Summarizing stopped.";

type SummaryOptions = {
  executable?: string;
  model?: string;
  cwd: string;
  queryFn?: typeof query;
  /** The chat's stop signal: Stop ends the summary too. */
  signal?: AbortSignal;
};

async function summarizeOnce(text: string, opts: SummaryOptions): Promise<string> {
  if (opts.signal?.aborted) throw new Error(STOPPED_MESSAGE);
  const held = heldOpenPrompt({ type: "user", parent_tool_use_id: null, message: { role: "user", content: `Summarize this earlier conversation:\n\n${text}` } });
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  opts.signal?.addEventListener("abort", stop, { once: true });
  const session = (opts.queryFn ?? query)({
    prompt: held.input,
    options: {
      pathToClaudeCodeExecutable: opts.executable,
      model: opts.model,
      cwd: opts.cwd,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      settingSources: [],
      // The history is untrusted text: the summarizer gets no tools at all.
      tools: [],
      canUseTool: async () => ({ behavior: "deny", message: "No tools while summarizing." }),
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 1,
      abortController: controller,
    },
  });
  try {
    for await (const msg of session as AsyncIterable<SDKMessage>) {
      if (controller.signal.aborted) throw new Error(STOPPED_MESSAGE);
      if (msg.type === "result") {
        if (msg.subtype !== "success" || msg.is_error) throw new Error("Couldn't summarize the earlier conversation.");
        return msg.result.trim();
      }
    }
    throw new Error("Summarizing ended early.");
  } finally {
    opts.signal?.removeEventListener("abort", stop);
    held.release();
    controller.abort();
  }
}

/** Summarizes text that may be larger than the window: chunk, summarize each, then combine. */
export async function summarizeForReplay(
  text: string,
  opts: SummaryOptions & { window: number },
): Promise<string> {
  const maxChars = Math.floor(opts.window * CHUNK_SHARE * CHARS_PER_TOKEN);
  const chunks = chunkText(text, maxChars);
  if (chunks.length === 1) return summarizeOnce(chunks[0], opts);
  const parts: string[] = [];
  for (const chunk of chunks) parts.push(await summarizeOnce(chunk, opts));
  const joined = parts.join("\n\n");
  return joined.length > maxChars ? summarizeForReplay(joined, opts) : joined;
}
