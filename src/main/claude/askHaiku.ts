import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BetaContentBlock, BetaTextBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import { claudeExecutable } from "./runner";

// Background helpers (canvas names, node titles, organize plans) make short judgements in the
// background, so they use the fast, cheap model rather than the one the user chats with.
const HELPER_MODEL = "haiku";

function assistantText(msg: SDKAssistantMessage): string {
  const content = msg.message.content as BetaContentBlock[];
  return content.flatMap((b) => (b.type === "text" ? [(b as BetaTextBlock).text] : [])).join("");
}

/** One Haiku answer for a background helper. It runs with no tools and no settings: helpers read
 *  conversation text, which can come from someone else's imported file. Null when Claude fails or
 *  `signal` aborts. */
export async function askHaiku(
  prompt: string,
  systemPrompt: string,
  { binPath, signal, label }: { binPath?: string; signal?: AbortSignal; label: string },
): Promise<string | null> {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let collected = "";
  try {
    const q = query({
      prompt,
      options: {
        cwd: homedir(),
        model: HELPER_MODEL,
        pathToClaudeCodeExecutable: claudeExecutable(binPath),
        systemPrompt,
        tools: [],
        settingSources: [],
        includePartialMessages: false,
        abortController: controller,
      },
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "assistant") collected += assistantText(msg);
      if (msg.type === "result") break;
    }
  } catch (err) {
    console.warn(`[${label}] Claude call failed:`, err);
    return null;
  }
  return controller.signal.aborted ? null : collected;
}
