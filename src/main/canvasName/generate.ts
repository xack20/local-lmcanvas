import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BetaContentBlock, BetaTextBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import { cleanCanvasName } from "@shared/canvasName";
import type { GenerateCanvasNameRequest } from "@shared/ipc";
import { claudeExecutable } from "../claude/runner";

type GenerateCanvasNameArgs = GenerateCanvasNameRequest & {
  binPath?: string;
  signal?: AbortSignal;
};

// Naming is a small summary that runs in the background on every few replies, so it
// takes the fast, cheap model rather than the one the user chats with.
const NAMING_MODEL = "haiku";

const SYSTEM_PROMPT =
  "You output one short plain-text title only. No prose, no markdown, no quotes.";

function namingPrompt({ prompts, firstReply, currentName }: GenerateCanvasNameRequest): string {
  const keep = currentName
    ? `\nThe canvas is currently named "${currentName}". Return exactly that name unless the canvas's focus has clearly moved.\n`
    : "";
  return `Name this canvas: a workspace of branching AI chats. The name appears in a list of canvases, so it must say what this canvas is specifically about.

Rules:
- 2 to 6 words, at most 50 characters.
- Name the specific subject and goal, not a broad category: "Java threads on Apple silicon", not "Programming help".
- Write it in the language the user writes in.
- No quotes, emoji or closing punctuation. Return only the name.
${keep}
The user's prompts, oldest first:
<prompts>
${prompts.map((p) => `- ${p}`).join("\n")}
</prompts>

The start of the first reply:
<reply>
${firstReply}
</reply>`;
}

function assistantText(msg: SDKAssistantMessage): string {
  const content = msg.message.content as BetaContentBlock[];
  let text = "";
  for (const block of content) {
    if (block.type === "text") {
      text += (block as BetaTextBlock).text;
    }
  }
  return text;
}

export async function generateCanvasName({
  binPath,
  signal,
  ...request
}: GenerateCanvasNameArgs): Promise<string | null> {
  // Paired browsers call this too, so check the shape before building a prompt from it.
  if (!Array.isArray(request.prompts) || request.prompts.length === 0) return null;

  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let collected = "";
  try {
    const q = query({
      prompt: namingPrompt(request),
      options: {
        cwd: homedir(),
        model: NAMING_MODEL,
        pathToClaudeCodeExecutable: claudeExecutable(binPath),
        systemPrompt: SYSTEM_PROMPT,
        // The prompts are conversation text, so the namer gets no tools to act on them with.
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
    console.warn("[canvasName] LLM generation failed:", err);
    return null;
  }

  if (controller.signal.aborted) return null;

  const name = cleanCanvasName(collected);
  return name.length > 0 ? name : null;
}
