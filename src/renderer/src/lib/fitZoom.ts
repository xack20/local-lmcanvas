// Share of the visible width a focused node may fill, leaving a margin.
const FIT_MARGIN = 0.9;

export function fitZoom(requestedZoom: number, nodeWidth: number, visibleWidth: number): number {
  if (nodeWidth <= 0 || visibleWidth <= 0) return requestedZoom;
  return Math.min(requestedZoom, (visibleWidth * FIT_MARGIN) / nodeWidth);
}
