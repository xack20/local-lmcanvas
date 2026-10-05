// src/shared/contextSize.test.mjs — .mjs keeps bun:test out of typecheck.
import { describe, expect, test } from "bun:test";
import { compactionText, contextLabel, contextLevel, contextView, formatTokens } from "./contextSize.ts";

const ctx = (tokens, extra = {}) => ({ tokens, window: 1_000_000, autoCompactEnabled: true, exact: true, measuredAt: 1, ...extra });
const node = (id, parentIds, context, messages = []) => ({
  id, type: "custom", position: { x: 0, y: 0 },
  data: { chat: { messages, parentIds, childIds: [] }, ...(context ? { context } : {}) },
});
const text = (role, t) => ({ id: `${role}-${t.length}`, role, createdAt: 1, blocks: [{ type: "text", text: t }] });

describe("formatTokens", () => {
  test("uses k and M", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(412_000)).toBe("412k");
    expect(formatTokens(1_300_000)).toBe("1.3M");
    expect(formatTokens(1_000_000)).toBe("1M");
  });
});

describe("contextView", () => {
  const nodes = {
    root: node("root", [], ctx(12_000)),
    two: node("two", ["root"], ctx(42_000)),
    three: node("three", ["two"], ctx(60_000)),
  };

  test("the root shows only its own size, which is also everything the model holds", () => {
    const view = contextView("root", nodes);
    expect(view).toMatchObject({ isRoot: true, own: 12_000, combined: 12_000, exact: true });
    expect(contextLabel(view)).toBe("12k");
  });

  test("other nodes show their own size and the combined size from the root", () => {
    expect(contextLabel(contextView("two", nodes))).toBe("+30k · 42k");
    expect(contextLabel(contextView("three", nodes))).toBe("+18k · 60k");
  });

  test("a merge node measures its own size against its largest parent", () => {
    const merged = { ...nodes, other: node("other", ["root"], ctx(20_000)), merge: node("merge", ["two", "other"], ctx(50_000)) };
    expect(contextView("merge", merged).own).toBe(8_000);
  });

  test("own size never goes negative after a compaction", () => {
    const compacted = { ...nodes, four: node("four", ["three"], ctx(30_000)) };
    expect(contextView("four", compacted).own).toBe(0);
  });

  test("a dangling parent counts as a root", () => {
    const lonely = { x: node("x", ["missing"], ctx(5_000)) };
    expect(contextView("x", lonely)).toMatchObject({ isRoot: true, own: 5_000 });
  });

  test("unmeasured nodes get a marked estimate built on the nearest measured ancestor", () => {
    const withNew = { ...nodes, four: node("four", ["three"], undefined, [text("user", "a".repeat(4_000)), text("assistant", "b".repeat(8_000))]) };
    const view = contextView("four", withNew);
    expect(view.exact).toBe(false);
    expect(view.combined).toBe(63_000);
    expect(view.own).toBe(3_000);
    expect(contextLabel(view)).toBe("~+3k · ~63k");
  });

  test("an unmeasured root estimates its text plus the setup allowance", () => {
    const view = contextView("r", { r: node("r", [], undefined, [text("user", "a".repeat(400))]) });
    expect(view).toMatchObject({ exact: false, combined: 20_100, window: 200_000 });
  });

  test("percent and level follow the window, with the window inherited from the nearest measured ancestor", () => {
    const big = { a: node("a", [], ctx(750_000)), b: node("b", ["a"], undefined, []) };
    expect(contextView("a", big)).toMatchObject({ percent: 0.75, level: "warn" });
    expect(contextView("b", big).window).toBe(1_000_000);
  });

  test("counts compactions along the path", () => {
    const compactedPath = {
      a: node("a", [], ctx(10_000), [{ id: "m", role: "assistant", createdAt: 1, blocks: [{ type: "compaction", trigger: "auto", before: 900_000, after: 60_000 }] }]),
      b: node("b", ["a"], ctx(20_000)),
    };
    expect(contextView("b", compactedPath).compactions).toBe(1);
  });

  test("returns null for an unknown node", () => {
    expect(contextView("nope", nodes)).toBeNull();
  });
});

describe("contextLevel and compactionText", () => {
  test("amber from 70%, red from 90%", () => {
    expect(contextLevel(0.69)).toBe("ok");
    expect(contextLevel(0.7)).toBe("warn");
    expect(contextLevel(0.9)).toBe("full");
  });

  test("divider texts", () => {
    expect(compactionText({ type: "compaction", trigger: "auto", before: 940_000, after: 62_000 })).toBe("Context compacted: 940k → 62k (auto)");
    expect(compactionText({ type: "compaction", trigger: "manual", before: 412_000, after: 38_000 })).toBe("Context compacted: 412k → 38k (manual)");
    expect(compactionText({ type: "compaction", trigger: "replay", before: 1_300_000, after: 180_000, method: "summary" })).toBe("Earlier messages were summarized to fit: 1.3M → 180k");
    expect(compactionText({ type: "compaction", trigger: "replay", before: null, after: null, method: "trimmed" })).toBe("Earlier messages were left out to fit");
    expect(compactionText({ type: "compaction", trigger: "auto", before: null, after: null })).toBe("Context compacted (auto)");
  });
});

describe("contextView on big canvases", () => {
  test("sizes a long unmeasured chain quickly once its nodes have been seen", () => {
    // Badges and bars re-run contextView for every node on every store change (each streamed flush).
    const nodes = {};
    let previous;
    for (let i = 0; i < 300; i += 1) {
      const id = `n${i}`;
      nodes[id] = node(id, previous ? [previous] : [], undefined, [text("user", "u".repeat(5_000)), text("assistant", "a".repeat(5_000))]);
      previous = id;
    }
    const ids = Object.keys(nodes);
    for (const id of ids) contextView(id, nodes);
    const started = performance.now();
    for (const id of ids) contextView(id, nodes);
    expect(performance.now() - started).toBeLessThan(25);
  });
});
