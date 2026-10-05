// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { claudeModelLabel } from "./modelLabel.ts";

describe("claudeModelLabel", () => {
  test.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-fable-5", "Fable 5"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-opus-4-20250514", "Opus 4"],
  ])("labels current model id %s as %s", (id, label) => {
    expect(claudeModelLabel(id)).toBe(label);
  });

  test.each([
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["claude-3-opus-20240229", "Opus 3"],
  ])("labels legacy version-first id %s as %s", (id, label) => {
    expect(claudeModelLabel(id)).toBe(label);
  });

  test.each([
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "Sonnet 4.5"],
    ["claude-sonnet-4-5@20250929", "Sonnet 4.5"],
    ["claude-opus-5-5[1m]", "Opus 5.5"],
    ["  CLAUDE-OPUS-5-5  ", "Opus 5.5"],
  ])("labels provider-prefixed or decorated id %s as %s", (id, label) => {
    expect(claudeModelLabel(id)).toBe(label);
  });

  test.each([
    ["claude-sonnet-4.5", "Sonnet 4.5"],
    ["anthropic/claude-sonnet-4.5", "Sonnet 4.5"],
    ["claude-opus-4.1", "Opus 4.1"],
    ["claude-sonnet-4_5", "Sonnet 4.5"],
    ["claude-3.5-sonnet", "Sonnet 3.5"],
  ])("labels dotted or underscored id %s as %s", (id, label) => {
    expect(claudeModelLabel(id)).toBe(label);
  });

  test.each([
    ["opus", "Opus"],
    ["sonnet[1m]", "Sonnet"],
    ["sonnet", "Sonnet"],
    ["claude-fable", "Fable"],
  ])("labels versionless alias %s as %s", (id, label) => {
    expect(claudeModelLabel(id)).toBe(label);
  });

  test.each([
    "gpt-5.6-sol",
    "my-custom-model",
    "opus-mt-en-de",
    "fabled-7b",
    "unfabled",
    "sonnets-8b",
    "mistral-sonnet-7b",
    "llama-3-sonnet-70b",
    "qwen3-haiku-32b",
  ])("returns non-Claude id %s unchanged", (id) => {
    expect(claudeModelLabel(id)).toBe(id);
  });
});
