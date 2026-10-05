import { useWebUiStore } from "@/lib/webUi";

const BANNER_TEXT = {
  connecting: "Connecting to your Mac…",
  reconnecting: "Lost connection to your Mac. Reconnecting…",
} as const;

export function WebStatusBar() {
  const connection = useWebUiStore((s) => s.connection);
  const notice = useWebUiStore((s) => s.notice);
  const banner = connection === "connected" ? null : BANNER_TEXT[connection];
  if (!banner && !notice) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2">
      {banner && (
        <div className="rounded-md border border-amber-500/40 bg-card px-3 py-1.5 text-xs text-amber-600 shadow-lg dark:text-amber-400">
          {banner}
        </div>
      )}
      {notice && (
        <div className="max-w-[90vw] truncate rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground shadow-lg">
          {notice}
        </div>
      )}
    </div>
  );
}
