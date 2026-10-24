import type { CanvasNode, Message } from "./types";
import { messageTextForTitle } from "./history";

/** Titles are at most this long, and a node's automatic title is this much of its first prompt. */
export const NODE_TITLE_CHARS = 60;
const PROMPT_CHARS = 500;
const REPLY_CHARS = 600;

/** The title a node gets from its first prompt until something better comes along. */
export function promptTitle(message: Message): string {
  return messageTextForTitle(message).slice(0, NODE_TITLE_CHARS);
}

function automaticTitle(node: CanvasNode): string | undefined {
  const first = node.data.chat.messages.find((m) => m.role === "user");
  return first ? promptTitle(first) : undefined;
}

/** Whether `title` is worth drawing on the node: not empty, and not just the start of its prompt. */
export function titleShows(node: CanvasNode, title: string | undefined): boolean {
  return Boolean(title) && title !== automaticTitle(node);
}

/** The title drawn at the top of a node, if it has one worth drawing. */
export function shownTitle(node: CanvasNode): string | undefined {
  return titleShows(node, node.data.title) ? node.data.title : undefined;
}

/** What an AI title is written from: the first prompt and the start of the first finished reply.
 *  Null until the node has both. */
export function nodeTitleInput(node: CanvasNode): { prompt: string; reply: string } | null {
  const { messages } = node.data.chat;
  const prompt = messages.find((m) => m.role === "user");
  const reply = messages.find((m) => m.role === "assistant" && m.status === "complete");
  const promptText = prompt ? messageTextForTitle(prompt).trim() : "";
  const replyText = reply
    ? reply.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim()
    : "";
  if (!promptText || !replyText) return null;
  return { prompt: cut(promptText, PROMPT_CHARS), reply: cut(replyText, REPLY_CHARS) };
}

/** A model's title made fit to show: no wrapping quotes or closing punctuation, one line, short. */
export function cleanNodeTitle(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[.!?…。]+$/, "")
    .trim()
    .slice(0, NODE_TITLE_CHARS)
    .trim();
}

function cut(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text;
}
