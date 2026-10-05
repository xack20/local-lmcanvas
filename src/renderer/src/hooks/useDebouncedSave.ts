import { useEffect } from "react";
import { useCanvasStoreApi } from "./useCanvasStore";
import { useWebUiStore } from "@/lib/webUi";
import { startSaveScheduler } from "@/lib/saveRetry";

const timers = {
  set: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
  clear: (handle: unknown) => window.clearTimeout(handle as number),
};

const onReconnect = (listener: () => void): (() => void) =>
  useWebUiStore.subscribe((ui, previous) => {
    if (ui.connection === "connected" && previous.connection !== "connected") listener();
  });

/**
 * Watches `dirty` and flushes save() after quiet period, retrying failed saves.
 * Also saves on beforeunload.
 */
export function useDebouncedSave(delayMs = 1200) {
  const storeApi = useCanvasStoreApi();

  useEffect(() => {
    const stop = startSaveScheduler(storeApi, { delayMs, timers, onReconnect });
    const onUnload = () => {
      void storeApi.getState().save();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      stop();
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [delayMs, storeApi]);
}
