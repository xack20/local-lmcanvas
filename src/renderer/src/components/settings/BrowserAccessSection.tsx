import { useCallback, useEffect, useState } from "react";
import { Globe, Moon } from "lucide-react";
import type { BrowserAccessStatus, PairingLink } from "@shared/ipc";
import { formatExpiry, formatLastSeen, statusLine } from "@/lib/browserAccessText";
import { Toggle } from "./Toggle";

const CLOCK_TICK_MS = 15_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function BrowserAccessSection() {
  const [status, setStatus] = useState<BrowserAccessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingLink | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    window.api.web.status().then(setStatus).catch((e: unknown) => setError(messageOf(e)));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const run = useCallback(async (action: () => Promise<BrowserAccessStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (e: unknown) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const createLink = async (): Promise<void> => {
    setError(null);
    try {
      setPairing(await window.api.web.createPairingLink());
      setNow(Date.now());
    } catch (e: unknown) {
      setError(messageOf(e));
    }
  };

  // Render null only while loading with no error; if error, show it
  if (!status && !error) return null;

  return (
    <div className="pt-2 mt-1 border-t border-border">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        browser access
      </h3>
      {error && !status && (
        <p className="text-xs text-destructive">{error}</p>
      )}
      {status && (
        <div className="flex flex-col gap-2">
          <Toggle
            enabled={status.enabled}
            disabled={busy}
            onToggle={() => void run(() => window.api.web.setEnabled(!status.enabled))}
            label="Browser access over Tailscale"
            description={statusLine(status)}
            icon={<Globe className="h-4 w-4" />}
          />
          <Toggle
            enabled={status.keepAwake}
            disabled={busy}
            onToggle={() => void run(() => window.api.web.setKeepAwake(!status.keepAwake))}
            label="Keep Mac awake"
            description="While browser access is on. Closing the lid still sleeps the Mac unless it's on power with an external display."
            icon={<Moon className="h-4 w-4" />}
          />

          {status.running && (
            <div className="rounded-md border border-border p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">Pair a device</span>
                <button
                  type="button"
                  onClick={() => void createLink()}
                  className="cursor-pointer rounded-md bg-foreground px-2.5 py-1 text-[11px] font-semibold text-card hover:opacity-90"
                >
                  {pairing ? "New link" : "Create link"}
                </button>
              </div>
              {pairing && (
                <div className="mt-2 flex flex-col gap-1.5">
                  <code className="break-all rounded bg-muted px-2 py-1 text-[11px]">{pairing.url}</code>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>{formatExpiry(pairing.expiresAt, now)}. Open it once on the device you want to pair.</span>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(pairing.url)}
                      className="cursor-pointer rounded-md px-2 py-0.5 hover:bg-muted"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {status.devices.length > 0 && (
            <div className="rounded-md border border-border p-3 text-xs">
              <p className="mb-1.5 font-medium text-foreground">Paired devices</p>
              {status.devices.map((device) => (
                <div key={device.id} className="flex items-center justify-between gap-2 py-1">
                  <span className="text-foreground">
                    {device.label}
                    <span className="ml-2 text-muted-foreground">{formatLastSeen(device.lastSeenAt, now)}</span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => window.api.web.removeDevice(device.id))}
                    className="cursor-pointer rounded-md px-2 py-0.5 text-destructive hover:bg-muted disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}
