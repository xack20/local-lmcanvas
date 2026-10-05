// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { isImeComposing } from "./imeComposition.ts";

const keyEvent = (isComposing, keyCode = 13) => ({ nativeEvent: { isComposing }, keyCode });

describe("isImeComposing", () => {
  test("is true for the Enter that commits an input-method composition", () => {
    expect(isImeComposing(keyEvent(true))).toBe(true);
  });

  test("is true for the keyCode 229 keydown some engines send while composing", () => {
    expect(isImeComposing(keyEvent(false, 229))).toBe(true);
  });

  test("is false for a plain Enter, so normal typing still submits", () => {
    expect(isImeComposing(keyEvent(false, 13))).toBe(false);
  });
});
