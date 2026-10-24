import type { CanvasNode, NodeId, OrganizePlan } from "./types";
import { byCreation, chatNodes } from "./canvasOrganize";

type Size = { width: number; height: number };
type Position = { x: number; y: number };

/**
 * Positions for every chat node, from an organize plan. Each line (a node and the children that
 * continue it) is one column, stacked downward. A branch starts a new line level with the node it
 * left, in the nearest free column to the right (deep dive) or left (off-topic). Each line reserves
 * its whole height in its column, so lines can't overlap. Sticky notes get no position.
 */
export function layoutCanvas(
  nodes: CanvasNode[],
  plan: OrganizePlan,
  sizeOf: (node: CanvasNode) => Size,
  gap: { x: number; y: number },
): Record<NodeId, Position> {
  const chats = byCreation(chatNodes(nodes));
  if (chats.length === 0) return {};
  const byId = new Map(chats.map((n) => [n.id, n]));
  const parentOf = (n: CanvasNode): NodeId | undefined => {
    const p = n.data.chat.parentIds[0];
    return p !== undefined && p !== n.id && byId.has(p) ? p : undefined;
  };
  const childrenOf = new Map<NodeId, CanvasNode[]>();
  for (const n of chats) {
    const p = parentOf(n);
    if (p) childrenOf.set(p, [...(childrenOf.get(p) ?? []), n]);
  }
  const roots = chats.filter((n) => !parentOf(n));
  const origin = (roots[0] ?? chats[0]).position;
  const pitch = Math.max(...chats.map((n) => sizeOf(n).width)) + gap.x;
  const isSide = (id: NodeId) => plan[id]?.kind === "deep-dive" || plan[id]?.kind === "off-topic";

  const columns = new Map<number, Array<[number, number]>>();
  const placed = new Map<NodeId, { col: number; y: number }>();

  const lineFrom = (start: CanvasNode): CanvasNode[] => {
    const line: CanvasNode[] = [];
    for (let n: CanvasNode | undefined = start; n && !placed.has(n.id) && !line.includes(n); ) {
      line.push(n);
      const kids: CanvasNode[] = (childrenOf.get(n.id) ?? []).filter((k) => !placed.has(k.id) && !line.includes(k));
      const next: NodeId | undefined = plan[n.id]?.next;
      n = kids.find((k) => k.id === next) ?? kids.find((k) => !isSide(k.id));
    }
    return line;
  };
  const heightOf = (line: CanvasNode[]) =>
    line.reduce((h, n, i) => h + sizeOf(n).height + (i > 0 ? gap.y : 0), 0);
  const isFree = (col: number, top: number, bottom: number) =>
    !(columns.get(col) ?? []).some(([t, b]) => top < b + gap.y && bottom + gap.y > t);

  const placeLine = (start: CanvasNode, col: number, top: number): void => {
    const line = lineFrom(start);
    columns.set(col, [...(columns.get(col) ?? []), [top, top + heightOf(line)]]);
    let y = top;
    for (const n of line) {
      placed.set(n.id, { col, y });
      y += sizeOf(n).height + gap.y;
    }
    for (const n of line) {
      const branchTop = placed.get(n.id)!.y;
      for (const kid of childrenOf.get(n.id) ?? []) {
        if (placed.has(kid.id)) continue;
        const dir = plan[kid.id]?.kind === "off-topic" ? -1 : 1;
        const bottom = branchTop + heightOf(lineFrom(kid));
        let c = col + dir;
        while (!isFree(c, branchTop, bottom)) c += dir;
        placeLine(kid, c, branchTop);
      }
    }
  };

  // Roots side by side, oldest first; then anything only reachable through a cycle.
  for (const start of [...roots, ...chats]) {
    if (placed.has(start.id)) continue;
    const nextCol = placed.size === 0 ? 0 : Math.max(...columns.keys()) + 1;
    placeLine(start, nextCol, 0);
  }

  return Object.fromEntries(
    [...placed].map(([id, { col, y }]) => [id, { x: origin.x + col * pitch, y: origin.y + y }]),
  );
}
