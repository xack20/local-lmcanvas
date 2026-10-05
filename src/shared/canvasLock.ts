/** Why the Mac refuses to save a canvas: another window or browser tab holds it. */
export const CANVAS_LOCKED_MESSAGE = "This chat is open on another device.";

/** Matches the refusal however it arrives (Electron prefixes IPC errors with the channel). */
export function isCanvasLockedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(CANVAS_LOCKED_MESSAGE);
}
