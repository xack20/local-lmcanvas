import { createServer as createNetServer } from "node:net";
import type { BrowserAccessStatus, PairingLink } from "@shared/ipc";
import type { AppSettings, BrowserAccessSettings } from "@shared/types";
import type { DeviceStore } from "./devices";
import type { GateContext } from "./security";
import type { WebServer } from "./server";
import { serveTarget, type TailscaleControl } from "./tailscale";

export const WEB_PORT = 4317;

const PROBLEMS = {
  notRunning: "Tailscale isn't running. Open the Tailscale app and sign in, then try again.",
  notSignedIn: "Tailscale isn't signed in on this Mac.",
  noHttps:
    "HTTPS certificates are off for your Tailscale network. Turn on HTTPS in the Tailscale admin console (DNS page), then try again.",
  httpsTaken:
    "HTTPS on this Mac is already used by another Tailscale Serve setup, so LMCanvas won't replace it.",
  funnel: "HTTPS on this Mac is shared publicly with Tailscale Funnel, so LMCanvas won't use it.",
  portBusy: (port: number) => `Port ${port} on this Mac is already in use.`,
} as const;

export type PowerSave = { start(): number; stop(id: number): void };

export type WebServiceDeps = {
  tailscale: TailscaleControl;
  server: Pick<WebServer, "listen" | "close" | "disconnectDevice" | "port">;
  devices: Pick<DeviceStore, "createPairingToken" | "clearPairingTokens" | "findByKey" | "list" | "remove">;
  readSettings: () => Promise<Pick<AppSettings, "browserAccess">>;
  writeBrowserAccess: (patch: Partial<BrowserAccessSettings>) => Promise<Pick<AppSettings, "browserAccess">>;
  powerSave: PowerSave;
  isPortFree: (port: number) => Promise<boolean>;
  expireBrowserClients: () => void;
  port?: number;
  now?: () => number;
};

export type WebService = {
  status(): Promise<BrowserAccessStatus>;
  setEnabled(enabled: boolean): Promise<BrowserAccessStatus>;
  setKeepAwake(keepAwake: boolean): Promise<BrowserAccessStatus>;
  createPairingLink(): PairingLink;
  removeDevice(deviceId: string): Promise<BrowserAccessStatus>;
  startIfEnabled(): Promise<void>;
  shutdown(): Promise<void>;
  gateContext(): GateContext | null;
};

export function createWebService(deps: WebServiceDeps): WebService {
  const port = deps.port ?? WEB_PORT;
  const now = deps.now ?? Date.now;
  let live: { host: string; ownerLogin: string } | null = null;
  // The host we pointed (or found already pointing) a Serve mapping at. Kept
  // apart from `live` so a failed or timed-out enable can still be undone.
  let published: string | null = null;
  let problem: string | null = null;
  let blockerId: number | null = null;

  // Every state-changing operation runs through one queue, so overlapping
  // calls (a double toggle, quitting during the launch-time start) can't
  // interleave their awaits. The queue never holds a rejection, so a failed
  // operation doesn't block the ones after it.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  const keepAwakeSetting = async (): Promise<boolean> =>
    (await deps.readSettings()).browserAccess?.keepAwake !== false;

  const applyAwake = (keepAwake: boolean): void => {
    if (live && keepAwake) {
      if (blockerId === null) blockerId = deps.powerSave.start();
      return;
    }
    if (blockerId !== null) {
      deps.powerSave.stop(blockerId);
      blockerId = null;
    }
  };

  // Removes our Serve mapping, but only while it still points at our port.
  const removeOurMapping = async (): Promise<void> => {
    const host = published;
    if (host === null) return;
    try {
      const serve = await deps.tailscale.serveState(host).catch(() => null);
      if (serve?.proxiesTo === serveTarget(port)) {
        await deps.tailscale.disableServe().catch((error: unknown) => {
          console.warn("[web] couldn't remove Serve mapping:", error);
        });
      }
    } finally {
      published = null;
    }
  };

  const listenOnPort = async (): Promise<string | null> => {
    if (!(await deps.isPortFree(port))) return PROBLEMS.portBusy(port);
    try {
      await deps.server.listen(port);
      return null;
    } catch (error) {
      // Someone took the port between the check and the bind.
      if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") return PROBLEMS.portBusy(port);
      throw error;
    }
  };

  // Undoes only what this call set up: a server it opened, a mapping it
  // published or reused.
  const start = async (): Promise<string | null> => {
    let openedServer = false;
    try {
      const info = await deps.tailscale.info().catch(() => null);
      if (!info || !info.running) return PROBLEMS.notRunning;
      if (!info.host || !info.ownerLogin) return PROBLEMS.notSignedIn;
      if (!info.httpsAvailable) return PROBLEMS.noHttps;
      const serve = await deps.tailscale.serveState(info.host);
      // A public (Funnel) mapping is never ours to reuse, even if it points at our port.
      if (serve.funnel) return PROBLEMS.funnel;
      const ours = serve.proxiesTo === serveTarget(port);
      if (serve.httpsInUse && !ours) return PROBLEMS.httpsTaken;
      if (deps.server.port() === null) {
        const busy = await listenOnPort();
        if (busy) {
          // Left in place, our mapping would publish whatever now listens on our port.
          if (ours) {
            published = info.host;
            await removeOurMapping();
          }
          return busy;
        }
        openedServer = true;
      }
      // Recorded before enableServe: a timeout can still mean it was applied.
      published = info.host;
      if (!ours) await deps.tailscale.enableServe(port);
      live = { host: info.host, ownerLogin: info.ownerLogin };
      return null;
    } catch (error) {
      await removeOurMapping();
      if (openedServer) await deps.server.close();
      return `Couldn't set up Tailscale Serve: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const stop = async (): Promise<void> => {
    await removeOurMapping();
    live = null;
    await deps.server.close();
    deps.expireBrowserClients();
    deps.devices.clearPairingTokens();
    applyAwake(false);
  };

  const status = async (): Promise<BrowserAccessStatus> => {
    const settings = await deps.readSettings();
    return {
      enabled: settings.browserAccess?.enabled === true,
      running: live !== null,
      keepAwake: settings.browserAccess?.keepAwake !== false,
      url: live ? `https://${live.host}` : null,
      problem,
      devices: deps.devices
        .list()
        .map(({ id, label, createdAt, lastSeenAt }) => ({ id, label, createdAt, lastSeenAt })),
    };
  };

  return {
    status,
    setEnabled: (enabled) =>
      serialized(async () => {
        if (!enabled) {
          await stop();
          problem = null;
          await deps.writeBrowserAccess({ enabled: false });
          return status();
        }
        if (live) {
          // Already running: nothing to set up, and nothing to lose by asking
          // Tailscale again.
          problem = null;
          await deps.writeBrowserAccess({ enabled: true });
          applyAwake(await keepAwakeSetting());
          return status();
        }
        problem = await start();
        await deps.writeBrowserAccess({ enabled: problem === null });
        applyAwake(await keepAwakeSetting());
        return status();
      }),
    setKeepAwake: (keepAwake) =>
      serialized(async () => {
        await deps.writeBrowserAccess({ keepAwake });
        applyAwake(keepAwake);
        return status();
      }),
    createPairingLink() {
      if (!live) throw new Error("Turn on browser access first.");
      const { token, expiresAt } = deps.devices.createPairingToken(now());
      return { url: `https://${live.host}/pair?token=${token}`, expiresAt };
    },
    removeDevice: (deviceId) =>
      serialized(async () => {
        await deps.devices.remove(deviceId);
        deps.server.disconnectDevice(deviceId);
        return status();
      }),
    startIfEnabled: () =>
      serialized(async () => {
        if ((await deps.readSettings()).browserAccess?.enabled !== true) return;
        problem = await start();
        applyAwake(await keepAwakeSetting());
      }),
    shutdown: () => serialized(stop),
    gateContext() {
      if (!live) return null;
      return {
        expectedHost: live.host,
        ownerLogin: live.ownerLogin,
        isPairedDevice: (deviceKey) => deps.devices.findByKey(deviceKey) !== undefined,
      };
    },
  };
}

export function isLocalPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
