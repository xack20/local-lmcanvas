import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { ApiError, type ApiRegistry } from "../api/registry";
import type { BrowserClientRegistry, SocketLike } from "./browserClients";
import { deviceLabel, type DeviceStore } from "./devices";
import { checkRequest, readCookie, type GateContext } from "./security";

export const BODY_LIMIT_BYTES = 25 * 1024 * 1024;
export const DEVICE_COOKIE = "lmc_device";
export const CLIENT_HEADER = "x-lmc-client";
/** How often live sockets are pinged (dead ones dropped) and sent an app-level tick. */
export const HEARTBEAT_MS = 15_000;
/** The browser only ever sends tiny frames (it never sends any today). */
export const WS_MAX_PAYLOAD_BYTES = 4096;
// Tailscale Serve reuses its connections to us; Node's 5 s default closes them
// under it, which surfaces as sporadic 502s. Headers timeout must exceed keep-alive.
export const KEEP_ALIVE_TIMEOUT_MS = 100_000;
export const HEADERS_TIMEOUT_MS = 101_000;
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const LAST_SEQ_PATTERN = /^\d{1,16}$/;
const TICK_FRAME = JSON.stringify({ type: "tick" });
const HTML = "text/html; charset=utf-8";

const CONTENT_TYPES: Record<string, string> = {
  ".html": HTML,
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

// No page of ours is ever meant to be inside a frame.
const FRAME_CSP = "frame-ancestors 'none'";
// The pairing confirmation needs nothing but its own inline styles and form.
const PAIR_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const PAIR_BODY_LIMIT_BYTES = 4096;

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

const page = (title: string, body: string, extra = ""): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LMCanvas</title><body style="font-family:system-ui;padding:2rem;max-width:40rem"><h1>${title}</h1><p>${body}</p>${extra}</body>`;

// A GET only shows this page: link previews (Messages, Slack) fetch the URL and
// must not use up the token. Pairing happens when the button POSTs it back.
const confirmPairPage = (token: string): string =>
  page(
    "Pair this browser with LMCanvas?",
    "This browser will be able to use LMCanvas on your Mac while browser access is on.",
    `<form method="post" action="/pair"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="font:inherit;padding:0.5rem 1rem;cursor:pointer">Pair this browser</button></form>`,
  );

const NOT_PAIRED_PAGE = page(
  "This device isn't paired yet",
  "On your Mac, open LMCanvas → Settings → Browser access → Pair a device, then open the link it gives you on this device.",
);
const EXPIRED_PAIR_PAGE = page(
  "This pairing link has expired or was already used",
  "Create a new one in LMCanvas on your Mac: Settings → Browser access → Pair a device.",
);

export type IntervalTimers = {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

const realIntervals: IntervalTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export type WebServerDeps = {
  registry: ApiRegistry;
  clients: BrowserClientRegistry;
  devices: DeviceStore;
  gateContext: () => GateContext | null;
  staticRoot: string;
  homeDir: string;
  bodyLimitBytes?: number;
  now?: () => number;
  timers?: IntervalTimers;
};

export type WebServer = {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
  disconnectDevice(deviceId: string): void;
  port(): number | null;
};

class BodyTooLargeError extends Error {}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function sendText(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": HTML,
    "Content-Security-Policy": FRAME_CSP,
    "X-Frame-Options": "DENY",
    ...headers,
  });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > limit) {
      req.resume();
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > limit) reject(new BodyTooLargeError());
      else resolveBody(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", reject);
  });
}

function isArgsBody(value: unknown): value is { args: unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { args?: unknown }).args);
}

/** The last event seq a reconnecting tab processed: 0 when absent, null when unreadable. */
function parseLastSeq(raw: string | null): number | null {
  if (raw === null) return 0;
  if (!LAST_SEQ_PATTERN.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function createWebServer(deps: WebServerDeps): WebServer {
  const now = deps.now ?? Date.now;
  const limit = deps.bodyLimitBytes ?? BODY_LIMIT_BYTES;
  const timers = deps.timers ?? realIntervals;
  const staticRoot = resolve(deps.staticRoot);
  const homeDir = resolve(deps.homeDir);
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
  const sockets = new Map<WebSocket, string>();
  // Sockets pinged by the last sweep that haven't answered yet.
  const awaitingPong = new Set<WebSocket>();
  let server: Server | null = null;
  let heartbeat: unknown = null;

  // Behind Tailscale Serve a vanished browser (lid closed, network gone) may
  // never close its socket, so silence for a whole sweep counts as gone.
  // Terminating runs the normal close path: detach, then the grace period.
  const sweep = (): void => {
    for (const ws of [...sockets.keys()]) {
      if (awaitingPong.has(ws)) {
        awaitingPong.delete(ws);
        ws.terminate();
        continue;
      }
      awaitingPong.add(ws);
      try {
        ws.ping();
        ws.send(TICK_FRAME);
      } catch (error) {
        console.warn("[web] live connection heartbeat failed:", error instanceof Error ? error.message : error);
      }
    }
  };

  const stopHeartbeat = (): void => {
    if (heartbeat === null) return;
    timers.clearInterval(heartbeat);
    heartbeat = null;
  };

  type Authorized = { ok: true; deviceId: string | null } | { ok: false; status: number };

  const authorize = (req: IncomingMessage, path: string, isUpgrade: boolean): Authorized => {
    const ctx = deps.gateContext();
    if (!ctx) return { ok: false, status: 503 };
    const deviceKey = readCookie(req.headers.cookie, DEVICE_COOKIE);
    const result = checkRequest(
      {
        method: req.method ?? "GET",
        path,
        host: req.headers.host,
        origin: header(req, "origin"),
        tailscaleLogin: header(req, "tailscale-user-login"),
        deviceKey,
        isUpgrade,
      },
      ctx,
    );
    if (!result.ok) {
      console.warn(`[web] refused ${req.method ?? "GET"} ${path}: ${result.reason}`);
      return { ok: false, status: result.status };
    }
    const device = deviceKey ? deps.devices.findByKey(deviceKey) : undefined;
    if (device) {
      deps.devices.touch(device.id, now()).catch((error: unknown) => {
        console.warn("[web] couldn't record device activity:", error);
      });
    }
    return { ok: true, deviceId: device?.id ?? null };
  };

  const showPairPage = (res: ServerResponse, url: URL): void =>
    sendHtml(res, 200, confirmPairPage(url.searchParams.get("token") ?? ""), {
      "Content-Security-Policy": PAIR_PAGE_CSP,
      "Cache-Control": "no-store",
      // Not "no-referrer": that makes the form's POST send `Origin: null`, which the gate refuses.
      "Referrer-Policy": "same-origin",
    });

  const pair = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: string;
    try {
      body = await readBody(req, PAIR_BODY_LIMIT_BYTES);
    } catch {
      return sendText(res, 400, "Bad request");
    }
    const token = new URLSearchParams(body).get("token") ?? "";
    const redeemed = await deps.devices.redeemPairingToken(token, deviceLabel(header(req, "user-agent")), now());
    if (!redeemed) return sendHtml(res, 410, EXPIRED_PAIR_PAGE);
    res.writeHead(303, {
      Location: "/",
      "Set-Cookie": `${DEVICE_COOKIE}=${redeemed.deviceKey}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
    });
    res.end();
  };

  const invoke = async (req: IncomingMessage, res: ServerResponse, url: URL, deviceId: string | null): Promise<void> => {
    const channel = decodePath(url.pathname.slice("/api/".length));
    if (channel === null) return sendJson(res, 400, { ok: false, error: "Malformed request" });
    const clientId = header(req, CLIENT_HEADER) ?? "";
    if (!deviceId || !CLIENT_ID_PATTERN.test(clientId)) {
      return sendJson(res, 400, { ok: false, error: "Missing tab id" });
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, limit));
    } catch (error) {
      return error instanceof BodyTooLargeError
        ? sendJson(res, 413, { ok: false, error: "This request is too large (limit 25 MB)." })
        : sendJson(res, 400, { ok: false, error: "Malformed request" });
    }
    if (!isArgsBody(body)) return sendJson(res, 400, { ok: false, error: "Malformed request" });
    const client = deps.clients.ensure(clientId, deviceId);
    let result: unknown;
    try {
      result = await deps.registry.invoke(channel, client, body.args);
    } catch (error) {
      if (error instanceof ApiError) {
        return sendJson(res, error.code === "forbidden" ? 403 : 404, { ok: false, error: error.message });
      }
      return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    sendJson(res, 200, { ok: true, result: result ?? null });
  };

  const listDirs = async (res: ServerResponse, url: URL): Promise<void> => {
    const requested = resolve(url.searchParams.get("path") || homeDir);
    if (requested !== homeDir && !requested.startsWith(homeDir + sep)) {
      return sendJson(res, 403, { ok: false, error: "Outside your home folder" });
    }
    try {
      const entries = await readdir(requested, { withFileTypes: true });
      const dirs = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      const parent = requested === homeDir ? null : dirname(requested);
      sendJson(res, 200, { ok: true, result: { path: requested, parent, dirs } });
    } catch {
      sendJson(res, 404, { ok: false, error: "Folder not found" });
    }
  };

  const serveStatic = async (res: ServerResponse, pathname: string): Promise<void> => {
    const decoded = pathname === "/" ? "/index.html" : decodePath(pathname);
    if (decoded === null) return sendText(res, 400, "Bad request");
    const relative = decoded.replace(/^\/+/, "");
    const filePath = resolve(staticRoot, relative);
    if (!filePath.startsWith(staticRoot + sep)) return sendText(res, 404, "Not found");
    try {
      const body = await readFile(filePath);
      const isIndex = filePath.endsWith("index.html");
      const isHtml = extname(filePath) === ".html";
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": isIndex ? "no-store" : "public, max-age=31536000, immutable",
        ...(isHtml ? { "Content-Security-Policy": FRAME_CSP, "X-Frame-Options": "DENY" } : {}),
      });
      res.end(body);
    } catch {
      sendText(res, 404, "Not found");
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = authorize(req, url.pathname, false);
    if (!auth.ok) {
      return auth.status === 401
        ? sendHtml(res, 401, NOT_PAIRED_PAGE)
        : sendText(res, auth.status, "Forbidden");
    }
    if (req.method === "GET" && url.pathname === "/pair") return showPairPage(res, url);
    if (req.method === "POST" && url.pathname === "/pair") return pair(req, res);
    if (req.method === "GET" && url.pathname === "/api/fs/dirs") return listDirs(res, url);
    if (req.method === "POST" && url.pathname.startsWith("/api/")) return invoke(req, res, url, auth.deviceId);
    if (req.method === "GET") return serveStatic(res, url.pathname);
    sendText(res, 405, "Method not allowed");
  };

  const refuseUpgrade = (socket: Duplex, status: number): void => {
    if (socket.destroyed) return;
    socket.on("error", () => undefined);
    try {
      socket.write(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
    } catch (error) {
      console.warn("[web] could not answer a refused connection:", error instanceof Error ? error.message : error);
    }
    socket.destroy();
  };

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") return refuseUpgrade(socket, 404);
      const auth = authorize(req, url.pathname, true);
      if (!auth.ok) return refuseUpgrade(socket, auth.status);
      const clientId = url.searchParams.get("client") ?? "";
      if (!auth.deviceId || !CLIENT_ID_PATTERN.test(clientId)) return refuseUpgrade(socket, 400);
      const deviceId = auth.deviceId;
      const lastSeq = parseLastSeq(url.searchParams.get("after"));
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", (error) => {
          console.warn("[web] live connection error:", error.message);
          ws.terminate();
        });
        const tracked: SocketLike = { send: (data) => ws.send(data), close: () => ws.close() };
        sockets.set(ws, deviceId);
        ws.on("pong", () => awaitingPong.delete(ws));
        ws.on("close", () => {
          sockets.delete(ws);
          awaitingPong.delete(ws);
          deps.clients.detach(clientId, tracked);
        });
        try {
          const { resumed, seq } = deps.clients.attach(clientId, deviceId, tracked, lastSeq);
          ws.send(JSON.stringify({ type: "welcome", resumed, seq }));
        } catch (error) {
          console.warn("[web] live connection setup failed:", error instanceof Error ? error.message : error);
          ws.terminate();
        }
      });
    } catch (error) {
      console.warn("[web] refused live connection:", error instanceof Error ? error.message : error);
      refuseUpgrade(socket, 400);
    }
  };

  return {
    listen: (port) =>
      new Promise((resolveListen, reject) => {
        const created = createServer((req, res) => {
          handle(req, res).catch((error: unknown) => {
            console.error("[web] request failed:", error);
            if (res.headersSent) res.destroy();
            else sendText(res, 500, "Internal error");
          });
        });
        created.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
        created.headersTimeout = HEADERS_TIMEOUT_MS;
        created.on("upgrade", upgrade);
        created.on("error", reject);
        created.listen(port, "127.0.0.1", () => {
          created.off("error", reject);
          created.on("error", (error) => console.error("[web] server error:", error));
          server = created;
          stopHeartbeat();
          heartbeat = timers.setInterval(sweep, HEARTBEAT_MS);
          resolveListen();
        });
      }),
    close: () =>
      new Promise((resolveClose) => {
        stopHeartbeat();
        for (const ws of sockets.keys()) ws.terminate();
        sockets.clear();
        awaitingPong.clear();
        const current = server;
        server = null;
        if (!current) return resolveClose();
        current.close(() => resolveClose());
        current.closeAllConnections();
      }),
    disconnectDevice(deviceId) {
      for (const [ws, owner] of [...sockets]) {
        if (owner === deviceId) ws.close();
      }
      deps.clients.expireDevice(deviceId);
    },
    port() {
      const address = server?.address();
      return typeof address === "object" && address !== null ? address.port : null;
    },
  };
}
