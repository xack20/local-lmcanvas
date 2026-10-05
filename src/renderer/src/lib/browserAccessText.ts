import type { BrowserAccessStatus } from "@shared/ipc";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function statusLine(status: BrowserAccessStatus): string {
  if (status.running && status.url) return `On at ${status.url}`;
  if (status.problem) return status.problem;
  if (status.enabled) return "On, but not running yet.";
  return "Off. Only this Mac can use LMCanvas.";
}

export function formatExpiry(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "Expired. Create a new link.";
  return `Expires in ${Math.max(1, Math.round(remaining / MINUTE_MS))} min`;
}

export function formatLastSeen(lastSeenAt: number, now: number): string {
  const elapsed = now - lastSeenAt;
  if (elapsed < MINUTE_MS) return "Active now";
  if (elapsed < HOUR_MS) return `Last seen ${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `Last seen ${Math.floor(elapsed / HOUR_MS)} h ago`;
  return `Last seen ${Math.floor(elapsed / DAY_MS)} days ago`;
}
