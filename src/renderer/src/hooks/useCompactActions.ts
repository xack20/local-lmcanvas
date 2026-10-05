import { useCallback } from "react";
import { useStoreApi } from "@xyflow/react";
import type { NodeId } from "@shared/types";
import { compactNode, type CompactMode, type CompactNodeResult } from "@/lib/compactNode";
import { makeDomHeightMeasurer, resolveCollisions } from "@/lib/collisionResolution";
import { FALLBACK_NODE_HEIGHT, NODE_WIDTH } from "@/lib/canvasConstants";
import { useCanvasStoreApi } from "./useCanvasStore";
import { useCenterOnNode } from "./useCenterOnNode";

export type CompactAction = (nodeId: NodeId, mode: CompactMode, focus?: string) => Promise<CompactNodeResult>;

/** Compacts a node from the canvas. A new Summary node lands like a ⌘+B child and is selected.
 *  Uses React Flow's store, so it only works inside the canvas's ReactFlowProvider. */
export function useCompactActions(): CompactAction {
  const storeApi = useCanvasStoreApi();
  const flowStore = useStoreApi();
  const centerOnNode = useCenterOnNode();

  return useCallback(
    async (nodeId, mode, focus) => {
      const canvasId = storeApi.getState().canvasId;
      if (!canvasId) return { ok: false, error: "No canvas is open." };
      const result = await compactNode(
        { store: storeApi, compact: window.api.chat.compact },
        { canvasId, nodeId, mode, ...(focus ? { focus } : {}) },
      );
      if (result.ok && result.summaryNodeId) {
        const childId = result.summaryNodeId;
        storeApi.getState().setSelectedNodeId(childId);
        // After the node mounts: push any sibling it lands on (the parent never moves), then show it.
        requestAnimationFrame(() => {
          const zoom = flowStore.getState().transform[2];
          const measure = makeDomHeightMeasurer(zoom);
          const moves = resolveCollisions(childId, storeApi.getState().nodes, measure, {
            fixedWidth: NODE_WIDTH,
            excludeIds: [nodeId],
          });
          for (const movedId of Object.keys(moves)) storeApi.getState().movePosition(movedId, moves[movedId]);
          const placed = storeApi.getState().nodes[childId];
          if (placed) {
            centerOnNode(placed.position.x, placed.position.y, NODE_WIDTH, measure(childId) || FALLBACK_NODE_HEIGHT, zoom);
          }
        });
      }
      return result;
    },
    [storeApi, flowStore, centerOnNode],
  );
}
