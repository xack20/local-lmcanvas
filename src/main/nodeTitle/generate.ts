import { cleanNodeTitle } from "@shared/nodeTitle";
import type { GenerateNodeTitleRequest } from "@shared/ipc";
import { askHaiku } from "../claude/askHaiku";

const SYSTEM_PROMPT = "You output one short plain-text title only. No prose, no markdown, no quotes.";
// Paired browsers can call this too; the renderer already cuts these shorter.
const MAX_INPUT_CHARS = 1_000;

function titlePrompt(prompt: string, reply: string): string {
  return `Title one exchange from a branching AI chat. The title sits at the top of the chat's node on a canvas, so it must say what this exchange is specifically about.

Rules:
- 2 to 6 words, at most 60 characters.
- Name the specific subject, not the question form: "Java thread scheduling", not "Question about threads".
- Write it in the language the user writes in.
- No quotes, emoji or closing punctuation. Return only the title.

The user's prompt:
<prompt>
${prompt}
</prompt>

The start of the reply:
<reply>
${reply}
</reply>`;
}

/** A short title for one node from its prompt and the start of its reply; null when Claude fails. */
export async function generateNodeTitle(
  request: GenerateNodeTitleRequest,
  { binPath, signal }: { binPath?: string; signal?: AbortSignal },
): Promise<string | null> {
  if (typeof request?.prompt !== "string" || typeof request.reply !== "string" || !request.prompt.trim()) return null;
  const prompt = titlePrompt(request.prompt.slice(0, MAX_INPUT_CHARS), request.reply.slice(0, MAX_INPUT_CHARS));
  const answer = await askHaiku(prompt, SYSTEM_PROMPT, { binPath, signal, label: "nodeTitle" });
  const title = answer === null ? "" : cleanNodeTitle(answer);
  return title || null;
}
