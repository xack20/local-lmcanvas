// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApiRegistry } from "../api/registry.ts";
import { createBrowserClientRegistry } from "./browserClients.ts";
import { loadDeviceStore } from "./devices.ts";
import { createWebServer } from "./server.ts";

const HOST = "my-mac.tail1234.ts.net";
const ORIGIN = `https://${HOST}`;
const OWNER = "me@example.com";

let root;
let server;
let port;
let devices;
let clients;
let cookie;
let ranSecret = 0;

function call({ method = "GET", path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const trusted = (extra = {}) => ({ Host: HOST, "Tailscale-User-Login": OWNER, ...extra });
const paired = (extra = {}) => trusted({ Cookie: cookie, ...extra });
const apiCall = (channel, args, extra = {}) =>
  call({
    method: "POST",
    path: `/api/${encodeURIComponent(channel)}`,
    headers: paired({ Origin: ORIGIN, "X-LMC-Client": "tab12345", "Content-Type": "application/json", ...extra }),
    body: JSON.stringify({ args }),
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lmc-server-"));
  const staticRoot = join(root, "renderer");
  mkdirSync(join(staticRoot, "assets"), { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(staticRoot, "assets", "app.js"), "console.log(1)");
  const home = join(root, "home");
  mkdirSync(join(home, "projects"), { recursive: true });
  mkdirSync(join(home, ".hidden"), { recursive: true });

  devices = await loadDeviceStore(join(root, "devices.json"));
  clients = createBrowserClientRegistry({ graceMs: 60_000 });
  const registry = createApiRegistry();
  registry.handle("echo", async (client, ...args) => ({ kind: client.kind, args }), "shared");
  registry.handle(
    "boom",
    async () => {
      throw new Error("nope");
    },
    "shared",
  );
  registry.handle("web:createPairingLink", async () => ++ranSecret, "desktop-only");

  server = createWebServer({
    registry,
    clients,
    devices,
    gateContext: () => ({ expectedHost: HOST, ownerLogin: OWNER, isPairedDevice: (k) => devices.findByKey(k) !== undefined }),
    staticRoot,
    homeDir: home,
    bodyLimitBytes: 1024,
  });
  await server.listen(0);
  port = server.port();

  const { token } = devices.createPairingToken(Date.now());
  const paired = await call({ path: `/pair?token=${token}`, headers: trusted({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0" }) });
  expect(paired.status).toBe(302);
  cookie = paired.headers["set-cookie"][0].split(";")[0];
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("web server gate", () => {
  test("refuses requests that did not come through Tailscale as the owner", async () => {
    expect((await call({ path: "/", headers: { Host: HOST } })).status).toBe(403);
    expect((await call({ path: "/", headers: trusted({ Host: "evil.example" }) })).status).toBe(403);
  });

  test("an unpaired device gets the pairing instructions", async () => {
    const res = await call({ path: "/", headers: trusted() });
    expect(res.status).toBe(401);
    expect(res.text).toContain("isn't paired");
  });

  test("a pairing link works once", async () => {
    const { token } = devices.createPairingToken(Date.now());
    const first = await call({ path: `/pair?token=${token}`, headers: trusted() });
    expect(first.headers["set-cookie"][0]).toContain("HttpOnly; Secure; SameSite=Strict; Path=/");
    expect((await call({ path: `/pair?token=${token}`, headers: trusted() })).status).toBe(410);
  });
});

describe("static files", () => {
  test("serves the app and its assets to a paired device", async () => {
    const page = await call({ path: "/", headers: paired() });
    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>app</title>");
    const js = await call({ path: "/assets/app.js", headers: paired() });
    expect(js.headers["content-type"]).toContain("text/javascript");
  });

  test("never serves files outside the app folder", async () => {
    expect((await call({ path: "/%2e%2e/%2e%2e/devices.json", headers: paired() })).status).toBe(404);
  });
});

describe("API calls", () => {
  test("routes a call to the shared table as a browser client", async () => {
    const res = await apiCall("echo", [1, "a"]);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true, result: { kind: "browser", args: [1, "a"] } });
  });

  test("refuses calls from another site", async () => {
    expect((await apiCall("echo", [], { Origin: "https://evil.example" })).status).toBe(403);
  });

  test("refuses desktop-only channels without running them", async () => {
    const res = await apiCall("web:createPairingLink", []);
    expect(res.status).toBe(403);
    expect(ranSecret).toBe(0);
  });

  test("unknown channels are 404 and handler errors come back as ok:false", async () => {
    expect((await apiCall("nope", [])).status).toBe(404);
    expect(JSON.parse((await apiCall("boom", [])).text)).toEqual({ ok: false, error: "nope" });
  });

  test("malformed and oversized bodies are refused and the server keeps working", async () => {
    const malformed = await call({
      method: "POST",
      path: "/api/echo",
      headers: paired({ Origin: ORIGIN, "X-LMC-Client": "tab12345" }),
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    const tooLarge = await apiCall("echo", ["x".repeat(2048)]);
    expect(tooLarge.status).toBe(413);
    expect((await apiCall("echo", [2])).status).toBe(200);
  });

  test("requires a tab id", async () => {
    expect((await apiCall("echo", [], { "X-LMC-Client": "" })).status).toBe(400);
  });
});

describe("folder listing", () => {
  test("lists visible folders inside the home folder only", async () => {
    const res = await call({ path: "/api/fs/dirs", headers: paired() });
    const body = JSON.parse(res.text);
    expect(body.result.dirs).toEqual(["projects"]);
    expect(body.result.parent).toBeNull();
    expect((await call({ path: "/api/fs/dirs?path=%2Fetc", headers: paired() })).status).toBe(403);
  });
});

describe("live connection", () => {
  const open = (client) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?client=${client}`, {
        headers: paired({ Origin: ORIGIN }),
      });
      const messages = [];
      ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
      ws.on("open", () => resolve({ ws, messages }));
      ws.on("error", reject);
    });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  test("welcomes a new tab, delivers events, and replays them after a reconnect", async () => {
    const first = await open("tabws001");
    await settle();
    expect(first.messages).toEqual([{ type: "welcome", resumed: false }]);
    clients.get("tabws001").send("chat:event", { n: 1 });
    await settle();
    expect(first.messages[1]).toEqual({ type: "event", channel: "chat:event", payload: { n: 1 } });
    first.ws.close();
    await settle();
    clients.get("tabws001").send("chat:event", { n: 2 });
    const second = await open("tabws001");
    await settle();
    expect(second.messages).toEqual([
      { type: "event", channel: "chat:event", payload: { n: 2 } },
      { type: "welcome", resumed: true },
    ]);
    second.ws.close();
  });

  test("removing a device closes its live connection", async () => {
    const { ws } = await open("tabws002");
    const closed = new Promise((r) => ws.on("close", r));
    const device = devices.list()[0];
    server.disconnectDevice(device.id);
    await closed;
    expect(clients.get("tabws002")).toBeUndefined();
  });
});
