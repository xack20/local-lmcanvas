import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeModelInfo, ClaudeModelList } from "@shared/types";
import { FALLBACK_CLAUDE_MODELS, normalizeClaudeModels } from "@shared/claudeModels";

const LIST_TIMEOUT_MS = 20_000;
// A live list is re-checked in the background after this long, so models Claude Code adds
// or drops show up while the app runs.
const LIVE_TTL_MS = 10 * 60_000;
// A failed read is retried after this long, so a broken CLI isn't respawned for every chat.
const FAILURE_TTL_MS = 60_000;
const BUNDLED_KEY = "<bundled>";

export type ClaudeModelCatalogDeps = {
  /** Resolves Settings' binary path to the executable chats run. */
  executableFor: (binPath: string | undefined) => string | undefined;
  /** Asks that executable for its models (the SDK's supportedModels()). */
  list?: (executable: string | undefined) => Promise<unknown>;
  /** Follows symlinks, so an updated Claude Code (a repointed link) gets a fresh list. */
  realpath?: (path: string) => string;
  now?: () => number;
  warn?: (message: string, error: unknown) => void;
};

export type ClaudeModelCatalog = {
  list(binPath: string | undefined): Promise<ClaudeModelList>;
  /** The models if they're known within `budgetMs` (and before `signal` aborts); null otherwise.
   *  Never throws; an unfinished read carries on for later calls. */
  modelsWithin(
    binPath: string | undefined,
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<ClaudeModelInfo[] | null>;
};

type Entry = {
  /** What callers get: the read in flight, or the last answer. */
  readonly current: Promise<ClaudeModelList>;
  /** When to check again; unset while the first read is in flight. */
  readonly checkAt?: number;
  /** Whether `current` holds a live list (a failed re-check keeps it). */
  readonly live?: boolean;
  readonly refreshing?: boolean;
};

/** The models the installed Claude Code offers, read once per binary; aliases if it can't be asked. */
export function createClaudeModelCatalog(deps: ClaudeModelCatalogDeps): ClaudeModelCatalog {
  const listModels = deps.list ?? ((executable) => listClaudeCodeModels(executable));
  const realpath = deps.realpath ?? realpathOrSelf;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((message, error) => console.warn(message, error));
  const cache = new Map<string, Entry>();

  const load = async (executable: string | undefined): Promise<ClaudeModelList> => {
    try {
      // Promise.resolve().then also turns a synchronous throw into a rejection.
      const models = normalizeClaudeModels(await Promise.resolve().then(() => listModels(executable)));
      if (models.length > 0) return { models, live: true };
      warn("[claude] model list was empty; using aliases", executable);
    } catch (error) {
      warn("[claude] couldn't read the model list; using aliases:", error);
    }
    return { models: [...FALLBACK_CLAUDE_MODELS], live: false };
  };

  const settledEntry = (current: Promise<ClaudeModelList>, live: boolean): Entry => ({
    current,
    live,
    checkAt: now() + (live ? LIVE_TTL_MS : FAILURE_TTL_MS),
  });

  /** A read whose answer callers wait for (first read, or retrying after a failure). */
  const readFresh = (executable: string | undefined, key: string): Promise<ClaudeModelList> => {
    const pending = load(executable);
    cache.set(key, { current: pending });
    void pending.then((result) => {
      if (cache.get(key)?.current === pending) cache.set(key, settledEntry(pending, result.live));
    });
    return pending;
  };

  /** Re-checks a live list behind callers' backs; a failed re-check keeps the last good list. */
  const revalidate = (executable: string | undefined, key: string, entry: Entry): void => {
    cache.set(key, { ...entry, refreshing: true });
    void load(executable).then((result) => {
      if (cache.get(key)?.current !== entry.current) return;
      cache.set(
        key,
        result.live
          ? settledEntry(Promise.resolve(result), true)
          : { current: entry.current, live: true, checkAt: now() + FAILURE_TTL_MS },
      );
    });
  };

  const list = (binPath: string | undefined): Promise<ClaudeModelList> => {
    const executable = deps.executableFor(binPath);
    const key = executable ? realpath(executable) : BUNDLED_KEY;
    const entry = cache.get(key);
    if (!entry) return readFresh(executable, key);
    const due = entry.checkAt !== undefined && now() >= entry.checkAt;
    if (!due || entry.refreshing) return entry.current;
    if (!entry.live) return readFresh(executable, key);
    revalidate(executable, key, entry);
    return entry.current;
  };

  return {
    list,
    async modelsWithin(binPath, budgetMs, signal) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort = (): void => {};
      const giveUp = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
        onAbort = () => resolve(null);
        if (signal?.aborted) resolve(null);
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const result = await Promise.race([list(binPath), giveUp]);
        return result ? result.models : null;
      } catch (error) {
        warn("[claude] model list unavailable for this chat:", error);
        return null;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export type ListClaudeCodeModelsOptions = {
  queryFn?: typeof query;
  timeoutMs?: number;
};

/** Starts the CLI without sending a prompt, reads supportedModels(), then stops it. No model
 *  request is made, and no settings, plugins, hooks, MCP servers or session file are loaded. */
export async function listClaudeCodeModels(
  executable: string | undefined,
  { queryFn = query, timeoutMs = LIST_TIMEOUT_MS }: ListClaudeCodeModelsOptions = {},
): Promise<unknown> {
  const controller = new AbortController();
  let release = (): void => {};
  const idle = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* noPrompt(): AsyncGenerator<SDKUserMessage, void> {
    await idle;
  }
  const session = queryFn({
    prompt: noPrompt(),
    options: {
      pathToClaudeCodeExecutable: executable,
      abortController: controller,
      cwd: homedir(),
      // No user settings: they'd run SessionStart hooks and plugins on every probe. The trade-off:
      // a `model` or `availableModels` set in ~/.claude/settings.json isn't reflected in this list.
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out listing Claude models")), timeoutMs);
  });
  try {
    return await Promise.race([session.supportedModels(), timeout]);
  } finally {
    clearTimeout(timer);
    release();
    controller.abort();
  }
}
