// A window (or browser tab) holds one lock per canvas on the Mac, but more than
// one store in it can be using that lock: a pane that unmounted while its reply
// is still finishing, and the same canvas opened again in a new pane. Only the
// last store to let go may release it.
type Owner = object;

let claims: ReadonlyMap<string, ReadonlySet<Owner>> = new Map();

function addClaim(canvasId: string, owner: Owner): void {
  const owners = claims.get(canvasId) ?? new Set<Owner>();
  if (owners.has(owner)) return;
  claims = new Map([...claims, [canvasId, new Set([...owners, owner])]]);
}

/** Removes `owner`'s claim. True when no other store in this window still uses the lock. */
function removeClaim(canvasId: string, owner: Owner): boolean {
  const remaining = [...(claims.get(canvasId) ?? [])].filter((o) => o !== owner);
  const next = new Map(claims);
  if (remaining.length === 0) next.delete(canvasId);
  else next.set(canvasId, new Set(remaining));
  claims = next;
  return remaining.length === 0;
}

export function isCanvasLockClaimed(canvasId: string): boolean {
  return claims.has(canvasId);
}

/** One store's claim. It remembers which canvas it claimed, so every way out drops exactly that one. */
export type CanvasLockClaim = {
  current(): string | null;
  claim(canvasId: string): void;
  /** Drops the claim. Returns its canvas id when no other store here still uses that lock, else null. */
  drop(): string | null;
};

export function createCanvasLockClaim(): CanvasLockClaim {
  const owner: Owner = {};
  let claimed: string | null = null;
  return {
    current: () => claimed,
    claim(canvasId) {
      if (claimed === canvasId) return;
      if (claimed !== null) removeClaim(claimed, owner);
      addClaim(canvasId, owner);
      claimed = canvasId;
    },
    drop() {
      if (claimed === null) return null;
      const canvasId = claimed;
      claimed = null;
      return removeClaim(canvasId, owner) ? canvasId : null;
    },
  };
}
