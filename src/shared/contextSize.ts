import { blocksToPlainText } from "./history";
import type { CanvasNode, CompactionBlock, ContextBreakdown, Message, NodeId } from "./types";

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_SETUP_TOKENS = 20_000;
export const DEFAULT_WINDOW = 200_000;
export const WARN_AT = 0.7;
export const FULL_AT = 0.9;
/** Longest focus text a manual compaction accepts. */
export const MAX_COMPACT_FOCUS_CHARS = 500;
/** What a compaction stopped on request reports, so it isn't shown as a failure. */
export const COMPACTION_STOPPED_MESSAGE = "Compaction stopped.";

export type ContextLevel = "ok" | "warn" | "full";

export type ContextView = {
  isRoot: boolean;
  own: number;
  combined: number;
  window: number;
  percent: number;
  exact: boolean;
  level: ContextLevel;
  autoCompactAt?: number;
  autoCompactEnabled?: boolean;
  breakdown?: ContextBreakdown;
  compactions: number;
};

type Nodes = Record<NodeId, CanvasNode>;
type Combined = { tokens: number; exact: boolean; window: number | undefined };

export function formatTokens(n: number): string {
  if (n < 1_000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function contextLevel(percent: number): ContextLevel {
  if (percent >= FULL_AT) return "full";
  if (percent >= WARN_AT) return "warn";
  return "ok";
}

export function compactionText(block: CompactionBlock): string {
  const sizes =
    block.before !== null && block.after !== null
      ? `: ${formatTokens(block.before)} → ${formatTokens(block.after)}`
      : "";
  if (block.trigger === "replay") {
    return block.method === "trimmed"
      ? "Earlier messages were left out to fit"
      : `Earlier messages were summarized to fit${sizes}`;
  }
  return `Context compacted${sizes} (${block.trigger})`;
}

function parentsOf(node: CanvasNode, nodes: Nodes): CanvasNode[] {
  return node.data.chat.parentIds.flatMap((id) => (nodes[id] ? [nodes[id]] : []));
}

// Badges re-size every node on every store change; messages are immutable, so their sizes are cached.
const messageChars = new WeakMap<Message, number>();
const messagesTokens = new WeakMap<Message[], number>();
const messagesCompactionTimes = new WeakMap<Message[], Array<number | undefined>>();

function charsOf(message: Message): number {
  let chars = messageChars.get(message);
  if (chars === undefined) {
    chars = blocksToPlainText(message.blocks).length;
    messageChars.set(message, chars);
  }
  return chars;
}

function estimateOwnTokens(node: CanvasNode): number {
  const messages = node.data.chat.messages;
  let tokens = messagesTokens.get(messages);
  if (tokens === undefined) {
    tokens = Math.round(messages.reduce((sum, m) => sum + charsOf(m), 0) / CHARS_PER_TOKEN);
    messagesTokens.set(messages, tokens);
  }
  return tokens;
}

/** When each compaction in these messages ran (undefined: during a run, before any child existed). */
function compactionTimes(messages: Message[]): Array<number | undefined> {
  let times = messagesCompactionTimes.get(messages);
  if (times === undefined) {
    times = messages.flatMap((m) => m.blocks.flatMap((b) => (b.type === "compaction" ? [b.at] : [])));
    messagesCompactionTimes.set(messages, times);
  }
  return times;
}

/** Exact when measured; otherwise the nearest measured ancestor's size plus estimates below it. */
// `seen` guards against cycles along the current path; `memo` keeps merge diamonds from being walked twice.
function combinedOf(
  node: CanvasNode,
  nodes: Nodes,
  setupTokens: number,
  seen: Set<NodeId>,
  memo: Map<NodeId, Combined>,
): Combined {
  if (node.data.context) {
    return { tokens: node.data.context.tokens, exact: node.data.context.exact, window: node.data.context.window };
  }
  if (seen.has(node.id)) return { tokens: estimateOwnTokens(node), exact: false, window: undefined };
  const known = memo.get(node.id);
  if (known) return known;
  seen.add(node.id);
  let parents: Combined[];
  try {
    parents = parentsOf(node, nodes).map((p) => combinedOf(p, nodes, setupTokens, seen, memo));
  } finally {
    seen.delete(node.id);
  }
  const base = parents.reduce<Combined | null>((best, p) => (best === null || p.tokens > best.tokens ? p : best), null);
  const combined = {
    tokens: (base ? base.tokens : setupTokens) + estimateOwnTokens(node),
    exact: false,
    window: base?.window,
  };
  memo.set(node.id, combined);
  return combined;
}

/** Compactions this node's session inherited: its own, plus its ancestors' from before it started. */
function countCompactions(node: CanvasNode, nodes: Nodes): number {
  const startedAt = node.data.chat.messages[0]?.createdAt ?? Number.POSITIVE_INFINITY;
  let count = compactionTimes(node.data.chat.messages).length;
  const seen = new Set<NodeId>([node.id]);
  const firstParentId: NodeId | undefined = node.data.chat.parentIds[0];
  let current: CanvasNode | undefined = firstParentId ? nodes[firstParentId] : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    count += compactionTimes(current.data.chat.messages).filter((at) => at === undefined || at <= startedAt).length;
    const parentId: NodeId | undefined = current.data.chat.parentIds[0];
    current = parentId ? nodes[parentId] : undefined;
  }
  return count;
}

/** Own and combined (root→here) context sizes for a node, measured or estimated. */
export function contextView(
  nodeId: NodeId,
  nodes: Nodes,
  opts: { setupTokens?: number; defaultWindow?: number } = {},
): ContextView | null {
  const node = nodes[nodeId];
  if (!node) return null;
  const setupTokens = opts.setupTokens ?? DEFAULT_SETUP_TOKENS;
  const memo = new Map<NodeId, Combined>();
  const combined = combinedOf(node, nodes, setupTokens, new Set(), memo);
  const parents = parentsOf(node, nodes).map((p) => combinedOf(p, nodes, setupTokens, new Set([nodeId]), memo));
  const isRoot = parents.length === 0;
  const largestParent = parents.reduce((max, p) => Math.max(max, p.tokens), 0);
  // After its own compaction a node holds only its summary and what followed, so it owns all of it.
  // Otherwise own size is measured from the parent's size when the run started, if that was recorded.
  const base = node.data.context?.base;
  const own =
    isRoot || compactionTimes(node.data.chat.messages).length > 0
      ? combined.tokens
      : Math.max(0, combined.tokens - (base ?? largestParent));
  const window = combined.window ?? opts.defaultWindow ?? DEFAULT_WINDOW;
  const percent = window > 0 ? combined.tokens / window : 0;
  const context = node.data.context;
  return {
    isRoot,
    own,
    combined: combined.tokens,
    window,
    percent,
    exact: combined.exact,
    level: contextLevel(percent),
    autoCompactAt: context?.autoCompactAt,
    autoCompactEnabled: context?.autoCompactEnabled,
    breakdown: context?.breakdown,
    compactions: countCompactions(node, nodes),
  };
}

/** Root: `12k`. Others: `+30k · 42k`. Estimates carry a leading `~`. */
export function contextLabel(view: ContextView): string {
  const mark = view.exact ? "" : "~";
  if (view.isRoot) return `${mark}${formatTokens(view.combined)}`;
  return `${mark}+${formatTokens(view.own)} · ${mark}${formatTokens(view.combined)}`;
}

/** The largest measured parent's size as a node's run starts, stored with its measurement as `base`. */
export function contextBaseFor(nodeId: NodeId, nodes: Nodes): number | undefined {
  const node = nodes[nodeId];
  if (!node) return undefined;
  const sizes = parentsOf(node, nodes).flatMap((p) => (p.data.context?.exact ? [p.data.context.tokens] : []));
  return sizes.length > 0 ? Math.max(...sizes) : undefined;
}
