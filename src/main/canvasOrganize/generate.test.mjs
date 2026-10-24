// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { organizeTimeoutMs } from "./generate.ts";

describe("organizeTimeoutMs", () => {
  test("grows with the canvas so a large one isn't cut off, within a ceiling", () => {
    // A 29-node canvas took 87 s.
    expect(organizeTimeoutMs(29)).toBeGreaterThanOrEqual(170_000);
    expect(organizeTimeoutMs(100)).toBeGreaterThan(organizeTimeoutMs(29));
    expect(organizeTimeoutMs(5_000)).toBe(600_000);
    expect(organizeTimeoutMs(0)).toBeGreaterThanOrEqual(60_000);
  });
});
