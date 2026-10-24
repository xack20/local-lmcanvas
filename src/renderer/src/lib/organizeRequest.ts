import type { CanvasLockState } from "./lockText";

export type OrganizeRequestAction = "ignore" | "wait" | "run" | "refuse";

export const ORGANIZE_HELD_ELSEWHERE = "This canvas is open somewhere else. Take it over here, then organize.";

/** What a pane does with a pending Organize request. A request that can't run here is refused at
 *  once, so it can't fire unexpectedly much later in the session. */
export function decideOrganizeRequest(
  requestedCanvasId: string,
  pane: {
    paneCanvasId: string;
    shownCanvasId: string | null;
    loaded: boolean;
    error: string | null;
    lock: CanvasLockState;
  },
): OrganizeRequestAction {
  if (requestedCanvasId !== pane.paneCanvasId) return "ignore";
  if (pane.error) return "refuse";
  if (!pane.loaded || pane.shownCanvasId !== pane.paneCanvasId) return "wait";
  return pane.lock === "held" ? "run" : "refuse";
}
