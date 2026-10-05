import { blocksToPlainText } from "./history";
import type { CanvasNode, CompactionBlock, ContextBreakdown, NodeId } from "./types";

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_SETUP_TOKENS = 20_000;
export const DEFAULT_WINDOW = 200_000;
export const WARN_AT = 0.7;
export const FULL_AT = 0.9;
/** Longest focus text a manual compaction accepts. */
export const MAX_COMPACT_FOCUS_CHARS = 500;

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

function estimateOwnTokens(node: CanvasNode): number {
  const chars = node.data.chat.messages.reduce((sum, m) => sum + blocksToPlainText(m.blocks).length, 0);
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Exact when measured; otherwise the nearest measured ancestor's size plus estimates below it. */
function combinedOf(node: CanvasNode, nodes: Nodes, setupTokens: number, seen: Set<NodeId>): Combined {
  if (node.data.context) {
    return { tokens: node.data.context.tokens, exact: node.data.context.exact, window: node.data.context.window };
  }
  if (seen.has(node.id)) return { tokens: estimateOwnTokens(node), exact: false, window: undefined };
  const nextSeen = new Set(seen).add(node.id);
  const parents = parentsOf(node, nodes).map((p) => combinedOf(p, nodes, setupTokens, nextSeen));
  const base = parents.reduce<Combined | null>((best, p) => (best === null || p.tokens > best.tokens ? p : best), null);
  return {
    tokens: (base ? base.tokens : setupTokens) + estimateOwnTokens(node),
    exact: false,
    window: base?.window,
  };
}

function countCompactions(node: CanvasNode, nodes: Nodes): number {
  let count = 0;
  const seen = new Set<NodeId>();
  let current: CanvasNode | undefined = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    for (const m of current.data.chat.messages) {
      count += m.blocks.filter((b) => b.type === "compaction").length;
    }
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
  const combined = combinedOf(node, nodes, setupTokens, new Set());
  const parents = parentsOf(node, nodes).map((p) => combinedOf(p, nodes, setupTokens, new Set([nodeId])));
  const isRoot = parents.length === 0;
  const largestParent = parents.reduce((max, p) => Math.max(max, p.tokens), 0);
  const own = isRoot ? combined.tokens : Math.max(0, combined.tokens - largestParent);
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
