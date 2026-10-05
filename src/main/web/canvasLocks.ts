import type { CanvasLockResult } from "@shared/ipc";
import type { Client } from "../api/client";

export const LOCK_LOST_CHANNEL = "canvas:lockLost";

type LockClient = Pick<Client, "kind" | "send" | "isGone">;

export type CanvasLocks = {
  acquire(canvasId: string, client: LockClient): CanvasLockResult;
  takeOver(canvasId: string, client: LockClient): void;
  release(canvasId: string, client: LockClient): void;
  releaseAll(client: LockClient): void;
  canWrite(canvasId: string, client: LockClient): boolean;
};

export function createCanvasLocks(): CanvasLocks {
  const holders = new Map<string, LockClient>();

  const isFreeFor = (canvasId: string, client: LockClient): boolean => {
    const holder = holders.get(canvasId);
    return holder === undefined || holder === client || holder.isGone();
  };

  return {
    acquire(canvasId, client) {
      const holder = holders.get(canvasId);
      if (holder && !isFreeFor(canvasId, client)) return { ok: false, holderKind: holder.kind };
      holders.set(canvasId, client);
      return { ok: true };
    },
    takeOver(canvasId, client) {
      const holder = holders.get(canvasId);
      if (holder && holder !== client && !holder.isGone()) {
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
