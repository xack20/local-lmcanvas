import { CLAUDE_DEFAULT_MODEL } from "@shared/claudeModels";
import { useClaudeModelList, useRefreshClaudeModelsOnMount } from "@/hooks/useClaudeModels";
import { settingsModelChoice } from "@/lib/claudeModelChoice";
import { claudeModelBadgeLabel } from "@/lib/modelLabel";

// An empty Settings model means "pass no --model": Claude Code picks its own default.
const CLAUDE_CODE_DEFAULT = "";

type Props = {
  value: string | undefined;
  onChange: (model: string) => void;
};

/** Settings' Claude model: every model the installed Claude Code offers, or its own default. */
export function ClaudeModelSelect({ value, onChange }: Props) {
  useRefreshClaudeModelsOnMount();
  const modelList = useClaudeModelList();
  const models = modelList?.models ?? null;
  const { selected, custom } = settingsModelChoice(models, value);
  const listed = (models ?? []).filter((model) => model.value !== CLAUDE_DEFAULT_MODEL);
  const defaultLabel = claudeModelBadgeLabel(models ?? [], undefined);

  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm cursor-pointer"
    >
      <option value={CLAUDE_CODE_DEFAULT}>
        {defaultLabel === "Default" ? "Claude Code default" : `Claude Code default (${defaultLabel})`}
      </option>
      {models === null && selected !== CLAUDE_CODE_DEFAULT && (
        <option value={selected}>Loading Claude Code models…</option>
      )}
      {listed.map((model) => (
        <option key={model.value} value={model.value}>
          {model.displayName}
          {model.description ? ` — ${model.description}` : ""}
        </option>
      ))}
      {custom !== undefined && (
        <option value={custom}>
          {modelList?.live ? `${custom} (no longer offered by Claude Code)` : `Custom: ${custom}`}
        </option>
      )}
    </select>
  );
}
