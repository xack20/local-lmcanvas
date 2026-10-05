import type { CanvasStoreApi } from "@/hooks/useCanvasStore";

/** First retry after a failed save; doubles while it keeps failing. */
export const SAVE_RETRY_MS = 5_000;
const MAX_SAVE_RETRY_MS = 60_000;

export type SaveTimers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type SaveSchedulerOptions = {
  /** Quiet period after the last change before saving. */
  delayMs: number;
  timers: SaveTimers;
  /** Calls `listener` whenever the connection to the Mac comes back (browser only). */
  onReconnect: (listener: () => void) => () => void;
};

/**
 * Saves the canvas once changes go quiet, retries a failed save with backoff,
 * and retries at once when the browser's connection comes back. Returns stop().
 */
export function startSaveScheduler(store: CanvasStoreApi, opts: SaveSchedulerOptions): () => void {
  let timer: unknown = null;
  let failures = 0;
  let stopped = false;

  const cancel = (): void => {
    if (timer !== null) opts.timers.clear(timer);
    timer = null;
  };

  const flush = async (): Promise<void> => {
    await store.getState().save();
    if (stopped) return;
    if (store.getState().saveError === null) {
      failures = 0;
      return;
    }
    failures += 1;
    // A change made during the save already scheduled the next attempt.
    if (timer === null) schedule(Math.min(SAVE_RETRY_MS * 2 ** (failures - 1), MAX_SAVE_RETRY_MS));
  };

  function schedule(ms: number): void {
    cancel();
    timer = opts.timers.set(() => {
      timer = null;
      void flush();
    }, ms);
  }

  const unsubscribeChanges = store.subscribe(
    (s) => s.dirty.lastChangeAt,
    () => schedule(opts.delayMs),
  );
  const unsubscribeReconnect = opts.onReconnect(() => {
    if (store.getState().dirty.count > 0) schedule(0);
  });

  return () => {
    stopped = true;
    cancel();
    unsubscribeChanges();
    unsubscribeReconnect();
  };
}

export function saveErrorText(message: string): string {
  return `Couldn't save: ${message.replace(/\.+$/, "")}. Retrying…`;
}
