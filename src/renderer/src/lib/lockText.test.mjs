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
  });
  test("shows nothing while the chat is held here", () => {
    expect(lockOverlayText("held", null)).toBeNull();
    expect(lockOverlayText(null, null)).toBeNull();
  });
});
