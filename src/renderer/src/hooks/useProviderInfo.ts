import { useEffect, useState } from "react";
import { PROVIDERS, type AppSettings, type Provider } from "@shared/types";
import { claudeModelLabel } from "@/lib/modelLabel";
import { onSettingsChanged } from "@/lib/settingsEvents";

export type ProviderInfoState = {
  provider: Provider;
  label: string;
  labelsByProvider: Record<Provider, string>;
  /** Claude model set in Settings; undefined means Claude Code's own default. */
  claudeModelId: string | undefined;
};

// Claude has no entry: with no model set, Claude Code picks its own default.
const DEFAULT_MODEL_BY_PROVIDER: Record<Exclude<Provider, "claude">, string> = {
  codex: "gpt-5.6-sol",
  cursor: "auto",
};

/**
 * Resolves the current provider and a pretty label for its configured model.
 * Pass `canvasProvider` from inside a pane to track that canvas's provider;
 * omit it from sidebar/global contexts to fall back to AppSettings.defaultProvider.
 */
export function useProviderInfo(canvasProvider?: Provider): ProviderInfoState {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void window.api.settings.read().then((s) => {
        if (!cancelled) setSettings(s);
      });
    };
    read();
    // A Settings save (e.g. a new Claude model) must reach every badge without a remount.
    const stopListening = onSettingsChanged(read);
    return () => {
      cancelled = true;
      stopListening();
    };
  }, [canvasProvider]);

  const provider: Provider =
    canvasProvider ?? settings?.defaultProvider ?? "claude";

  // Same resolution as chat:start: an empty Settings model means Claude Code's default,
  // while an unset one falls back to the legacy claudeModel setting.
  const claudeModelId =
    (settings?.providers?.claude?.model ?? settings?.claudeModel) || undefined;

  const labelsByProvider = PROVIDERS.reduce<Record<Provider, string>>(
    (acc, p) => {
      const modelId =
        p === "claude"
          ? claudeModelId
          : (settings?.providers?.[p]?.model ?? DEFAULT_MODEL_BY_PROVIDER[p]);
      acc[p] = prettyModelLabel(p, modelId);
      return acc;
    },
    {
      claude: prettyModelLabel("claude", undefined),
      codex: prettyModelLabel("codex", DEFAULT_MODEL_BY_PROVIDER.codex),
      cursor: prettyModelLabel("cursor", DEFAULT_MODEL_BY_PROVIDER.cursor),
    }
  );

  return { provider, label: labelsByProvider[provider], labelsByProvider, claudeModelId };
}

function prettyModelLabel(provider: Provider, modelId?: string): string {
  if (provider === "claude") {
    return modelId ? claudeModelLabel(modelId) : "Default";
  }
  if (provider === "codex") {
    if (!modelId || modelId.length === 0) return "GPT-5.6 Sol";
    const lower = normalizeModelId(modelId);
    if (
      lower === "codex" ||
      lower === "openai" ||
      lower === "default" ||
      lower === "openai/default"
    ) {
      return "Codex (Default)";
    }
    return prettyOpenAIModelName(modelId);
  }
  if (provider === "cursor") {
    if (!modelId || modelId.length === 0) return "Auto";
    const lower = normalizeModelId(modelId);
    if (
      lower === "auto" ||
      lower === "default" ||
      lower === "cursor" ||
      lower === "cursor-agent" ||
      lower === "cursor/default"
    ) {
      return "Auto";
    }
    return prettyOpenAIModelName(modelId);
  }
  return modelId ?? "Default";
}

function prettyOpenAIModelName(modelId?: string): string {
  if (!modelId || modelId.length === 0) return "GPT-5.6 Sol";
  const lower = normalizeModelId(modelId);
  if (lower === "auto") return "Auto";
  if (lower === "codex") return "Codex (Default)";
  if (lower === "cursor" || lower === "cursor-agent") return "Auto";

  const sanitized = modelId.replace(/[\\/_]+/g, "-").replace(/\s+/g, "-");
  const pretty = sanitized
    .split("-")
    .map((part) => {
      const token = part.toLowerCase();
      if (token === "gpt") return "GPT";
      if (token === "codex") return "Codex";
      if (/^\d+(\.\d+)*$/.test(part)) return part;
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join("-");
  return pretty
    .replace("-Codex", " Codex")
    .replace("-Sol", " Sol")
    .replace("-Turbo", " Turbo");
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}
