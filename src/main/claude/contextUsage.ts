import type { ContextSnapshot } from "@shared/types";

export const CONTEXT_MEASURE_TIMEOUT_MS = 2_000;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Normalizes the SDK's getContextUsage() answer. Category names per the Task 1 spike ("Messages"). */
export function toContextSnapshot(raw: unknown, now: number): ContextSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const tokens = num(r.totalTokens);
  const window = num(r.maxTokens);
  if (tokens === undefined || window === undefined) return null;
  const categories = Array.isArray(r.categories) ? (r.categories as Array<Record<string, unknown>>) : [];
  const messages = num(categories.find((c) => typeof c.name === "string" && /^messages$/i.test(c.name))?.tokens);
  const breakdownRaw = (r.messageBreakdown ?? {}) as Record<string, unknown>;
  const toolResults = num(breakdownRaw.toolResultTokens) ?? 0;
  const breakdown =
    messages !== undefined
      ? { setup: Math.max(0, tokens - messages), conversation: Math.max(0, messages - toolResults), toolResults }
      : undefined;
  const autoCompactAt = num(r.autoCompactThreshold);
  return {
    tokens,
    window,
    ...(autoCompactAt !== undefined ? { autoCompactAt } : {}),
    autoCompactEnabled: r.isAutoCompactEnabled === true,
    ...(typeof r.model === "string" ? { model: r.model } : {}),
    ...(breakdown ? { breakdown } : {}),
    exact: true,
    measuredAt: now,
  };
}

/** Asks a live session for its context usage; null after `timeoutMs` or on any failure. Never throws. */
export async function measureContext(
  session: { getContextUsage(): Promise<unknown> },
  timeoutMs: number = CONTEXT_MEASURE_TIMEOUT_MS,
  now: () => number = Date.now,
): Promise<ContextSnapshot | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const raw = await Promise.race([Promise.resolve().then(() => session.getContextUsage()), timeout]);
    return raw === null ? null : toContextSnapshot(raw, now());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
