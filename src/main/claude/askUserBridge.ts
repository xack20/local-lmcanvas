import { randomUUID } from "node:crypto";
import type { AskUserQuestion, AskUserResponsePayload } from "@shared/ipc";
import type { Client } from "../api/client";

type Pending = {
  resolve: (response: AskUserResponsePayload) => void;
  reject: (err: unknown) => void;
  client: Client;
  signal?: AbortSignal;
  abortHandler?: () => void;
  stopWatchingGone?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();

/**
 * Send an ask-user request to the client (window or browser tab) that started
 * the chat and wait for its answers. `nodeId` lets the interface render the
 * prompt inline on the node that initiated the chat.
 */
export function requestAnswer(
  questions: AskUserQuestion[],
  client: Client,
  nodeId: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<AskUserResponsePayload> {
  if (client.isGone()) return Promise.reject(new Error("Target window is gone"));
  if (signal?.aborted) return Promise.reject(new Error("Aborted"));

  const id = randomUUID();
  return new Promise<AskUserResponsePayload>((resolve, reject) => {
    const entry: Pending = { resolve, reject, client, signal };
    if (signal) {
      const onAbort = () => {
        cleanup(id);
        reject(new Error("Aborted"));
      };
      entry.abortHandler = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
    entry.stopWatchingGone = client.onGone(() => {
      cleanup(id);
      resolve({ id, cancelled: true });
    });
    if (timeoutMs && timeoutMs > 0) {
      entry.timeout = setTimeout(() => {
        cleanup(id);
        resolve({ id, cancelled: true });
      }, timeoutMs);
    }
    pending.set(id, entry);
    client.send("askUser:request", { id, nodeId, questions });
  });
}

function cleanup(id: string): Pending | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  pending.delete(id);
  if (entry.signal && entry.abortHandler) {
    entry.signal.removeEventListener("abort", entry.abortHandler);
  }
  entry.stopWatchingGone?.();
  if (entry.timeout) clearTimeout(entry.timeout);
  return entry;
}

export function completeRequest(payload: AskUserResponsePayload): void {
  const entry = cleanup(payload.id);
  if (!entry) return;
  entry.resolve(payload);
}

/** Cancel all in-flight requests originating from a specific client. */
export function cancelAllForClient(client: Client): void {
  for (const [id, entry] of pending) {
    if (entry.client !== client) continue;
    cleanup(id);
    entry.resolve({ id, cancelled: true });
  }
}
