// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import {
  createTailscale,
  parseServeStatus,
  parseStatus,
  serveDisableArgs,
  serveEnableArgs,
  serveTarget,
} from "./tailscale.ts";

const HOST = "my-mac.tail1234.ts.net";
const STATUS = {
  BackendState: "Running",
  Self: { DNSName: `${HOST}.`, UserID: 42, HostName: "My Mac" },
  User: { 42: { ID: 42, LoginName: "me@example.com", DisplayName: "Me" } },
  CertDomains: [HOST],
};
const OURS = {
  TCP: { 443: { HTTPS: true } },
  Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: serveTarget(4317) } } } },
};

describe("parseStatus", () => {
  test("reads host, owner and HTTPS availability", () => {
    expect(parseStatus(STATUS)).toEqual({
      running: true,
      host: HOST,
      ownerLogin: "me@example.com",
      httpsAvailable: true,
    });
  });
  test("reports a stopped backend and missing certificates", () => {
    const info = parseStatus({ ...STATUS, BackendState: "Stopped", CertDomains: [] });
    expect(info.running).toBe(false);
    expect(info.httpsAvailable).toBe(false);
  });
  test("survives garbage", () => {
    expect(parseStatus(null)).toEqual({ running: false, host: null, ownerLogin: null, httpsAvailable: false });
  });
});

describe("parseServeStatus", () => {
  test("empty config means HTTPS is free", () => {
    expect(parseServeStatus({}, HOST)).toEqual({ httpsInUse: false, proxiesTo: null, funnel: false });
  });
  test("recognises our own mapping", () => {
    expect(parseServeStatus(OURS, HOST)).toEqual({ httpsInUse: true, proxiesTo: "http://127.0.0.1:4317", funnel: false });
  });
  test("someone else's HTTPS site counts as in use", () => {
    const other = { TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Path: "/srv" } } } } };
    expect(parseServeStatus(other, HOST)).toEqual({ httpsInUse: true, proxiesTo: null, funnel: false });
  });
  test("reports Funnel on HTTPS for this host", () => {
    const public443 = { ...OURS, AllowFunnel: { [`${HOST}:443`]: true } };
    expect(parseServeStatus(public443, HOST).funnel).toBe(true);
    expect(parseServeStatus({ ...OURS, AllowFunnel: { [`${HOST}:8443`]: true } }, HOST).funnel).toBe(false);
    expect(parseServeStatus({ ...OURS, AllowFunnel: { [`${HOST}:443`]: false } }, HOST).funnel).toBe(false);
    expect(parseServeStatus({ ...OURS, AllowFunnel: "yes" }, HOST).funnel).toBe(false);
  });
});

describe("createTailscale", () => {
  test("uses exactly the serve commands and never funnel", async () => {
    const calls = [];
    const exec = async (args) => {
      calls.push(args);
      if (args[0] === "status") return JSON.stringify(STATUS);
      if (args[0] === "serve" && args[1] === "status") return JSON.stringify(OURS);
      return "";
    };
    const tailscale = createTailscale(exec);
    expect((await tailscale.info()).host).toBe(HOST);
    expect((await tailscale.serveState(HOST)).proxiesTo).toBe("http://127.0.0.1:4317");
    await tailscale.enableServe(4317);
    await tailscale.disableServe();
    expect(calls).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
      ["serve", "--bg", "--https=443", "http://127.0.0.1:4317"],
      ["serve", "--https=443", "off"],
    ]);
    expect(calls.flat()).not.toContain("funnel");
  });

  test("argument builders", () => {
    expect(serveEnableArgs(4317)).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:4317"]);
    expect(serveDisableArgs()).toEqual(["serve", "--https=443", "off"]);
  });
});
