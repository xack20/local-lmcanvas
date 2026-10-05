// A window (or browser tab) holds one lock per canvas on the Mac, but more than
// one store in it can be using that lock: a pane that unmounted while its reply
// is still finishing, and the same canvas opened again in a new pane. Only the
// last store to let go may release it.
type Owner = object;

let claims: ReadonlyMap<string, ReadonlySet<Owner>> = new Map();

export function claimCanvasLock(canvasId: string, owner: Owner): void {
  const owners = claims.get(canvasId) ?? new Set<Owner>();
  if (owners.has(owner)) return;
  claims = new Map([...claims, [canvasId, new Set([...owners, owner])]]);
}

/** Drops `owner`'s claim. True when no other store in this window still uses the lock. */
export function dropCanvasLockClaim(canvasId: string, owner: Owner): boolean {
  const remaining = [...(claims.get(canvasId) ?? [])].filter((o) => o !== owner);
  const next = new Map(claims);
  if (remaining.length === 0) next.delete(canvasId);
  else next.set(canvasId, new Set(remaining));
  claims = next;
  return remaining.length === 0;
}
