import type { CanvasLockResult } from "@shared/ipc";
import type { Client } from "../api/client";

export const LOCK_LOST_CHANNEL = "canvas:lockLost";

type LockClient = Pick<Client, "kind" | "send" | "isGone">;

export type CanvasLockDeps = {
  /** Whether `holder` has a reply running on the canvas (a take-over would stop it). */
  isReplyRunning?: (holder: LockClient, canvasId: string) => boolean;
  /** Stops `holder`'s replies on the canvas: once it loses the lock it can't save them. */
  stopReplies?: (holder: LockClient, canvasId: string) => void;
};

export type CanvasLocks = {
  acquire(canvasId: string, client: LockClient): CanvasLockResult;
  takeOver(canvasId: string, client: LockClient): void;
  release(canvasId: string, client: LockClient): void;
  releaseAll(client: LockClient): void;
  canWrite(canvasId: string, client: LockClient): boolean;
};

export function createCanvasLocks(deps: CanvasLockDeps = {}): CanvasLocks {
  const holders = new Map<string, LockClient>();

  const isFreeFor = (canvasId: string, client: LockClient): boolean => {
    const holder = holders.get(canvasId);
    return holder === undefined || holder === client || holder.isGone();
  };

  return {
    acquire(canvasId, client) {
      const holder = holders.get(canvasId);
      if (holder && !isFreeFor(canvasId, client)) {
        return { ok: false, holderKind: holder.kind, replyRunning: deps.isReplyRunning?.(holder, canvasId) ?? false };
      }
      holders.set(canvasId, client);
      return { ok: true };
    },
    takeOver(canvasId, client) {
      const holder = holders.get(canvasId);
      if (holder && holder !== client && !holder.isGone()) {
        deps.stopReplies?.(holder, canvasId);
        holder.send(LOCK_LOST_CHANNEL, { canvasId });
      }
      holders.set(canvasId, client);
    },
    release(canvasId, client) {
      if (holders.get(canvasId) === client) holders.delete(canvasId);
    },
    releaseAll(client) {
      for (const [canvasId, holder] of [...holders]) {
        if (holder === client) holders.delete(canvasId);
      }
    },
    canWrite: (canvasId, client) => isFreeFor(canvasId, client),
  };
}
