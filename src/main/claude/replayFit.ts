import type { Message } from "@shared/types";
import { CHARS_PER_TOKEN } from "@shared/contextSize";
import { blocksToPlainText } from "@shared/history";
import { buildPromptWithHistory } from "./history";

const REPLY_HEADROOM = 0.2;
const RECENT_SHARE = 0.5;
const RETRY_DIVISORS = [2, 4, 8];
const MIN_RETRY_BUDGET = 1_000;

export type ReplayPlan =
  | { fits: true; estimate: number }
  | { fits: false; estimate: number; budget: number; olderText: string; recent: Message[] };

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const sectionOf = (m: Message): string => {
  const text = blocksToPlainText(m.blocks);
  return text ? `[${m.role === "user" ? "User" : "Assistant"}]\n${text}` : "";
};

/** Whether a replayed branch fits the window; if not, which recent messages stay verbatim. */
export function planReplay(input: { history: Message[]; newPrompt: string; window: number; setupTokens: number }): ReplayPlan {
  const estimate = estimateTokens(buildPromptWithHistory(input.history, input.newPrompt)) + input.setupTokens;
  const budget = Math.floor(input.window * (1 - REPLY_HEADROOM)) - input.setupTokens;
  if (estimate <= input.setupTokens + budget) return { fits: true, estimate };
  const recentBudget = Math.floor(budget * RECENT_SHARE);
  let used = 0;
  let split = input.history.length;
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(sectionOf(input.history[i]));
    if (used + cost > recentBudget) break;
    used += cost;
    split = i;
  }
  const older = input.history.slice(0, split);
  return {
    fits: false,
    estimate,
    budget,
    olderText: older.map(sectionOf).filter(Boolean).join("\n\n"),
    recent: input.history.slice(split),
  };
}

/** Splits text into chunks of at most `maxChars`, at "\n\n[" section boundaries where possible. */
export function chunkText(text: string, maxChars: number): string[] {
  const sections = text.split(/\n\n(?=\[)/);
  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    const pieces = section.length > maxChars ? section.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, "g")) ?? [] : [section];
    for (const piece of pieces) {
      const joined = current ? `${current}\n\n${piece}` : piece;
      if (joined.length <= maxChars) {
        current = joined;
      } else {
        if (current) chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function fittedPrompt(summary: string, recent: Message[], newPrompt: string): string {
  return `[Summary of the earlier conversation]\n${summary}\n\n${buildPromptWithHistory(recent, newPrompt)}`;
}

/** Drops the oldest messages (cutting the oldest kept one if needed) until the prompt fits. */
export function trimToFit(history: Message[], newPrompt: string, budgetTokens: number): string {
  for (let start = 0; start < history.length; start += 1) {
    const prompt = buildPromptWithHistory(history.slice(start), newPrompt);
    if (estimateTokens(prompt) <= budgetTokens) return prompt;
  }
  const bare = buildPromptWithHistory([], newPrompt);
  const room = Math.max(0, budgetTokens * CHARS_PER_TOKEN - bare.length - 64);
  const last = history.at(-1);
  if (!last || room === 0) return bare;
  const tail = sectionOf(last).slice(-room);
  return `[Earlier message, cut to fit]\n${tail}\n\n${bare}`;
}

/** Budgets for re-trimming a replay that still overflowed: the 4-characters-a-token estimate
 *  runs low for code and non-Latin text, so each retry halves what it sends. */
export function shrinkingReplayBudgets(window: number, setupTokens: number): number[] {
  const full = Math.floor(window * (1 - REPLY_HEADROOM)) - setupTokens;
  return RETRY_DIVISORS.map((divisor) => Math.max(MIN_RETRY_BUDGET, Math.floor(full / divisor)));
}
