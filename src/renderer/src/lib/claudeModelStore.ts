import type { ClaudeModelList } from "@shared/types";
import { FALLBACK_CLAUDE_MODELS } from "@shared/claudeModels";

export type ClaudeModelStore = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ClaudeModelList | null;
  /** Asks main for the list. Automatic callers are throttled; `force` (the picker opening,
   *  a Settings save) always asks. Main answers from its cache, so asking is cheap. */
  refresh(options?: { force?: boolean }): Promise<void>;
};

type StoreOptions = { now?: () => number; minIntervalMs?: number };

/** The renderer's shared copy of Claude Code's model list; listeners hear only real changes. */
export function createClaudeModelStore(
  fetchList: () => Promise<ClaudeModelList>,
  { now = Date.now, minIntervalMs = 30_000 }: StoreOptions = {},
): ClaudeModelStore {
  let snapshot: ClaudeModelList | null = null;
  let inFlight: Promise<void> | null = null;
  let lastAskAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<() => void>();

  const publish = (next: ClaudeModelList): void => {
    if (snapshot !== null && JSON.stringify(snapshot) === JSON.stringify(next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    refresh({ force = false } = {}) {
      if (inFlight) return inFlight;
      if (!force && now() - lastAskAt < minIntervalMs) return Promise.resolve();
      lastAskAt = now();
      inFlight = Promise.resolve()
        .then(fetchList)
        .then(publish, () => {
          if (snapshot === null) publish({ models: [...FALLBACK_CLAUDE_MODELS], live: false });
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
