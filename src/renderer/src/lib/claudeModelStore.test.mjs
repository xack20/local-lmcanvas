// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { createClaudeModelStore } from "./claudeModelStore.ts";
import { FALLBACK_CLAUDE_MODELS } from "../../../shared/claudeModels.ts";

const A = { models: [{ value: "opus", displayName: "Opus 5.5", description: "", supportedEffortLevels: [] }], live: true };
const B = { models: [...A.models, { value: "claude-opus-6", displayName: "Opus 6", description: "", supportedEffortLevels: [] }], live: true };

function harness(answers) {
  let time = 0;
  let calls = 0;
  const store = createClaudeModelStore(
    async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    { now: () => time, minIntervalMs: 30_000 },
  );
  let notified = 0;
  store.subscribe(() => (notified += 1));
  return { store, calls: () => calls, notified: () => notified, advance: (ms) => (time += ms) };
}

describe("createClaudeModelStore", () => {
  test("starts empty and publishes the first list", async () => {
    const h = harness([A]);
    expect(h.store.getSnapshot()).toBeNull();
    await h.store.refresh();
    expect(h.store.getSnapshot()).toEqual(A);
    expect(h.notified()).toBe(1);
  });

  test("an unchanged answer doesn't re-render anyone; a changed one does", async () => {
    const h = harness([A, A, B]);
    await h.store.refresh();
    await h.store.refresh({ force: true });
    expect(h.notified()).toBe(1);
    await h.store.refresh({ force: true });
    expect(h.store.getSnapshot()).toEqual(B);
    expect(h.notified()).toBe(2);
  });

  test("automatic refreshes are throttled; forced ones (picker opened, Settings saved) are not", async () => {
    const h = harness([A]);
    await h.store.refresh();
    await h.store.refresh();
    expect(h.calls()).toBe(1);
    h.advance(31_000);
    await h.store.refresh();
    expect(h.calls()).toBe(2);
    await h.store.refresh({ force: true });
    expect(h.calls()).toBe(3);
  });

  test("overlapping refreshes share one request", async () => {
    const h = harness([A]);
    await Promise.all([h.store.refresh({ force: true }), h.store.refresh({ force: true })]);
    expect(h.calls()).toBe(1);
  });

  test("a failed request shows Claude Code's aliases at first, but never replaces a list it already has", async () => {
    const empty = harness([new Error("ipc down")]);
    await empty.store.refresh();
    expect(empty.store.getSnapshot()).toEqual({ models: [...FALLBACK_CLAUDE_MODELS], live: false });

    const loaded = harness([A, new Error("ipc down")]);
    await loaded.store.refresh();
    await loaded.store.refresh({ force: true });
    expect(loaded.store.getSnapshot()).toEqual(A);
  });
});
