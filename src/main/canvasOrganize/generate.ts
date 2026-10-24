import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BetaContentBlock, BetaTextBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import { validatePlanReply, type AliasPlan, type OrganizePlanRequest } from "@shared/canvasOrganize";
import { claudeExecutable } from "../claude/runner";

// Organizing is a quick judgement over short summaries, so it takes the fast, cheap model.
const ORGANIZE_MODEL = "haiku";

const SYSTEM_PROMPT = "You output one JSON object only. No prose, no markdown fences.";

function organizePrompt(request: OrganizePlanRequest): string {
  return `You are organizing a canvas: a tree of branching AI chats. Each node is one exchange (the user's prompt and the start of the reply). A node's children are follow-ups that branched from it, oldest first. The canvas will be laid out with one main line running straight down, deep dives in columns to the right, and off-topic branches to the left.

For each node, decide:
- "title": a short, clear title, 2 to 8 words and at most 60 characters, in the language the user writes in. Name what the node is about, not the question form. When the conversation is a series, give the series a shared prefix, like "Era 3 · Attention" or "Deep dive · KV cache".
- "next": only for a node with several children, the child (by id) that continues this node's own line. Pick the one that carries the main thread forward.
- "kind": for a child that does not continue its parent's line, "deep-dive" (goes further into the same subject) or "off-topic" (leaves the subject). You may also give "deep-dive" or "off-topic" to an only child that starts a new series or leaves the subject. Roots are "main".

Keep each node's current "title" and its "previous" choices unless they are clearly wrong for the canvas as it is now. A title that is just the opening words of the prompt is a poor title: replace it.

Answer with JSON only, in this shape:
{"nodes":[{"id":"n1","title":"…","next":"n2","kind":"main"}]}

The canvas:
${JSON.stringify(request)}`;
}

function assistantText(msg: SDKAssistantMessage): string {
  const content = msg.message.content as BetaContentBlock[];
  return content.flatMap((b) => (b.type === "text" ? [(b as BetaTextBlock).text] : [])).join("");
}

function isRequest(v: unknown): v is OrganizePlanRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as OrganizePlanRequest).nodes) &&
    (v as OrganizePlanRequest).nodes.every(
      (n) => typeof n === "object" && n !== null && typeof n.id === "string" && Array.isArray(n.children),
    )
  );
}

/** Haiku's organize plan for the canvas, checked against the request; null when Claude fails. */
export async function planCanvasOrganize(
  request: OrganizePlanRequest,
  { binPath, signal }: { binPath?: string; signal?: AbortSignal },
): Promise<AliasPlan | null> {
  // Paired browsers call this too, so check the shape before building a prompt from it.
  if (!isRequest(request) || request.nodes.length === 0) return null;

  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let collected = "";
  try {
    const q = query({
      prompt: organizePrompt(request),
      options: {
        cwd: homedir(),
        model: ORGANIZE_MODEL,
        pathToClaudeCodeExecutable: claudeExecutable(binPath),
        systemPrompt: SYSTEM_PROMPT,
        // The canvas is conversation text, maybe from an imported file, so the planner gets no tools.
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
    console.warn("[canvasOrganize] plan failed:", err);
    return null;
  }
  if (controller.signal.aborted) return null;

  const start = collected.indexOf("{");
  const end = collected.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return validatePlanReply(JSON.parse(collected.slice(start, end + 1)), request);
  } catch {
    return null;
  }
}
