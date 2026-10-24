import type {
  Canvas,
  CanvasEdge,
  CanvasNode,
  ContentBlock,
  ImageMediaType,
  Message,
  ToolUseBlock,
} from "./types";
import { migrateMessage } from "./history";
import { stripImageMetadata } from "./imageMetadata";

/** A canvas shared as a file: only its questions and answers, laid out as they were. */
export type ShareFile = {
  format: "lmcanvas";
  version: number;
  exportedAt: number;
  canvas: { name: string; nodes: CanvasNode[]; edges: CanvasEdge[] };
};

export type ShareRefusal = "not-lmcanvas" | "newer-version" | "too-large";

export type SharedCanvas = Pick<Canvas, "name" | "nameSource" | "nodes" | "edges">;

export const SHARE_EXTENSION = "lmcanvas";
export const SHARE_MAX_BYTES = 50 * 1024 * 1024;

export const SHARE_REFUSAL_TEXT: Record<ShareRefusal, string> = {
  "not-lmcanvas": "This isn't an LMCanvas file.",
  "newer-version": "This file was made by a newer LMCanvas. Update LMCanvas to open it.",
  "too-large": "This file is too large to import (the limit is 50 MB).",
};

const SHARE_FORMAT = "lmcanvas";
const SHARE_VERSION = 1;
const IMPORTED_NAME = "Imported canvas";
const FAILED_REPLY = "This reply failed.";
const INTERRUPTED_REPLY = "interrupted";
const IMAGE_LEFT_OUT = "(image left out)";
const NOT_ANSWERED = "(not answered)";
const PLAN_TOOL = "ExitPlanMode";
const ASK_USER_TOOL = "mcp__lmc__ask_user_question";
const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"] satisfies ImageMediaType[];

export function toShareFile(canvas: Canvas, exportedAt: number): ShareFile {
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    exportedAt,
    canvas: { name: canvas.name, nodes: canvas.nodes.map(shareNode), edges: canvas.edges.map((e) => ({ ...e })) },
  };
}

/** The default file name for a canvas: never a path, never empty. */
export function shareFileName(canvasName: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = canvasName.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").trim();
  return `${safe || "Canvas"}.${SHARE_EXTENSION}`;
}

/** Rebuild a canvas from a file someone else made: only known fields of the right type survive,
 *  every node and edge gets a new id, and every message is marked imported. */
export function fromShareFile(
  raw: unknown,
  newId: () => string,
): { ok: true; canvas: SharedCanvas } | { ok: false; reason: ShareRefusal } {
  if (!isRecord(raw) || raw.format !== SHARE_FORMAT) return { ok: false, reason: "not-lmcanvas" };
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    return { ok: false, reason: "not-lmcanvas" };
  }
  if (raw.version > SHARE_VERSION) return { ok: false, reason: "newer-version" };
  const canvas = raw.canvas;
  if (!isRecord(canvas)) return { ok: false, reason: "not-lmcanvas" };

  const idMap = new Map<string, string>();
  const kept: ValidNode[] = [];
  for (const n of Array.isArray(canvas.nodes) ? canvas.nodes : []) {
    if (!isValidNode(n) || idMap.has(n.id)) continue;
    idMap.set(n.id, newId());
    kept.push(n);
  }
  const name = typeof canvas.name === "string" && canvas.name.trim() ? canvas.name : IMPORTED_NAME;
  return {
    ok: true,
    canvas: {
      name,
      nameSource: "auto",
      nodes: kept.map((n) => importNode(n, idMap)),
      edges: (Array.isArray(canvas.edges) ? canvas.edges : []).flatMap((e) => importEdge(e, idMap, newId)),
    },
  };
}

function shareNode(n: CanvasNode): CanvasNode {
  const { title, stickyText, width, chat } = n.data;
  return {
    id: n.id,
    type: n.type,
    position: n.position,
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(stickyText !== undefined ? { stickyText } : {}),
      ...(width !== undefined ? { width } : {}),
      chat: {
        parentIds: chat.parentIds,
        childIds: chat.childIds,
        ...(chat.addedContext ? { addedContext: chat.addedContext } : {}),
        messages: chat.messages.map(shareMessage),
      },
    },
  };
}

function shareMessage(m: Message): Message {
  const interrupted = m.status === "streaming";
  const failed = m.status === "error" || m.error !== undefined;
  return {
    id: m.id,
    role: m.role,
    createdAt: m.createdAt,
    blocks: m.blocks.flatMap(shareBlock),
    ...(m.provider ? { provider: m.provider } : {}),
    ...(m.suggestions ? { suggestions: m.suggestions } : {}),
    ...(m.status ? { status: interrupted ? "error" : m.status } : {}),
    // Raw errors are exception text and stderr, which carry folder paths and account details.
    ...(interrupted ? { error: INTERRUPTED_REPLY } : failed ? { error: FAILED_REPLY } : {}),
  };
}

function shareBlock(b: ContentBlock): ContentBlock[] {
  switch (b.type) {
    case "text":
      return [{ type: "text", text: b.text }];
    case "image":
      return [stripImageMetadata(b) ?? { type: "text", text: IMAGE_LEFT_OUT }];
    case "tool_use": {
      const text = toolAsText(b);
      return text ? [{ type: "text", text }] : [];
    }
    default:
      return [];
  }
}

/** The two tools whose input or result is part of the answer itself; the rest is behind the scenes. */
function toolAsText(b: ToolUseBlock): string | null {
  const input = isRecord(b.input) ? b.input : {};
  if (b.name === PLAN_TOOL) return typeof input.plan === "string" ? `**Plan**\n\n${input.plan}` : null;
  if (b.name !== ASK_USER_TOOL || !Array.isArray(input.questions)) return null;
  const answers = parseAnswers(b.result?.content);
  const lines = input.questions.flatMap((q) => {
    if (!isRecord(q) || typeof q.question !== "string") return [];
    const answer = answers[q.question];
    const shown = Array.isArray(answer) ? answer.join(", ") : typeof answer === "string" ? answer : NOT_ANSWERED;
    return [`**Question:** ${q.question}\n**Answer:** ${shown}`];
  });
  return lines.length > 0 ? lines.join("\n\n") : null;
}

function parseAnswers(content: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content ?? "");
    return isRecord(parsed) && isRecord(parsed.answers) ? parsed.answers : {};
  } catch {
    return {};
  }
}

type ValidNode = Record<string, unknown> & {
  id: string;
  type: CanvasNode["type"];
  position: { x: number; y: number };
};

function isValidNode(n: unknown): n is ValidNode {
  return (
    isRecord(n) &&
    typeof n.id === "string" &&
    (n.type === "custom" || n.type === "stickyNote") &&
    isRecord(n.position) &&
    isFiniteNumber(n.position.x) &&
    isFiniteNumber(n.position.y)
  );
}

function importNode(n: ValidNode, idMap: Map<string, string>): CanvasNode {
  const data = isRecord(n.data) ? n.data : {};
  const chat = isRecord(data.chat) ? data.chat : {};
  const known = (ids: unknown): string[] =>
    (Array.isArray(ids) ? ids : []).flatMap((id) => {
      const mapped = typeof id === "string" ? idMap.get(id) : undefined;
      return mapped ? [mapped] : [];
    });
  return {
    id: idMap.get(n.id) as string,
    type: n.type,
    position: { x: n.position.x, y: n.position.y },
    data: {
      ...(typeof data.title === "string" ? { title: data.title } : {}),
      ...(typeof data.stickyText === "string" ? { stickyText: data.stickyText } : {}),
      ...(isFiniteNumber(data.width) ? { width: data.width } : {}),
      chat: {
        parentIds: known(chat.parentIds),
        childIds: known(chat.childIds),
        ...(typeof chat.addedContext === "string" ? { addedContext: chat.addedContext } : {}),
        messages: (Array.isArray(chat.messages) ? chat.messages : []).flatMap(importMessage),
      },
    },
  };
}

function importMessage(raw: unknown): Message[] {
  const m = migrateMessage(raw);
  if (!m) return [];
  const { usage: _usage, errorCode: _code, errorProvider: _provider, modelFallback: _fallback, ...rest } = m;
  return [{ ...rest, blocks: m.blocks.flatMap(importBlock), imported: true }];
}

function importBlock(b: unknown): ContentBlock[] {
  if (!isRecord(b)) return [];
  if (b.type === "text" && typeof b.text === "string") return [{ type: "text", text: b.text }];
  if (b.type === "image" && typeof b.mediaType === "string" && IMAGE_TYPES.includes(b.mediaType) && typeof b.base64 === "string") {
    return [{ type: "image", mediaType: b.mediaType as ImageMediaType, base64: b.base64 }];
  }
  return [];
}

function importEdge(e: unknown, idMap: Map<string, string>, newId: () => string): CanvasEdge[] {
  if (!isRecord(e) || typeof e.source !== "string" || typeof e.target !== "string") return [];
  const source = idMap.get(e.source);
  const target = idMap.get(e.target);
  if (!source || !target) return [];
  return [
    {
      id: newId(),
      source,
      target,
      ...(typeof e.sourceHandle === "string" ? { sourceHandle: e.sourceHandle } : {}),
      ...(typeof e.targetHandle === "string" ? { targetHandle: e.targetHandle } : {}),
      ...(isFiniteNumber(e.sourceYOffset) ? { sourceYOffset: e.sourceYOffset } : {}),
    },
  ];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
