import type { CanvasNode } from "@shared/types";
import { RIGHT_LANE_X_OFFSET, RIGHT_LANE_Y_OFFSET } from "./canvasConstants";

/** Where ⌘+B puts a new blank child: the parent's right lane. The collision
 *  resolver then pushes any earlier sibling it lands on further right. */
export function keyboardBranchPosition(parent: Pick<CanvasNode, "position">): { x: number; y: number } {
  return {
    x: parent.position.x + RIGHT_LANE_X_OFFSET,
    y: parent.position.y + RIGHT_LANE_Y_OFFSET,
  };
}
