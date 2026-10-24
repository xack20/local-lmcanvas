import type {
  CanvasNode,
  CanvasOrganized,
  Message,
  NodeId,
  OrganizeKind,
  OrganizeNodePlan,
  OrganizePlan,
  OrganizeSnapshot,
} from "./types";
import { messageTextForTitle } from "./history";
import { cleanNodeTitle } from "./nodeTitle";

export type { CanvasOrganized, OrganizeKind, OrganizeNodePlan, OrganizePlan, OrganizeSnapshot } from "./types";

/** What the planner is shown: each chat node under a short alias (`n1`, `n2`, …) instead of its id. */
export type OrganizePlanRequest = {
  nodes: Array<{
    id: string;
    parent?: string;
    children: string[];
    prompt: string;
    reply: string;
    title?: string;
    previous?: { next?: string; kind?: OrganizeKind };
  }>;
};

/** A plan keyed by alias, with `next` pointing at an alias. */
export type AliasPlan = Record<string, OrganizeNodePlan>;

const PLAN_TEXT_CHARS = 200;
const KINDS: readonly string[] = ["main", "deep-dive", "off-topic"] satisfies OrganizeKind[];

export function chatNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.filter((n) => n.type === "custom");
}

/** Chat nodes oldest first: by their first message, then by their place in the canvas. */
export function byCreation(nodes: CanvasNode[]): CanvasNode[] {
  const at = (n: CanvasNode) => n.data.chat.messages[0]?.createdAt ?? Number.MAX_SAFE_INTEGER;
  return nodes.map((n, i) => ({ n, i })).sort((a, b) => at(a.n) - at(b.n) || a.i - b.i).map(({ n }) => n);
}

/** Changes when a chat node or a message is added or removed; moving or retitling doesn't change it. */
export function organizeFingerprint(nodes: CanvasNode[]): string {
  return chatNodes(nodes)
    .map((n) => `${n.id}:${n.data.chat.messages.length}`)
    .sort()
    .join(",");
}

export function buildPlanRequest(
  nodes: CanvasNode[],
  previous?: OrganizePlan,
): { request: OrganizePlanRequest; aliasToId: Record<string, NodeId> } {
  // An unsent blank node has nothing to title yet, and a title given now would stick after its first prompt.
  const chats = byCreation(chatNodes(nodes)).filter((n) => n.data.chat.messages.length > 0);
  const aliasOf = new Map(chats.map((n, i) => [n.id, `n${i + 1}`]));
  const aliasToId = Object.fromEntries(chats.map((n, i) => [`n${i + 1}`, n.id]));
  const request = {
    nodes: chats.map((n) => {
      const parent = aliasOf.get(n.data.chat.parentIds[0]);
      const prev = previous?.[n.id];
      const prevNext = prev?.next ? aliasOf.get(prev.next) : undefined;
      const previousEntry = { ...(prevNext ? { next: prevNext } : {}), ...(prev?.kind ? { kind: prev.kind } : {}) };
      return {
        id: aliasOf.get(n.id) as string,
        ...(parent ? { parent } : {}),
        children: chats.filter((c) => c.data.chat.parentIds[0] === n.id).map((c) => aliasOf.get(c.id) as string),
        prompt: cut(firstText(n.data.chat.messages, "user")),
        reply: cut(firstText(n.data.chat.messages, "assistant")),
        ...(n.data.title ? { title: n.data.title } : {}),
        ...(Object.keys(previousEntry).length > 0 ? { previous: previousEntry } : {}),
      };
    }),
  };
  return { request, aliasToId };
}

/** Keeps only what fits the request: known aliases, a `next` among that node's children,
 *  known kinds, and cleaned titles. Anything else is left for the defaults. Never throws. */
export function validatePlanReply(raw: unknown, request: OrganizePlanRequest): AliasPlan {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return {};
  const byAlias = new Map(request.nodes.map((n) => [n.id, n]));
  const plan: AliasPlan = {};
  for (const e of raw.nodes) {
    const entry = isRecord(e) && typeof e.id === "string" ? byAlias.get(e.id) : undefined;
    if (!entry || !isRecord(e)) continue;
    const title = typeof e.title === "string" ? cleanNodeTitle(e.title) : "";
    plan[entry.id] = {
      ...(title ? { title } : {}),
      ...(typeof e.next === "string" && entry.children.includes(e.next) ? { next: e.next } : {}),
      ...(isKind(e.kind) ? { kind: e.kind } : {}),
    };
  }
  return plan;
}

export function planFromAliases(plan: AliasPlan, aliasToId: Record<string, NodeId>): OrganizePlan {
  return Object.fromEntries(
    Object.entries(plan).flatMap(([alias, { next: aliasNext, ...entry }]) => {
      const id = aliasToId[alias];
      const next = aliasNext ? aliasToId[aliasNext] : undefined;
      return id ? [[id, next ? { ...entry, next } : entry]] : [];
    }),
  );
}

/** The way back: the existing snapshot, plus current positions and titles of chat nodes it lacks. */
export function snapshotFor(nodes: CanvasNode[], organized?: CanvasOrganized): OrganizeSnapshot {
  const base = organized?.undo ?? {};
  const added = chatNodes(nodes)
    .filter((n) => !(n.id in base))
    .map((n) => [n.id, { x: n.position.x, y: n.position.y, ...(n.data.title ? { title: n.data.title } : {}) }]);
  return { ...base, ...Object.fromEntries(added) };
}

/** Nodes with their snapshot position and title back; nodes the snapshot doesn't know stay as they are. */
export function restoreFromUndo(nodes: CanvasNode[], organized: CanvasOrganized): CanvasNode[] {
  return nodes.map((n) => {
    const entry = organized.undo[n.id];
    if (!entry) return n;
    const { title: _organizedTitle, ...data } = n.data;
    return {
      ...n,
      position: { x: entry.x, y: entry.y },
      data: entry.title !== undefined ? { ...data, title: entry.title } : data,
    };
  });
}

/** The organized field as stored, with anything of the wrong shape dropped. */
export function parseOrganized(raw: unknown): CanvasOrganized | undefined {
  if (!isRecord(raw) || typeof raw.fingerprint !== "string" || !isRecord(raw.plan) || !isRecord(raw.undo)) {
    return undefined;
  }
  const plan: OrganizePlan = {};
  for (const [id, e] of Object.entries(raw.plan)) {
    if (!isRecord(e)) continue;
    plan[id] = {
      ...(typeof e.title === "string" ? { title: e.title } : {}),
      ...(typeof e.next === "string" ? { next: e.next } : {}),
      ...(isKind(e.kind) ? { kind: e.kind } : {}),
    };
  }
  const undo: OrganizeSnapshot = {};
  for (const [id, e] of Object.entries(raw.undo)) {
    if (!isRecord(e) || !isFiniteNumber(e.x) || !isFiniteNumber(e.y)) continue;
    undo[id] = { x: e.x, y: e.y, ...(typeof e.title === "string" ? { title: e.title } : {}) };
  }
  return { fingerprint: raw.fingerprint, plan, undo };
}

function firstText(messages: Message[], role: Message["role"]): string {
  const m = messages.find((msg) => msg.role === role);
  if (!m) return "";
  return role === "user"
    ? messageTextForTitle(m)
    : m.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PLAN_TEXT_CHARS ? `${flat.slice(0, PLAN_TEXT_CHARS)}…` : flat;
}

function isKind(v: unknown): v is OrganizeKind {
  return typeof v === "string" && KINDS.includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
