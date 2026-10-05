// src/main/claude/replayFit.test.mjs
import { describe, expect, test } from "bun:test";
import { chunkText, estimateTokens, fittedPrompt, planReplay, trimToFit } from "./replayFit.ts";

const msg = (role, chars, tag = role) => ({ id: `${tag}-${chars}`, role, createdAt: 1, blocks: [{ type: "text", text: tag[0].repeat(chars) }] });

describe("planReplay", () => {
  test("a small history fits as-is", () => {
    const plan = planReplay({ history: [msg("user", 400), msg("assistant", 400)], newPrompt: "next", window: 200_000, setupTokens: 20_000 });
    expect(plan.fits).toBe(true);
  });

  test("a big history keeps recent messages verbatim within half the budget and hands back the older text", () => {
    const history = [msg("user", 400_000, "old-u"), msg("assistant", 400_000, "old-a"), msg("user", 40_000, "new-u"), msg("assistant", 40_000, "new-a")];
    const plan = planReplay({ history, newPrompt: "next", window: 200_000, setupTokens: 20_000 });
    expect(plan.fits).toBe(false);
    expect(plan.budget).toBe(140_000);
    expect(plan.recent.map((m) => m.id)).toEqual(["new-u-40000", "new-a-40000"]);
    expect(plan.olderText).toContain("[User]");
    expect(plan.olderText.length).toBeGreaterThan(790_000);
  });

  test("cuts a single oversized message instead of sending or dropping it whole", () => {
    const plan = planReplay({ history: [msg("user", 2_000_000, "giant")], newPrompt: "next", window: 200_000, setupTokens: 20_000 });
    expect(plan.fits).toBe(false);
    expect(plan.recent).toEqual([]);
    expect(estimateTokens(trimToFit([msg("user", 2_000_000, "giant")], "next", plan.budget))).toBeLessThanOrEqual(plan.budget);
  });
});

describe("chunkText / fittedPrompt / trimToFit", () => {
  test("chunks at section boundaries within the limit", () => {
    const text = ["[User]\n" + "a".repeat(50), "[Assistant]\n" + "b".repeat(50), "[User]\n" + "c".repeat(50)].join("\n\n");
    const chunks = chunkText(text, 130);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= 130)).toBe(true);
    expect(chunks.join("\n\n")).toBe(text);
  });

  test("fittedPrompt puts the summary first, then the recent messages and the new prompt", () => {
    const prompt = fittedPrompt("We decided X.", [msg("user", 3, "recent")], "next");
    expect(prompt.startsWith("[Summary of the earlier conversation]\nWe decided X.")).toBe(true);
    expect(prompt).toContain("[User]\nrrr");
    expect(prompt.endsWith("[User]\nnext\n\n[Assistant]")).toBe(true);
  });

  test("trimToFit drops the oldest messages first and keeps the new prompt", () => {
    const history = [msg("user", 400_000, "old"), msg("assistant", 4_000, "kept")];
    const prompt = trimToFit(history, "next", 50_000);
    expect(prompt).not.toContain("o".repeat(100));
    expect(prompt).toContain("k".repeat(100));
    expect(prompt.endsWith("[User]\nnext\n\n[Assistant]")).toBe(true);
  });
});
