import type { ClaudeModelInfo, NodeSettings, ReasoningEffort } from "@shared/types";
import { CLAUDE_DEFAULT_MODEL, claudeEffortFor, findClaudeModel } from "@shared/claudeModels";

export type NodeModelChoice = {
  models: readonly ClaudeModelInfo[];
  /** The picked model; undefined means "follow Settings". */
  model: string | undefined;
  settingsModel?: string;
  /** Whether the node already runs on Claude. */
  isClaude: boolean;
  storedEffort: ReasoningEffort | undefined;
};

/** The node-settings change for picking a model: switch to Claude if needed, and drop an
 *  effort the resulting model can't take. */
export function nodeModelPatch(choice: NodeModelChoice): Partial<NodeSettings> {
  const effectiveModel = choice.model ?? choice.settingsModel;
  const keepsEffort =
    choice.isClaude &&
    claudeEffortFor(choice.models, effectiveModel, choice.storedEffort) === choice.storedEffort;
  return {
    model: choice.model,
    ...(choice.isClaude ? {} : { provider: "claude" as const }),
    ...(keepsEffort ? {} : { reasoningEffort: undefined }),
  };
}

/** Which Settings dropdown option a stored Claude model selects. "" is Claude Code's default;
 *  an id Claude Code doesn't list is offered as a custom choice once the list has loaded. */
export function settingsModelChoice(
  models: readonly ClaudeModelInfo[] | null,
  value: string | undefined,
): { selected: string; custom: string | undefined } {
  const wanted = value?.trim() || undefined;
  if (wanted === undefined || wanted === CLAUDE_DEFAULT_MODEL) return { selected: "", custom: undefined };
  if (models === null) return { selected: wanted, custom: undefined };
  const matched = findClaudeModel(models, wanted);
  if (!matched) return { selected: wanted, custom: wanted };
  // The dropdown offers Claude Code's default as "", not as its `default` entry.
  return { selected: matched.value === CLAUDE_DEFAULT_MODEL ? "" : matched.value, custom: undefined };
}
