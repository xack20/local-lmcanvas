export type CanvasLockState = "held" | "conflict" | "lost" | null;
export type LockHolderKind = "desktop" | "browser" | null;

export function lockOverlayText(
  state: CanvasLockState,
  holder: LockHolderKind,
  replyRunning = false,
): { title: string; detail: string } | null {
  if (state === "conflict") {
    return {
      title:
        holder === "desktop"
          ? "This chat is open in the desktop app."
          : "This chat is open in another browser tab or device.",
      detail: replyRunning
        ? "A reply is still running there. Taking over stops it."
        : "Only one place can edit a chat at a time.",
    };
  }
  if (state === "lost") {
    return {
      title: "This chat was opened somewhere else.",
      detail:
        "It's read-only here. Anything not yet saved here is replaced by the latest version if you take it back.",
    };
  }
  return null;
}
