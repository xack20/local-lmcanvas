import type { WheelEvent } from "react";

export function forwardWheelAtBoundary(e: WheelEvent<HTMLElement>): void {
  const el = e.currentTarget;
  const isScrollable = el.scrollHeight > el.clientHeight;
  if (!isScrollable) return;

  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;

  const goingUp = e.deltaY < 0;
  const goingDown = e.deltaY > 0;

  if ((goingUp && !atTop) || (goingDown && !atBottom)) {
    e.stopPropagation();
  }
}

/** For onWheelCapture on a sideways-scrolling area: React Flow pans on its own native listener before a
 *  bubbling onWheel runs, so only the capture phase can keep a sideways scroll in the area. Up/down
 *  scrolls, pinches and scrolls past the edge go on to move the canvas. */
export function keepSidewaysScroll(
  e: Pick<WheelEvent<HTMLElement>, "deltaX" | "deltaY" | "ctrlKey" | "stopPropagation"> & {
    currentTarget: Pick<HTMLElement, "scrollLeft" | "clientWidth" | "scrollWidth">;
  },
): void {
  if (e.ctrlKey || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  const el = e.currentTarget;
  const canScroll =
    e.deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  if (canScroll) e.stopPropagation();
}
