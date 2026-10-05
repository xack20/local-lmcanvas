import { useEffect, useSyncExternalStore } from "react";
import type { ClaudeModelInfo, ClaudeModelList } from "@shared/types";
import { createClaudeModelStore } from "@/lib/claudeModelStore";
import { onSettingsChanged } from "@/lib/settingsEvents";

// While the window is visible, re-ask this often; main re-checks Claude Code every 10 minutes
// and answers from its cache in between, so this only picks up what main already knows.
const AUTO_REFRESH_MS = 5 * 60_000;

// One shared list per renderer, kept current while the app runs.
const store = createClaudeModelStore(() => window.api.providers.claudeModels());
let autoRefreshWired = false;

function wireAutoRefresh(): void {
  if (autoRefreshWired) return;
  autoRefreshWired = true;
  const refreshIfVisible = (): void => {
    if (document.visibilityState === "visible") void store.refresh();
  };
  window.addEventListener("focus", refreshIfVisible);
  document.addEventListener("visibilitychange", refreshIfVisible);
  window.setInterval(refreshIfVisible, AUTO_REFRESH_MS);
  // A new Claude binary path in Settings can mean a different Claude Code with other models.
  onSettingsChanged(() => void store.refresh({ force: true }));
}

/** Claude Code's model list and whether it's live (false: its aliases, as it couldn't be asked). */
export function useClaudeModelList(): ClaudeModelList | null {
  const list = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    wireAutoRefresh();
    void store.refresh();
  }, []);
  return list;
}

/** Models the installed Claude Code offers; null until the first list arrives. */
export function useClaudeModels(): ClaudeModelInfo[] | null {
  return useClaudeModelList()?.models ?? null;
}

/** Asks again right away, e.g. when the model picker or Settings opens. */
export function useRefreshClaudeModelsOnMount(): void {
  useEffect(() => {
    void store.refresh({ force: true });
  }, []);
}
