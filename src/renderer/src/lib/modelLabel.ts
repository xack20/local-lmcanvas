import type { ClaudeModelInfo } from "@shared/types";
import { CLAUDE_DEFAULT_MODEL, findClaudeModel } from "@shared/claudeModels";

const FAMILY = "(?<family>opus|sonnet|haiku|fable)";
const VERSION = "(?<major>\\d{1,2})(?:[-._](?<minor>\\d{1,2}))?";

// Legacy ids put the version first: claude-3-5-sonnet-20241022.
const VERSION_FIRST_ID = new RegExp(`claude-${VERSION}-${FAMILY}(?![a-z])`);
// Current ids put the family first: claude-haiku-4-5-20251001. The trailing
// lookahead stops a date suffix being read as the minor version.
const FAMILY_FIRST_ID = new RegExp(
  `claude-${FAMILY}(?![a-z])(?:[-._]${VERSION})?(?!\\d)`,
);
const BARE_ALIAS = new RegExp(`^${FAMILY}(?:\\[[^\\]]*\\])?$`);

export function claudeModelLabel(modelId: string): string {
  const id = modelId.trim().toLowerCase();
  const groups =
    id.match(VERSION_FIRST_ID)?.groups ??
    id.match(FAMILY_FIRST_ID)?.groups ??
    id.match(BARE_ALIAS)?.groups;
  if (!groups?.family) return modelId;

  const name = groups.family.charAt(0).toUpperCase() + groups.family.slice(1);
  if (!groups.major) return name;
  return groups.minor
    ? `${name} ${groups.major}.${groups.minor}`
    : `${name} ${groups.major}`;
}

/** Badge text for a Claude model id: Claude Code's name for it, with its default shown as the model it resolves to. */
export function claudeModelBadgeLabel(
  models: readonly ClaudeModelInfo[],
  id: string | undefined,
): string {
  const model = findClaudeModel(models, id ?? CLAUDE_DEFAULT_MODEL);
  if (!model) return id ? claudeModelLabel(id) : "Default";
  if (model.value !== CLAUDE_DEFAULT_MODEL) return model.displayName;
  return model.resolvedModel ? claudeModelLabel(model.resolvedModel) : model.displayName;
}
