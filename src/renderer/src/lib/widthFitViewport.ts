import { fitZoom } from "./fitZoom";

export type NodeBox = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type ZoomRange = { min: number; max: number };
export type Viewport = { x: number; y: number; zoom: number };

const TOP_PADDING_PX = 40;

// Opening view: zoom so every node fits across the window's width, then
// centre the chat vertically if it fits, or start at its top if it's taller.
export function widthFitViewport(
  boxes: readonly NodeBox[],
  visible: Size,
  zoomRange: ZoomRange,
): Viewport | null {
  if (boxes.length === 0 || visible.width <= 0 || visible.height <= 0) return null;

  const minX = Math.min(...boxes.map((b) => b.x));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));

  const fitted = fitZoom(zoomRange.max, maxX - minX, visible.width);
  const zoom = Math.max(zoomRange.min, Math.min(zoomRange.max, fitted));

  const contentWidth = (maxX - minX) * zoom;
  const contentHeight = (maxY - minY) * zoom;
  const x = (visible.width - contentWidth) / 2 - minX * zoom;
  const y =
    contentHeight <= visible.height - 2 * TOP_PADDING_PX
      ? (visible.height - contentHeight) / 2 - minY * zoom
      : TOP_PADDING_PX - minY * zoom;
  return { x, y, zoom };
}
