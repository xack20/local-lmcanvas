// Geometry of the label drawn above each node when zoomed out (GroupSummaryOverlay). It lives here
// so the organize layout can leave room for it.

/** At or below this zoom, group overlays replace the per-node labels. */
export const NODE_LABEL_HIDE_ZOOM = 0.15;
// Labels stay 11–16 px on screen, so they grow in canvas units as you zoom out.
const LABEL_MIN_SCREEN_PX = 11;
const LABEL_MAX_SCREEN_PX = 16;
/** A label's top sits this many font sizes above its node. */
export const NODE_LABEL_LINE_OFFSET = 1.5;
/** …plus this much more above a node with a quote banner on top. */
export const NODE_LABEL_CONTEXT_OFFSET = 32;

/** A label's font size in canvas units at `zoom`. */
export function nodeLabelFontSize(zoom: number): number {
  const z = zoom > 0 ? zoom : 1;
  return Math.max(LABEL_MIN_SCREEN_PX, Math.min(LABEL_MAX_SCREEN_PX, LABEL_MIN_SCREEN_PX * z)) / z;
}

/** How far above its node's top a label reaches, in canvas units. */
export function nodeLabelReach(zoom: number, hasContext: boolean): number {
  return nodeLabelFontSize(zoom) * NODE_LABEL_LINE_OFFSET + (hasContext ? NODE_LABEL_CONTEXT_OFFSET : 0);
}
