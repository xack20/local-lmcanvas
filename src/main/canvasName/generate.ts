import { cleanCanvasName } from "@shared/canvasName";
import type { GenerateCanvasNameRequest } from "@shared/ipc";
import { askHaiku } from "../claude/askHaiku";

type GenerateCanvasNameArgs = GenerateCanvasNameRequest & {
  binPath?: string;
  signal?: AbortSignal;
};

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

export async function generateCanvasName({
  binPath,
  signal,
  ...request
}: GenerateCanvasNameArgs): Promise<string | null> {
  // Paired browsers call this too, so check the shape before building a prompt from it.
  if (!Array.isArray(request.prompts) || request.prompts.length === 0) return null;
  const answer = await askHaiku(namingPrompt(request), SYSTEM_PROMPT, { binPath, signal, label: "canvasName" });
  const name = answer === null ? "" : cleanCanvasName(answer);
  return name.length > 0 ? name : null;
}
