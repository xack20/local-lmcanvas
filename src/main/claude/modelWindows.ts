import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../storage/paths";

export type ModelWindows = {
  windowFor(model: string | undefined): number | undefined;
  learn(model: string | undefined, window: number): Promise<void>;
};

/** Context windows seen per model, so a replay can be sized before the model is asked. */
export async function loadModelWindows(
  filePath: string,
  write: (path: string, data: string) => Promise<void> = atomicWriteFile,
): Promise<ModelWindows> {
  let windows: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf-8"));
    if (parsed && typeof parsed === "object") {
      windows = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0,
        ),
      );
    }
  } catch {
    windows = {};
  }
  let writes: Promise<void> = Promise.resolve();

  return {
    windowFor: (model) => (model ? windows[model] : undefined),
    learn(model, window) {
      if (!model || !Number.isFinite(window) || window <= 0 || windows[model] === window) return writes;
      windows = { ...windows, [model]: window };
      const run = writes.then(() => write(filePath, JSON.stringify(windows, null, 2)));
      writes = run.catch(() => undefined);
      return run;
    },
  };
}
