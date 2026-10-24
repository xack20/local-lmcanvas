import type { CanvasNode, Message, NameSource } from "./types";
import { messageTextForTitle } from "./history";

const UNTITLED_CANVAS_RE = /^untitled canvas$/i;

/** The app names a canvas after its first reply, then looks again every this many replies. */
export const AUTO_NAME_EVERY = 3;
const NAME_PROMPT_CHARS = 200;
const NAME_MAX_PROMPTS = 40;
const NAME_REPLY_CHARS = 600;

export function isUnnamedCanvasName(name: string | null | undefined): boolean {
  return !name || name.trim().length === 0 || UNTITLED_CANVAS_RE.test(name.trim());
}

export function promptToCanvasName(prompt: string): string {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  const truncated = words.slice(0, 5).join(" ");
  const name = words.length > 5 ? `${truncated}...` : truncated;
  return name.length > 50 ? `${name.slice(0, 47)}...` : name;
}

export function cleanCanvasName(name: string): string {
  const trimmed = name.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
  return trimmed.length > 50 ? `${trimmed.slice(0, 47)}...` : trimmed;
}

export function firstUserPrompt(nodes: CanvasNode[]): string | null {
  for (const node of nodes) {
    const message = node.data.chat.messages.find((m) => m.role === "user");
    if (!message) continue;
    const text = messageTextForTitle(message).trim();
    if (text) return text;
  }
  return null;
}

/** Blank or still the first-prompt fallback: the canvas has never had a real name. */
export function isPlaceholderName(name: string, nodes: CanvasNode[]): boolean {
  const prompt = firstUserPrompt(nodes);
  return isUnnamedCanvasName(name) || (prompt !== null && name === promptToCanvasName(prompt));
}

/** Whether the app may (re)name a canvas. One saved before names were tracked is the app's
 *  only while its name is a placeholder; any other name there was given by hand. */
export function isAutoNamed(name: string, nameSource: NameSource | undefined, nodes: CanvasNode[]): boolean {
  return nameSource ? nameSource === "auto" : isPlaceholderName(name, nodes);
}

export function finishedReplyCount(nodes: CanvasNode[]): number {
  return nodes.reduce(
    (n, node) => n + node.data.chat.messages.filter((m) => m.role === "assistant" && m.status === "complete").length,
    0,
  );
}

export function isAutoNameCheckpoint(replies: number): boolean {
  return replies > 0 && (replies - 1) % AUTO_NAME_EVERY === 0;
}

function cut(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text;
}

function replyText(m: Message): string {
  return m.blocks
    .flatMap((b) => (b.type === "text" && b.text.trim() ? [b.text.trim()] : []))
    .join("\n");
}

/** What the namer reads: every prompt on the canvas, oldest first and cut short, plus the first reply. */
export function canvasNameInput(nodes: CanvasNode[]): { prompts: string[]; firstReply: string } {
  const messages = nodes.flatMap((n) => n.data.chat.messages).sort((a, b) => a.createdAt - b.createdAt);
  const prompts = messages
    .filter((m) => m.role === "user")
    .map((m) => cut(messageTextForTitle(m).replace(/\s+/g, " "), NAME_PROMPT_CHARS))
    .filter(Boolean);
  const firstReply = messages.find((m) => m.role === "assistant" && m.status === "complete");
  return {
    // The first prompt says what the canvas is for; the latest ones say where it went.
    prompts: prompts.length > NAME_MAX_PROMPTS ? [prompts[0], ...prompts.slice(1 - NAME_MAX_PROMPTS)] : prompts,
    firstReply: firstReply ? cut(replyText(firstReply), NAME_REPLY_CHARS) : "",
  };
}

/** A typed name is the user's. An empty one hands naming back to the app, starting from the
 *  first-prompt fallback, or the current name when there is no prompt so the canvas stays listed. */
export function nameAfterRename(
  typed: string,
  nodes: CanvasNode[],
  currentName: string,
): { name: string; nameSource: NameSource } {
  const name = typed.trim();
  if (name) return { name, nameSource: "user" };
  const prompt = firstUserPrompt(nodes);
  return { name: (prompt && promptToCanvasName(prompt)) || currentName, nameSource: "auto" };
}
