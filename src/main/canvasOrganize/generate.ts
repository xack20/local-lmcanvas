import {
  validatePlanReply,
  type AliasPlan,
  type OrganizeKind,
  type OrganizePlanRequest,
} from "@shared/canvasOrganize";
import { askHaiku } from "../claude/askHaiku";

const SYSTEM_PROMPT = "You output one JSON object only. No prose, no markdown fences.";

// The answer has an entry per node, so time grows with the canvas: a 29-node canvas took 87 s.
const TIMEOUT_BASE_MS = 60_000;
const TIMEOUT_PER_NODE_MS = 4_000;
const TIMEOUT_MAX_MS = 600_000;

/** How long to wait for a plan for a canvas of `nodeCount` nodes before giving up. */
export function organizeTimeoutMs(nodeCount: number): number {
  return Math.min(TIMEOUT_MAX_MS, TIMEOUT_BASE_MS + TIMEOUT_PER_NODE_MS * Math.max(0, nodeCount));
}

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

// Paired browsers can call the planner, so what they send is bounded here, not only in the renderer.
const MAX_REQUEST_NODES = 5_000;
const MAX_REQUEST_TEXT = 300;
const KINDS: readonly string[] = ["main", "deep-dive", "off-topic"] satisfies OrganizeKind[];

type Loose = Record<string, unknown>;
const isLoose = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v.slice(0, MAX_REQUEST_TEXT) : undefined);

/** The request with every field checked and every text cut short, or null when it's malformed or
 *  bigger than any real canvas. */
export function sanitizeRequest(raw: unknown): OrganizePlanRequest | null {
  if (!isLoose(raw) || !Array.isArray(raw.nodes) || raw.nodes.length === 0 || raw.nodes.length > MAX_REQUEST_NODES) {
    return null;
  }
  const nodes: OrganizePlanRequest["nodes"] = [];
  for (const n of raw.nodes) {
    if (!isLoose(n) || typeof n.id !== "string") return null;
    const prev = isLoose(n.previous) ? n.previous : undefined;
    const previous = {
      ...(typeof prev?.next === "string" ? { next: prev.next } : {}),
      ...(typeof prev?.kind === "string" && KINDS.includes(prev.kind) ? { kind: prev.kind as OrganizeKind } : {}),
    };
    const title = text(n.title);
    nodes.push({
      id: n.id,
      ...(typeof n.parent === "string" ? { parent: n.parent } : {}),
      children: (Array.isArray(n.children) ? n.children : []).filter((c): c is string => typeof c === "string"),
      prompt: text(n.prompt) ?? "",
      reply: text(n.reply) ?? "",
      ...(title ? { title } : {}),
      ...(Object.keys(previous).length > 0 ? { previous } : {}),
    });
  }
  return { nodes };
}

/** Haiku's organize plan for the canvas, checked against the request; null when Claude fails. */
export async function planCanvasOrganize(
  raw: OrganizePlanRequest,
  { binPath, signal }: { binPath?: string; signal?: AbortSignal },
): Promise<AliasPlan | null> {
  const request = sanitizeRequest(raw);
  if (!request) return null;
  const collected = await askHaiku(organizePrompt(request), SYSTEM_PROMPT, { binPath, signal, label: "canvasOrganize" });
  if (collected === null) return null;

  const start = collected.indexOf("{");
  const end = collected.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return validatePlanReply(JSON.parse(collected.slice(start, end + 1)), request);
  } catch {
    return null;
  }
}
