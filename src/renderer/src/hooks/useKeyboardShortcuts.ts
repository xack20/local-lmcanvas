import { useEffect, type RefObject } from "react";
import { useStoreApi } from "@xyflow/react";
import { FALLBACK_NODE_HEIGHT, NODE_WIDTH } from "@/lib/canvasConstants";
import { keyboardBranchPosition } from "@/lib/childPlacement";
import { makeDomHeightMeasurer, resolveCollisions } from "@/lib/collisionResolution";
import { useCanvasStore, useCanvasStoreApi, makeBlankNode } from "./useCanvasStore";
import { useCenterOnNode } from "./useCenterOnNode";
import { useConfirmDeleteStore } from "./useConfirmDeleteStore";
import { useIsActivePane } from "./useActivePane";

export function useKeyboardShortcuts(
  containerRef?: RefObject<HTMLElement | null>,
) {
  const isActive = useIsActivePane();
  const storeApi = useCanvasStoreApi();
  const addNode = useCanvasStore((s) => s.addNode);
  const connectEdge = useCanvasStore((s) => s.connectEdge);
  const movePosition = useCanvasStore((s) => s.movePosition);
  const flowStore = useStoreApi();
  const centerOnNode = useCenterOnNode();
  const requestDelete = useConfirmDeleteStore((s) => s.request);

  useEffect(() => {
    if (!isActive) return;
    const scope = (): ParentNode => containerRef?.current ?? document;

    const getSelectedNodeId = (): string | null => {
      const active = document.activeElement;
      const root = containerRef?.current;
      const focusedIsInScope = !root || (active instanceof Node && root.contains(active));
      if (focusedIsInScope && active && (active as HTMLElement).closest?.(".react-flow__node")) {
        const el = (active as HTMLElement).closest<HTMLElement>(".react-flow__node");
        return el?.getAttribute("data-id") ?? null;
      }
      const selected = scope().querySelector<HTMLElement>(".react-flow__node.selected");
      return selected?.getAttribute("data-id") ?? null;
    };

    const getSelectedNodeIds = (): string[] => {
      const nodes = scope().querySelectorAll<HTMLElement>(".react-flow__node.selected");
      const ids: string[] = [];
      nodes.forEach((el) => {
        const id = el.getAttribute("data-id");
        if (id) ids.push(id);
      });
      return ids;
    };

    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        el.isContentEditable === true
      );
    };

    const onKey = (e: KeyboardEvent) => {
      // ⌘+B → branch from currently selected node
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        if (isEditable(e.target)) return;
        const id = getSelectedNodeId();
        if (!id) return;
        e.preventDefault();
        const state = storeApi.getState();
        const parent = state.nodes[id];
        if (!parent) return;
        const child = makeBlankNode(keyboardBranchPosition(parent), id);
        addNode(child);
        connectEdge(id, child.id);
        // After the child mounts, push any sibling it lands on (the parent
        // never moves), then bring the child into view at the current zoom.
        // Keyboard focus stays put so repeated ⌘+B keeps adding siblings.
        requestAnimationFrame(() => {
          const zoom = flowStore.getState().transform[2];
          const measure = makeDomHeightMeasurer(zoom);
          const moves = resolveCollisions(child.id, storeApi.getState().nodes, measure, {
            fixedWidth: NODE_WIDTH,
            excludeIds: [id],
          });
          for (const movedId of Object.keys(moves)) {
            movePosition(movedId, moves[movedId]);
          }
          const placed = storeApi.getState().nodes[child.id];
          if (placed) {
            centerOnNode(
              placed.position.x,
              placed.position.y,
              NODE_WIDTH,
              measure(child.id) || FALLBACK_NODE_HEIGHT,
              zoom,
            );
          }
        });
      }

      // Backspace / Delete → open in-app confirmation modal (but NOT when typing)
      if ((e.key === "Backspace" || e.key === "Delete") && !isEditable(e.target)) {
        const ids = getSelectedNodeIds();
        if (ids.length === 0) {
          const id = getSelectedNodeId();
          if (!id) return;
          e.preventDefault();
          requestDelete(id);
          return;
        }
        e.preventDefault();
        requestDelete(ids);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    isActive,
    containerRef,
    addNode,
    connectEdge,
    movePosition,
    flowStore,
    centerOnNode,
    requestDelete,
    storeApi,
  ]);
}
