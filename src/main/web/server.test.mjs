// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApiRegistry } from "../api/registry.ts";
import { createBrowserClientRegistry } from "./browserClients.ts";
import { loadDeviceStore } from "./devices.ts";
import { HEARTBEAT_MS, createWebServer } from "./server.ts";

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

function call({ method = "GET", path, headers = {}, body, targetPort = port }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: targetPort, method, path, headers }, (res) => {
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
// Redeems a pairing token the way the confirm page's form does.
const redeem = (token, { targetPort = port, headers = {} } = {}) =>
  call({
    method: "POST",
    path: "/pair",
    headers: trusted({ Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded", ...headers }),
    body: `token=${encodeURIComponent(token)}`,
    targetPort,
  });
const paired = (extra = {}) => trusted({ Cookie: cookie, ...extra });
const apiCall = (channel, args, extra = {}) =>
  call({
    method: "POST",
    path: `/api/${encodeURIComponent(channel)}`,
    headers: paired({ Origin: ORIGIN, "X-LMC-Client": "tab12345", "Content-Type": "application/json", ...extra }),
    body: JSON.stringify({ args }),
  });

const upgradeRequest = (target, headers) =>
  [
    `GET ${target} HTTP/1.1`,
    ...Object.entries({
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...headers,
    }).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");

// Sends a raw upgrade request and resolves with the response text once the server closes the socket
// (or after waitMs, with closedByServer false).
function rawUpgrade({ target, headers, targetPort = port, waitMs = 1000 }) {
  return new Promise((resolve) => {
    const socket = connect(targetPort, "127.0.0.1");
    let text = "";
    let done = false;
    const finish = (closedByServer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ text, closedByServer });
    };
    const timer = setTimeout(() => finish(false), waitMs);
    socket.on("data", (chunk) => (text += chunk.toString("latin1")));
    socket.on("error", () => {});
    socket.on("close", () => finish(true));
    socket.write(upgradeRequest(target, headers));
  });
}

async function startIsolatedServer({ clients: isolatedClients, write, now, timers }) {
  const dir = mkdtempSync(join(tmpdir(), "lmc-isolated-"));
  mkdirSync(join(dir, "renderer"));
  writeFileSync(join(dir, "renderer", "index.html"), "<!doctype html><title>app</title>");
  const store = await loadDeviceStore(join(dir, "devices.json"), write);
  const isolated = createWebServer({
    registry: createApiRegistry(),
    clients: isolatedClients,
    devices: store,
    gateContext: () => ({ expectedHost: HOST, ownerLogin: OWNER, isPairedDevice: (k) => store.findByKey(k) !== undefined }),
    staticRoot: join(dir, "renderer"),
    homeDir: dir,
    now,
    timers,
  });
  await isolated.listen(0);
  const { token } = store.createPairingToken(Date.now());
  const pairing = await redeem(token, { targetPort: isolated.port() });
  return {
    port: isolated.port(),
    cookie: pairing.headers["set-cookie"][0].split(";")[0],
    close: async () => {
      await isolated.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

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
  registry.handle("big", async () => 10n, "shared");
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
  const paired = await redeem(token, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0" } });
  expect(paired.status).toBe(303);
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

  test("opening a pairing link only asks for confirmation, so link previews don't use it up", async () => {
    const { token } = devices.createPairingToken(Date.now());
    for (let i = 0; i < 2; i++) {
      const page = await call({ path: `/pair?token=${token}`, headers: trusted() });
      expect(page.status).toBe(200);
      expect(page.headers["set-cookie"]).toBeUndefined();
      expect(page.text).toContain("Pair this browser");
      expect(page.text).toContain('<form method="post" action="/pair">');
      expect(page.text).toContain(`name="token" value="${token}"`);
    }
    expect((await redeem(token)).status).toBe(303);
  });

  test("confirming redeems the link once, then it's gone", async () => {
    const { token } = devices.createPairingToken(Date.now());
    const first = await redeem(token);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/");
    expect(first.headers["set-cookie"][0]).toContain("HttpOnly; Secure; SameSite=Strict; Path=/");
    const second = await redeem(token);
    expect(second.status).toBe(410);
    expect(second.text).toContain("expired or was already used");
  });

  test("a confirmation from another site, or with no Origin, is refused and leaves the link usable", async () => {
    const { token } = devices.createPairingToken(Date.now());
    expect((await redeem(token, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const noOrigin = await call({
      method: "POST",
      path: "/pair",
      headers: trusted({ "Content-Type": "application/x-www-form-urlencoded" }),
      body: `token=${token}`,
    });
    expect(noOrigin.status).toBe(403);
    expect((await redeem(token)).status).toBe(303);
  });

  test("the confirm page escapes the token and allows nothing but its own form", async () => {
    const page = await call({ path: `/pair?token=${encodeURIComponent('"><script>alert(1)</script>')}`, headers: trusted() });
    expect(page.text).not.toContain("<script>");
    expect(page.text).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    const csp = page.headers["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
  });
});

describe("framing", () => {
  test("the app and the pairing pages refuse to be framed", async () => {
    for (const res of [
      await call({ path: "/", headers: paired() }),
      await call({ path: "/", headers: trusted() }),
      await redeem("not-a-token"),
    ]) {
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
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
    const outside = join(root, "devices.json");
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(outside, "utf-8")).toContain("keyHash");
    for (const path of ["/..%2fdevices.json", "/assets/..%2f..%2fdevices.json"]) {
      const res = await call({ path, headers: paired() });
      expect(res.status).toBe(404);
      expect(res.text).not.toContain("keyHash");
    }
  });

  test("a malformed percent-escape in the path is a 400, not a crash", async () => {
    expect((await call({ path: "/%E0%A4%A", headers: paired() })).status).toBe(400);
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

  test("a result that cannot be serialised is a 500 and does not hang the request", async () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      expect((await apiCall("big", [])).status).toBe(500);
    } finally {
      console.error = originalError;
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[web] request failed:");
    expect((await apiCall("echo", [3])).status).toBe(200);
  });

  test("a malformed percent-escape in the channel is a 400, not a crash", async () => {
    const res = await call({
      method: "POST",
      path: "/api/%E0%A4%A",
      headers: paired({ Origin: ORIGIN, "X-LMC-Client": "tab12345", "Content-Type": "application/json" }),
      body: JSON.stringify({ args: [] }),
    });
    expect(res.status).toBe(400);
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

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("live connection", () => {
  const open = (client, after, epoch) =>
    new Promise((resolve, reject) => {
      const query = `${epoch === undefined ? "" : `&epoch=${epoch}`}${after === undefined ? "" : `&after=${after}`}`;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?client=${client}${query}`, {
        headers: paired({ Origin: ORIGIN }),
      });
      const messages = [];
      ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
      ws.on("open", () => resolve({ ws, messages }));
      ws.on("error", reject);
    });

  test("welcomes a new tab, delivers numbered events, and replays what it missed after a reconnect", async () => {
    const first = await open("tabws001", 0);
    await settle();
    expect(first.messages).toEqual([{ type: "welcome", resumed: false, seq: 0, epoch: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/) }]);
    const { epoch } = first.messages[0];
    clients.get("tabws001").send("chat:event", { n: 1 });
    await settle();
    expect(first.messages[1]).toEqual({ type: "event", seq: 1, channel: "chat:event", payload: { n: 1 } });
    first.ws.close();
    await settle();
    clients.get("tabws001").send("chat:event", { n: 2 });
    const second = await open("tabws001", 1, epoch);
    await settle();
    expect(second.messages).toEqual([
      { type: "event", seq: 2, channel: "chat:event", payload: { n: 2 } },
      { type: "welcome", resumed: true, seq: 2, epoch },
    ]);
    second.ws.close();
  });

  test("a tab whose epoch isn't this client's starts over with a new client", async () => {
    const first = await open("tabws005", 0);
    await settle();
    const { epoch } = first.messages[0];
    const old = clients.get("tabws005");
    old.send("chat:event", { n: 1 });
    first.ws.close();
    await settle();
    for (const stale of ["someOtherEpoch", "%3Cscript%3E", "x".repeat(65)]) {
      const again = await open("tabws005", 1, stale);
      await settle();
      expect(again.messages).toEqual([{ type: "welcome", resumed: false, seq: 0, epoch: expect.any(String) }]);
      expect(again.messages[0].epoch).not.toBe(epoch);
      again.ws.close();
      await settle();
    }
    expect(old.isGone()).toBe(true);
  });

  test("an unreadable last seq is not resumed for a tab the server knows", async () => {
    const first = await open("tabws004", 0);
    await settle();
    let { epoch } = first.messages[0];
    clients.get("tabws004").send("chat:event", { n: 1 });
    first.ws.close();
    await settle();
    for (const after of ["abc", "-1", "1.5", "99999999999999999999"]) {
      const again = await open("tabws004", after, epoch);
      await settle();
      expect(again.messages).toEqual([{ type: "welcome", resumed: false, seq: 0, epoch: expect.any(String) }]);
      expect(again.messages[0].epoch).not.toBe(epoch);
      epoch = again.messages[0].epoch;
      clients.get("tabws004").send("chat:event", { n: 1 });
      again.ws.close();
      await settle();
    }
  });

  test("removing a device closes its live connection", async () => {
    const { ws } = await open("tabws002");
    const closed = new Promise((r) => ws.on("close", r));
    const device = devices.list()[0];
    server.disconnectDevice(device.id);
    await closed;
    expect(clients.get("tabws002")).toBeUndefined();
  });

  test("a malformed frame disconnects that tab and the server keeps serving", async () => {
    const request = upgradeRequest("/ws?client=tabws003", paired({ Origin: ORIGIN }));
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    const closed = new Promise((r) => socket.on("close", r));
    socket.write(request);
    await new Promise((r) => socket.once("data", r));
    socket.write(Buffer.from([0x81, 0x01, 0x41]));
    await closed;
    expect((await apiCall("echo", [1])).status).toBe(200);
  });
});

describe("live connection refusals", () => {
  const target = "/ws?client=tabref001";

  test("refuses a device that has no pairing cookie", async () => {
    const res = await rawUpgrade({ target, headers: trusted({ Origin: ORIGIN }) });
    expect(res.text.startsWith("HTTP/1.1 401")).toBe(true);
    expect(res.closedByServer).toBe(true);
    expect(clients.get("tabref001")).toBeUndefined();
  });

  test("refuses a page from another site", async () => {
    const res = await rawUpgrade({ target, headers: paired({ Origin: "https://evil.example" }) });
    expect(res.text.startsWith("HTTP/1.1 403")).toBe(true);
    expect(res.closedByServer).toBe(true);
    expect(clients.get("tabref001")).toBeUndefined();
  });

  test("answers an absolute-form request target with a 400 and keeps serving", async () => {
    for (const absolute of ["http://a:99999/ws", "http://["]) {
      const res = await rawUpgrade({ target: absolute, headers: paired({ Origin: ORIGIN }) });
      expect(res.text.startsWith("HTTP/1.1 400")).toBe(true);
      expect(res.closedByServer).toBe(true);
    }
    expect((await call({ path: "/", headers: paired() })).status).toBe(200);
  });
});

describe("device activity bookkeeping", () => {
  let isolated;
  let failWrites = false;
  let clock = Date.now();

  beforeAll(async () => {
    isolated = await startIsolatedServer({
      clients: createBrowserClientRegistry({ graceMs: 60_000 }),
      write: async (path, contents) => {
        if (failWrites) throw new Error("disk full");
        await writeFile(path, contents);
      },
      now: () => clock,
    });
    clock += 2 * 60 * 1000;
  });

  afterAll(() => isolated.close());

  test("a failed last-seen write is logged and the request still succeeds", async () => {
    failWrites = true;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const res = await call({ path: "/", headers: trusted({ Cookie: isolated.cookie }), targetPort: isolated.port });
      await new Promise((r) => setTimeout(r, 50));
      expect(res.status).toBe(200);
      expect(warnings).toEqual(["[web] couldn't record device activity: Error: disk full"]);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("a live connection that fails to register", () => {
  let isolated;

  beforeAll(async () => {
    isolated = await startIsolatedServer({
      clients: createBrowserClientRegistry({
        graceMs: 60_000,
        onCreated: () => {
          throw new Error("registry unavailable");
        },
      }),
    });
  });

  afterAll(() => isolated.close());

  test("is closed and the server keeps serving", async () => {
    const res = await rawUpgrade({
      target: "/ws?client=tabfail01",
      headers: trusted({ Cookie: isolated.cookie, Origin: ORIGIN }),
      targetPort: isolated.port,
    });
    expect(res.closedByServer).toBe(true);
    const page = await call({ path: "/", headers: trusted({ Cookie: isolated.cookie }), targetPort: isolated.port });
    expect(page.status).toBe(200);
  });
});

function fakeIntervals() {
  const started = [];
  const cleared = [];
  return {
    started,
    cleared,
    setInterval(fn, ms) {
      started.push({ fn, ms });
      return started.length;
    },
    clearInterval(handle) {
      cleared.push(handle);
    },
    sweep: () => started[started.length - 1].fn(),
  };
}

function manualScheduler() {
  const timers = new Map();
  let next = 1;
  return {
    setTimeout(fn) {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
  };
}

describe("heartbeat", () => {
  let isolated;
  let timers;
  let scheduler;
  let hbClients;

  beforeAll(async () => {
    timers = fakeIntervals();
    scheduler = manualScheduler();
    hbClients = createBrowserClientRegistry({ graceMs: 60_000, scheduler });
    isolated = await startIsolatedServer({ clients: hbClients, timers });
  });

  afterAll(() => isolated?.close());

  test("sweeps every 15 s while listening", () => {
    expect(HEARTBEAT_MS).toBe(15_000);
    expect(timers.started.map((t) => t.ms)).toEqual([HEARTBEAT_MS]);
  });

  test("a live socket that answers pings stays open and gets an app-level tick each sweep", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${isolated.port}/ws?client=tabhb001&after=0`, {
      headers: trusted({ Cookie: isolated.cookie, Origin: ORIGIN }),
    });
    const messages = [];
    ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    await settle();
    timers.sweep();
    await settle();
    timers.sweep();
    await settle();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(messages.filter((m) => m.type === "tick")).toHaveLength(2);
    ws.close();
    await settle();
  });

  test("a socket that stops answering pings is terminated and its tab's grace period starts", async () => {
    const socket = connect(isolated.port, "127.0.0.1");
    socket.on("error", () => {});
    socket.write(upgradeRequest("/ws?client=tabhb002&after=0", trusted({ Cookie: isolated.cookie, Origin: ORIGIN })));
    await new Promise((r) => socket.once("data", r));
    const pendingBefore = scheduler.pending();
    const client = hbClients.get("tabhb002");
    expect(client).toBeDefined();

    timers.sweep();
    await settle();
    expect(scheduler.pending()).toBe(pendingBefore);
    timers.sweep();
    await settle();

    expect(scheduler.pending()).toBe(pendingBefore + 1);
    expect(client.isGone()).toBe(false);
    socket.destroy();
  });

  test("closing the server stops the heartbeat", async () => {
    await isolated.close();
    isolated = null;
    expect(timers.cleared).toEqual([1]);
  });
});

