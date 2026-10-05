// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { WEB_PORT, createWebService } from "./service.ts";

const HOST = "my-mac.tail1234.ts.net";
const OURS = `http://127.0.0.1:${WEB_PORT}`;

function harness({ info, serve, portFree = true, keepAwake = true } = {}) {
  const calls = [];
  const tsState = {
    info: info ?? { running: true, host: HOST, ownerLogin: "me@example.com", httpsAvailable: true },
    serve: serve ?? { httpsInUse: false, proxiesTo: null },
  };
  const tailscale = {
    info: async () => tsState.info,
    serveState: async () => tsState.serve,
    enableServe: async (port) => {
      calls.push(["enableServe", port]);
      tsState.serve = { httpsInUse: true, proxiesTo: `http://127.0.0.1:${port}` };
    },
    disableServe: async () => {
      calls.push(["disableServe"]);
      tsState.serve = { httpsInUse: false, proxiesTo: null };
    },
  };
  let listening = null;
  const server = {
    listen: async (port) => {
      calls.push(["listen", port]);
      listening = port;
    },
    close: async () => {
      calls.push(["close"]);
      listening = null;
    },
    disconnectDevice: (id) => calls.push(["disconnect", id]),
    port: () => listening,
  };
  let browserAccess = { enabled: false, keepAwake };
  const awake = new Set();
  let nextBlocker = 1;
  const service = createWebService({
    tailscale,
    server,
    devices: {
      createPairingToken: (now) => ({ token: "tok123", expiresAt: now + 600_000 }),
      findByKey: (key) => (key === "good" ? { id: "d1" } : undefined),
      list: () => [{ id: "d1", label: "Chrome on Windows", keyHash: "secret-hash", createdAt: 1, lastSeenAt: 2 }],
      remove: async (id) => {
        calls.push(["remove", id]);
        return true;
      },
    },
    readSettings: async () => ({ browserAccess }),
    writeBrowserAccess: async (patch) => {
      browserAccess = { ...browserAccess, ...patch };
      return { browserAccess };
    },
    powerSave: {
      start: () => {
        const id = nextBlocker++;
        awake.add(id);
        return id;
      },
      stop: (id) => awake.delete(id),
    },
    isPortFree: async () => portFree,
    expireBrowserClients: () => calls.push(["expireClients"]),
    now: () => 1_000,
  });
  return { service, calls, tsState, awake, settings: () => browserAccess };
}

describe("createWebService", () => {
  test("turning it on starts the server, publishes it via Serve and keeps the Mac awake", async () => {
    const h = harness();
    const status = await h.service.setEnabled(true);
    expect(status).toMatchObject({ enabled: true, running: true, url: `https://${HOST}`, problem: null });
    expect(h.calls).toEqual([["listen", WEB_PORT], ["enableServe", WEB_PORT]]);
    expect(h.awake.size).toBe(1);
    expect(h.service.gateContext()).toMatchObject({ expectedHost: HOST, ownerLogin: "me@example.com" });
  });

  test("never exposes device key hashes in status", async () => {
    const status = await harness().service.status();
    expect(status.devices).toEqual([{ id: "d1", label: "Chrome on Windows", createdAt: 1, lastSeenAt: 2 }]);
  });

  test.each([
    ["Tailscale not running", { info: { running: false, host: null, ownerLogin: null, httpsAvailable: false } }, "Tailscale isn't running"],
    ["not signed in", { info: { running: true, host: null, ownerLogin: null, httpsAvailable: false } }, "isn't signed in"],
    ["HTTPS certificates off", { info: { running: true, host: HOST, ownerLogin: "me@example.com", httpsAvailable: false } }, "HTTPS certificates are off"],
    ["HTTPS taken by another Serve setup", { serve: { httpsInUse: true, proxiesTo: "http://127.0.0.1:9000" } }, "already used by another Tailscale Serve setup"],
    ["port busy", { portFree: false }, "Port 4317"],
  ])("%s: stays off and says why", async (_label, opts, message) => {
    const h = harness(opts);
    const status = await h.service.setEnabled(true);
    expect(status.running).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.problem).toContain(message);
    expect(h.calls.find(([name]) => name === "enableServe")).toBeUndefined();
    expect(h.service.gateContext()).toBeNull();
  });

  test("an existing mapping to our port is reused, not re-created", async () => {
    const h = harness({ serve: { httpsInUse: true, proxiesTo: OURS } });
    await h.service.setEnabled(true);
    expect(h.calls).toEqual([["listen", WEB_PORT]]);
  });

  test("turning it off removes our Serve mapping, stops the server and lets the Mac sleep", async () => {
    const h = harness();
    await h.service.setEnabled(true);
    const status = await h.service.setEnabled(false);
    expect(status).toMatchObject({ enabled: false, running: false, url: null });
    expect(h.calls.slice(2)).toEqual([["disableServe"], ["close"], ["expireClients"]]);
    expect(h.awake.size).toBe(0);
  });

  test("does not remove a Serve mapping someone else replaced ours with", async () => {
    const h = harness();
    await h.service.setEnabled(true);
    h.tsState.serve = { httpsInUse: true, proxiesTo: "http://127.0.0.1:9000" };
    await h.service.setEnabled(false);
    expect(h.calls.find(([name]) => name === "disableServe")).toBeUndefined();
  });

  test("keep-awake follows the setting", async () => {
    const h = harness({ keepAwake: false });
    await h.service.setEnabled(true);
    expect(h.awake.size).toBe(0);
    await h.service.setKeepAwake(true);
    expect(h.awake.size).toBe(1);
    await h.service.setKeepAwake(false);
    expect(h.awake.size).toBe(0);
  });

  test("pairing links need browser access on and use the .ts.net address", async () => {
    const h = harness();
    expect(() => h.service.createPairingLink()).toThrow("Turn on browser access first.");
    await h.service.setEnabled(true);
    expect(h.service.createPairingLink()).toEqual({ url: `https://${HOST}/pair?token=tok123`, expiresAt: 601_000 });
  });

  test("removing a device revokes it and closes its connections", async () => {
    const h = harness();
    await h.service.removeDevice("d1");
    expect(h.calls).toEqual([["remove", "d1"], ["disconnect", "d1"]]);
  });

  test("startIfEnabled starts only when the setting is on; shutdown keeps the setting", async () => {
    const h = harness();
    await h.service.startIfEnabled();
    expect(h.calls).toEqual([]);
    await h.service.setEnabled(true);
    await h.service.shutdown();
    expect(h.settings().enabled).toBe(true);
    expect((await h.service.status()).running).toBe(false);
  });

  test("overlapping setEnabled(true) calls start the server once", async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.service.setEnabled(true), h.service.setEnabled(true)]);
    expect(h.calls.filter(([name]) => name === "listen")).toEqual([["listen", WEB_PORT]]);
    expect(h.calls.filter(([name]) => name === "enableServe").length).toBeLessThanOrEqual(1);
    expect(h.calls.find(([name]) => name === "close")).toBeUndefined();
    expect(first.running).toBe(true);
    expect(second.running).toBe(true);
  });
});
