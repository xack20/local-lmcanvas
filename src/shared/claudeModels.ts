import {
  CLAUDE_EFFORTS,
  isClaudeEffort,
  type ClaudeEffort,
  type ClaudeModelInfo,
  type ReasoningEffort,
} from "./types";

/** Claude Code's own default; selecting it means "pass no --model". */
export const CLAUDE_DEFAULT_MODEL = "default";

const ALL_EFFORTS: ClaudeEffort[] = [...CLAUDE_EFFORTS];

/** Claude Code's aliases, offered when the live list can't be read. */
export const FALLBACK_CLAUDE_MODELS: readonly ClaudeModelInfo[] = [
  { value: CLAUDE_DEFAULT_MODEL, displayName: "Default", description: "Claude Code's default model", supportedEffortLevels: ALL_EFFORTS },
  { value: "opus", displayName: "Opus", description: "Latest Opus", supportedEffortLevels: ALL_EFFORTS },
  { value: "fable", displayName: "Fable", description: "Latest Fable", supportedEffortLevels: ALL_EFFORTS },
  { value: "sonnet", displayName: "Sonnet", description: "Latest Sonnet", supportedEffortLevels: ALL_EFFORTS },
  { value: "haiku", displayName: "Haiku", description: "Latest Haiku", supportedEffortLevels: [] },
];

/** Validates the Agent SDK's supportedModels() result into ClaudeModelInfo entries. */
export function normalizeClaudeModels(raw: unknown): ClaudeModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((entry): ClaudeModelInfo[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { value, displayName, description, resolvedModel, supportedEffortLevels, supportsEffort } =
      entry as Record<string, unknown>;
    if (typeof value !== "string" || value.trim() === "" || seen.has(value)) return [];
    seen.add(value);
    return [
      {
        value,
        displayName: typeof displayName === "string" && displayName !== "" ? displayName : value,
        description: typeof description === "string" ? description : "",
        ...(typeof resolvedModel === "string" ? { resolvedModel } : {}),
        // The SDK marks the level list optional: effort support without a list means every level.
        supportedEffortLevels: Array.isArray(supportedEffortLevels)
          ? supportedEffortLevels.filter(isClaudeEffort)
          : supportsEffort === true
            ? [...ALL_EFFORTS]
            : [],
      },
    ];
  });
}

/** Finds a model by alias/id, or by the full id an alias resolves to (named aliases before `default`). */
export function findClaudeModel(
  models: readonly ClaudeModelInfo[],
  id: string | undefined,
): ClaudeModelInfo | undefined {
  const wanted = id?.trim();
  if (!wanted) return undefined;
  const exact = models.find((m) => m.value === wanted);
  if (exact) return exact;
  const resolvesTo = models.filter((m) => m.resolvedModel === wanted);
  return resolvesTo.find((m) => m.value !== CLAUDE_DEFAULT_MODEL) ?? resolvesTo[0];
}

/** Effort levels a model accepts; no model set means Claude Code's default. An unknown model
 *  allows every level, except a Haiku, which takes none. */
export function effortsForClaudeModel(
  models: readonly ClaudeModelInfo[],
  id: string | undefined,
): readonly ClaudeEffort[] {
  const model = findClaudeModel(models, id ?? CLAUDE_DEFAULT_MODEL);
  if (model) return model.supportedEffortLevels;
  return id && /haiku/i.test(id) ? [] : CLAUDE_EFFORTS;
}

/** The requested effort if the model takes it; nothing otherwise. `models` is null when the live list isn't known. */
export function claudeEffortFor(
  models: readonly ClaudeModelInfo[] | null,
  model: string | undefined,
  requested: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!isClaudeEffort(requested)) return requested;
  return effortsForClaudeModel(models ?? [], model).includes(requested) ? requested : undefined;
}

export type ClaudeRunInput = {
  nodeModel?: string;
  /** Settings → Claude model; "" means Claude Code's default. */
  settingsModel?: string;
  /** The older top-level claudeModel setting, used when Settings has no Claude model. */
  legacyModel?: string;
  requestedEffort?: ReasoningEffort;
  models: readonly ClaudeModelInfo[] | null;
};

export type ClaudeRunPlan = {
  /** `--model` to pass; undefined lets Claude Code choose. */
  model: string | undefined;
  /** Full id the run will use, when known (e.g. for the Fable policy fallback). */
  resolvedModel: string | undefined;
  reasoningEffort: ReasoningEffort | undefined;
};

/** Which Claude model and effort a chat runs with: the node's model, else Settings', else the legacy setting. */
export function resolveClaudeRun(input: ClaudeRunInput): ClaudeRunPlan {
  const nodeModel = isClaudeModelId(input.nodeModel) ? input.nodeModel : undefined;
  const model = claudeModelArg(nodeModel ?? input.settingsModel ?? input.legacyModel);
  const listed = input.models ?? [];
  const resolvedModel =
    model !== undefined
      ? (findClaudeModel(listed, model)?.resolvedModel ?? model)
      : findClaudeModel(listed, CLAUDE_DEFAULT_MODEL)?.resolvedModel;
  return {
    model,
    resolvedModel,
    reasoningEffort: claudeEffortFor(input.models, model, input.requestedEffort),
  };
}

// Aliases, ids, and Bedrock/Vertex/1M-context forms; never a flag or anything with spaces.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,199}$/;

export function isClaudeModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID_PATTERN.test(value);
}

/** The `--model` value to send: nothing for Claude Code's own default or for an invalid id. */
export function claudeModelArg(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return isClaudeModelId(trimmed) && trimmed !== CLAUDE_DEFAULT_MODEL ? trimmed : undefined;
}
