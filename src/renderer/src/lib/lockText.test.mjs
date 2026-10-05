// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { lockOverlayText } from "./lockText.ts";

describe("lockOverlayText", () => {
  test("names where the chat is open", () => {
    expect(lockOverlayText("conflict", "desktop").title).toBe("This chat is open in the desktop app.");
    expect(lockOverlayText("conflict", "browser").title).toBe("This chat is open in another browser tab or device.");
  });
  test("explains a lost lock", () => {
    expect(lockOverlayText("lost", null).title).toBe("This chat was opened somewhere else.");
    expect(lockOverlayText("lost", null).detail).toContain("replaced");
  });
  test("shows nothing while the chat is held here", () => {
    expect(lockOverlayText("held", null)).toBeNull();
    expect(lockOverlayText(null, null)).toBeNull();
  });
});

describe("lockOverlayText with a running reply", () => {
  test("warns that taking over stops the reply", () => {
    const text = lockOverlayText("conflict", "desktop", true);
    expect(text.title).toBe("This chat is open in the desktop app.");
    expect(text.detail).toBe("A reply is still running there. Taking over stops it.");
  });
  test("says nothing about replies when none is running", () => {
    expect(lockOverlayText("conflict", "browser", false).detail).toBe("Only one place can edit a chat at a time.");
  });
});
