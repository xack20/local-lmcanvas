// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { nodeModelPatch, settingsModelChoice } from "./claudeModelChoice.ts";

const MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high", "xhigh"] },
  { value: "opus", displayName: "Opus 5.5", description: "", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high", "xhigh"] },
  { value: "haiku", displayName: "Haiku 4.5", description: "", supportedEffortLevels: [] },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "", supportedEffortLevels: ["low", "high"] },
];

describe("nodeModelPatch", () => {
  test("sets the node's model and keeps an effort the model takes", () => {
    expect(nodeModelPatch({ models: MODELS, model: "opus", isClaude: true, storedEffort: "high" })).toEqual({ model: "opus" });
  });

  test("drops an effort the new model can't take", () => {
    expect(nodeModelPatch({ models: MODELS, model: "haiku", isClaude: true, storedEffort: "high" })).toEqual({
      model: "haiku",
      reasoningEffort: undefined,
    });
    expect(nodeModelPatch({ models: MODELS, model: "claude-opus-4-6", isClaude: true, storedEffort: "xhigh" })).toEqual({
      model: "claude-opus-4-6",
      reasoningEffort: undefined,
    });
  });

  test("going back to the Settings model removes the override and checks the effort against Settings' model", () => {
    expect(nodeModelPatch({ models: MODELS, model: undefined, settingsModel: "haiku", isClaude: true, storedEffort: "low" })).toEqual({
      model: undefined,
      reasoningEffort: undefined,
    });
    expect(nodeModelPatch({ models: MODELS, model: undefined, settingsModel: "opus", isClaude: true, storedEffort: "low" })).toEqual({
      model: undefined,
    });
  });

  test("moves a node on another provider to Claude and drops its provider-specific effort", () => {
    expect(nodeModelPatch({ models: MODELS, model: "opus", isClaude: false, storedEffort: "ultra" })).toEqual({
      model: "opus",
      provider: "claude",
      reasoningEffort: undefined,
    });
  });
});

describe("settingsModelChoice", () => {
  test("an empty Settings model selects Claude Code's default", () => {
    expect(settingsModelChoice(MODELS, "")).toEqual({ selected: "", custom: undefined });
    expect(settingsModelChoice(MODELS, undefined)).toEqual({ selected: "", custom: undefined });
  });

  test("a full id selects the alias it resolves to", () => {
    expect(settingsModelChoice(MODELS, "claude-opus-5-5")).toEqual({ selected: "opus", custom: undefined });
  });

  test("an id Claude Code doesn't list is kept as a custom choice", () => {
    expect(settingsModelChoice(MODELS, "claude-x-1")).toEqual({ selected: "claude-x-1", custom: "claude-x-1" });
  });

  test("an id that only Claude Code's default entry resolves to selects the default option", () => {
    const onlyDefault = [{ value: "default", displayName: "Default", description: "", resolvedModel: "claude-z-1", supportedEffortLevels: [] }];
    expect(settingsModelChoice(onlyDefault, "claude-z-1")).toEqual({ selected: "", custom: undefined });
  });

  test("while the list is loading, the stored value is kept without calling it custom", () => {
    expect(settingsModelChoice(null, "claude-opus-5-5")).toEqual({ selected: "claude-opus-5-5", custom: undefined });
  });
});
