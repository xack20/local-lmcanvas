import { useEffect, useRef } from "react";
import { useNodesInitialized, useReactFlow, useStoreApi } from "@xyflow/react";
import { FALLBACK_NODE_HEIGHT, NODE_WIDTH } from "@/lib/canvasConstants";
import { widthFitViewport, type NodeBox } from "@/lib/widthFitViewport";

// Matches the canvas's minZoom and the old fitView maxZoom (never zoom in past 100%).
const OPEN_ZOOM_RANGE = { min: 0.1, max: 1 };

/** Sets the opening view once per mount, after node sizes are measured. */
export function useWidthFitOnOpen(): void {
  const nodesInitialized = useNodesInitialized();
  const { getNodes, setViewport } = useReactFlow();
  const flowStore = useStoreApi();
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current || !nodesInitialized) return;
    const { width, height } = flowStore.getState();
    const boxes: NodeBox[] = getNodes().map((node) => ({
      x: node.position.x,
      y: node.position.y,
      width: node.measured?.width ?? NODE_WIDTH,
      height: node.measured?.height ?? FALLBACK_NODE_HEIGHT,
    }));
    const viewport = widthFitViewport(boxes, { width, height }, OPEN_ZOOM_RANGE);
    if (!viewport) return;
    applied.current = true;
    void setViewport(viewport);
  }, [nodesInitialized, getNodes, setViewport, flowStore]);
}
