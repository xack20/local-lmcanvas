// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { organizeTimeoutMs, sanitizeRequest } from "./generate.ts";

describe("sanitizeRequest", () => {
  const entry = (i, extra = {}) => ({ id: `n${i}`, children: [], prompt: "p", reply: "r", ...extra });

  test("cuts long text and drops what isn't text, so a paired device can't send an unbounded prompt", () => {
    const request = sanitizeRequest({
      nodes: [entry(1, { prompt: "p".repeat(10_000), reply: "r".repeat(10_000), title: "t".repeat(500), parent: 7, children: ["n2", 3] })],
    });
    const [n] = request.nodes;
    expect(n.prompt.length).toBeLessThanOrEqual(300);
    expect(n.reply.length).toBeLessThanOrEqual(300);
    expect(n.title.length).toBeLessThanOrEqual(300);
    expect(n.parent).toBeUndefined();
    expect(n.children).toEqual(["n2"]);
  });

  test("refuses a malformed request or one with more nodes than any canvas has", () => {
    expect(sanitizeRequest(null)).toBeNull();
    expect(sanitizeRequest({ nodes: [{ children: [] }] })).toBeNull();
    expect(sanitizeRequest({ nodes: [] })).toBeNull();
    expect(sanitizeRequest({ nodes: Array.from({ length: 5_001 }, (_, i) => entry(i)) })).toBeNull();
  });
});

describe("organizeTimeoutMs", () => {
  test("grows with the canvas so a large one isn't cut off, within a ceiling", () => {
    // A 29-node canvas took 87 s.
    expect(organizeTimeoutMs(29)).toBeGreaterThanOrEqual(170_000);
    expect(organizeTimeoutMs(100)).toBeGreaterThan(organizeTimeoutMs(29));
    expect(organizeTimeoutMs(5_000)).toBe(600_000);
    expect(organizeTimeoutMs(0)).toBeGreaterThanOrEqual(60_000);
  });
});
