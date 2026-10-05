import type { ProviderSessionRef } from "@shared/types";
import type { RunnerEvent } from "../agents/types";

/** Which session to compact before retrying an overflowed run: the node's own in place,
 *  or a fork of its parent's so the parent and its other branches stay untouched. */
export function overflowRetryTarget(sessions: {
  current?: ProviderSessionRef;
  parent?: ProviderSessionRef;
}): { sessionId: string; fork: boolean } | null {
  if (sessions.current?.provider === "claude") return { sessionId: sessions.current.id, fork: false };
  if (sessions.parent?.provider === "claude") return { sessionId: sessions.parent.id, fork: true };
  return null;
}

export function isPromptTooLongEvent(ev: RunnerEvent): boolean {
  return (ev.kind === "error" || (ev.kind === "done" && ev.isError === true)) && ev.code === "prompt_too_long";
}
