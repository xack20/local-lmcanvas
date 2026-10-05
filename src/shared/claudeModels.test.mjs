// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import {
  FALLBACK_CLAUDE_MODELS,
  claudeEffortFor,
  claudeModelArg,
  effortsForClaudeModel,
  findClaudeModel,
  isClaudeModelId,
  normalizeClaudeModels,
  resolveClaudeRun,
} from "./claudeModels.ts";
import { CLAUDE_EFFORTS } from "./types.ts";

// Shape returned by the Agent SDK's supportedModels() (trimmed).
const SDK_MODELS = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "For complex work and everyday tasks",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest" },
  {
    value: "claude-opus-4-6",
    resolvedModel: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "Best for everyday, complex tasks",
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
];

describe("normalizeClaudeModels", () => {
  test("keeps value, names, resolved id and Claude effort levels", () => {
    const models = normalizeClaudeModels(SDK_MODELS);
    expect(models.map((m) => m.value)).toEqual(["default", "opus", "haiku", "claude-opus-4-6"]);
    expect(models[1]).toEqual({
      value: "opus",
      displayName: "Opus 5.5",
      description: "For complex work and everyday tasks",
      resolvedModel: "claude-opus-5-5",
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(models[2].supportedEffortLevels).toEqual([]);
  });

  test("drops malformed and duplicate entries and unknown effort levels", () => {
    const models = normalizeClaudeModels([
      null,
      { displayName: "no value" },
      { value: "  " },
      { value: "sonnet", supportedEffortLevels: ["low", "ultra", 7] },
      { value: "sonnet", displayName: "duplicate" },
    ]);
    expect(models).toEqual([
      { value: "sonnet", displayName: "sonnet", description: "", supportedEffortLevels: ["low"] },
    ]);
  });

  test("returns an empty list for anything that isn't an array", () => {
    expect(normalizeClaudeModels(undefined)).toEqual([]);
    expect(normalizeClaudeModels({ value: "opus" })).toEqual([]);
  });
});

describe("findClaudeModel", () => {
  const models = normalizeClaudeModels(SDK_MODELS);

  test("matches an alias or pinned id exactly", () => {
    expect(findClaudeModel(models, "haiku")?.displayName).toBe("Haiku 4.5");
    expect(findClaudeModel(models, "claude-opus-4-6")?.displayName).toBe("Opus 4.6");
  });

  test("matches a full model id through the alias it resolves to, preferring a named alias over default", () => {
    expect(findClaudeModel(models, "claude-opus-5-5")?.value).toBe("opus");
  });

  test("returns undefined for an unknown or empty id", () => {
    expect(findClaudeModel(models, "claude-unknown-9")).toBeUndefined();
    expect(findClaudeModel(models, undefined)).toBeUndefined();
  });
});

describe("effortsForClaudeModel", () => {
  const models = normalizeClaudeModels(SDK_MODELS);

  test("lists only the levels the model supports", () => {
    expect(effortsForClaudeModel(models, "claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(effortsForClaudeModel(models, "haiku")).toEqual([]);
  });

  test("uses Claude Code's default model when none is set", () => {
    expect(effortsForClaudeModel(models, undefined)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("allows every level for a model it doesn't know", () => {
    expect(effortsForClaudeModel(models, "claude-unknown-9")).toEqual([...CLAUDE_EFFORTS]);
  });
});

describe("claudeModelArg", () => {
  test("passes no --model for Claude Code's own default", () => {
    expect(claudeModelArg(undefined)).toBeUndefined();
    expect(claudeModelArg("")).toBeUndefined();
    expect(claudeModelArg("default")).toBeUndefined();
  });

  test("passes aliases and ids through, trimmed", () => {
    expect(claudeModelArg(" opus ")).toBe("opus");
    expect(claudeModelArg("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(claudeModelArg("us.anthropic.claude-opus-4-6-v1:0")).toBe("us.anthropic.claude-opus-4-6-v1:0");
    expect(claudeModelArg("claude-opus-4-6[1m]")).toBe("claude-opus-4-6[1m]");
  });

  test("never turns something that isn't a model id into a CLI argument", () => {
    expect(claudeModelArg("--dangerously-skip-permissions")).toBeUndefined();
    expect(claudeModelArg("opus --verbose")).toBeUndefined();
    expect(claudeModelArg("x".repeat(201))).toBeUndefined();
  });
});

describe("isClaudeModelId", () => {
  test("accepts aliases, ids and provider-decorated ids, rejects flags and spaces", () => {
    expect(["opus", "default", "claude-sonnet-4-6", "claude-x@20250101", "claude-opus-4-6[1m]"].every(isClaudeModelId)).toBe(true);
    expect(["", " ", "-x", "--model", "a b", 42, undefined].some(isClaudeModelId)).toBe(false);
  });
});

describe("FALLBACK_CLAUDE_MODELS", () => {
  test("offers Claude Code's aliases when the live list can't be read", () => {
    expect(FALLBACK_CLAUDE_MODELS.map((m) => m.value)).toEqual(["default", "opus", "fable", "sonnet", "haiku"]);
    expect(effortsForClaudeModel(FALLBACK_CLAUDE_MODELS, "haiku")).toEqual([]);
  });
});

describe("effort support edge cases", () => {
  test("a model that supports effort but lists no levels allows them all", () => {
    const [model] = normalizeClaudeModels([{ value: "opus", supportsEffort: true }]);
    expect(model.supportedEffortLevels).toEqual([...CLAUDE_EFFORTS]);
  });

  test("an unknown Haiku id takes no effort, even without the live list", () => {
    expect(effortsForClaudeModel([], "claude-haiku-4-5-20251001")).toEqual([]);
    expect(effortsForClaudeModel(FALLBACK_CLAUDE_MODELS, "claude-haiku-9")).toEqual([]);
  });
});

describe("resolveClaudeRun", () => {
  const models = normalizeClaudeModels(SDK_MODELS);

  test("a node's model wins over Settings and the legacy setting", () => {
    expect(resolveClaudeRun({ nodeModel: "haiku", settingsModel: "opus", legacyModel: "claude-fable-5", models }).model).toBe("haiku");
  });

  test("an empty Settings model means Claude Code's default; an unset one falls back to the legacy setting", () => {
    expect(resolveClaudeRun({ settingsModel: "", legacyModel: "claude-fable-5", models }).model).toBeUndefined();
    expect(resolveClaudeRun({ legacyModel: "claude-fable-5", models }).model).toBe("claude-fable-5");
  });

  test("an invalid node model is ignored rather than passed to --model", () => {
    expect(resolveClaudeRun({ nodeModel: "--verbose", settingsModel: "opus", models }).model).toBe("opus");
  });

  test("reports the full model id for policy checks, including Claude Code's default", () => {
    expect(resolveClaudeRun({ nodeModel: "opus", models }).resolvedModel).toBe("claude-opus-5-5");
    expect(resolveClaudeRun({ settingsModel: "", models }).resolvedModel).toBe("claude-opus-5-5");
    expect(resolveClaudeRun({ nodeModel: "claude-unknown-9", models }).resolvedModel).toBe("claude-unknown-9");
  });

  test("drops an effort the model can't take and keeps one it can", () => {
    expect(resolveClaudeRun({ nodeModel: "haiku", requestedEffort: "high", models }).reasoningEffort).toBeUndefined();
    expect(resolveClaudeRun({ nodeModel: "claude-opus-4-6", requestedEffort: "xhigh", models }).reasoningEffort).toBeUndefined();
    expect(resolveClaudeRun({ nodeModel: "claude-opus-4-6", requestedEffort: "max", models }).reasoningEffort).toBe("max");
  });

  test("without the live list, keeps the effort unless the model is a Haiku", () => {
    expect(resolveClaudeRun({ nodeModel: "opus", requestedEffort: "xhigh", models: null }).reasoningEffort).toBe("xhigh");
    expect(resolveClaudeRun({ nodeModel: "claude-haiku-4-5", requestedEffort: "low", models: null }).reasoningEffort).toBeUndefined();
  });
});

describe("claudeEffortFor", () => {
  test("re-checks an effort for a different model, such as a policy fallback", () => {
    const models = normalizeClaudeModels(SDK_MODELS);
    expect(claudeEffortFor(models, "claude-opus-4-6", "xhigh")).toBeUndefined();
    expect(claudeEffortFor(models, "opus", "xhigh")).toBe("xhigh");
    expect(claudeEffortFor(models, "opus", undefined)).toBeUndefined();
  });
});

describe("claudeEffortFor with other providers' levels", () => {
  test("passes a non-Claude effort through untouched (Codex's own levels)", () => {
    expect(claudeEffortFor([], "opus", "ultra")).toBe("ultra");
  });
});
