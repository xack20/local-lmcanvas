// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { CONNECTION_LOST_MESSAGE, LOGIN_ON_MAC_MESSAGE, createWebApi } from "./webBridge.ts";

const ORIGIN = "https://my-mac.tail1234.ts.net";

function harness(responses = {}) {
  const fetchCalls = [];
  const sockets = [];
  const scheduled = [];
  const states = [];
  const ui = { picked: [], copied: [], opened: [], notices: [] };
  const api = createWebApi({
    fetchFn: async (url, init) => {
      fetchCalls.push({ url, init });
      const channel = decodeURIComponent(url.split("/api/")[1]);
      return { status: 200, json: async () => responses[channel] ?? { ok: true, result: null } };
    },
    openSocket: (url) => {
      const socket = { url, onopen: null, onmessage: null, onclose: null, closed: false, close() { socket.closed = true; } };
      sockets.push(socket);
      return socket;
    },
    origin: ORIGIN,
    clientId: "client123456",
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
    ui: {
      pickFolder: async (start) => {
        ui.picked.push(start);
        return "/Users/me/project";
      },
      copyPath: async (path) => {
        ui.copied.push(path);
      },
      openUrl: (url) => ui.opened.push(url),
      notify: (message) => ui.notices.push(message),
    },
    onConnection: (state) => states.push(state),
  });
  const last = () => sockets[sockets.length - 1];
  const server = {
    welcome: (resumed) => last().onmessage({ data: JSON.stringify({ type: "welcome", resumed }) }),
    event: (channel, payload) => last().onmessage({ data: JSON.stringify({ type: "event", channel, payload }) }),
    drop: () => last().onclose(),
  };
  return { api, fetchCalls, sockets, scheduled, states, ui, server };
}

describe("createWebApi calls", () => {
  test("POSTs the channel and args with the tab id and returns the result", async () => {
    const h = harness({ "canvases:read": { ok: true, result: { id: "c1" } } });
    expect(await h.api.canvases.read("c1")).toEqual({ id: "c1" });
    const { url, init } = h.fetchCalls[0];
    expect(url).toBe(`${ORIGIN}/api/canvases%3Aread`);
    expect(init.method).toBe("POST");
    expect(init.headers["X-LMC-Client"]).toBe("client123456");
    expect(JSON.parse(init.body)).toEqual({ args: ["c1"] });
  });

  test("turns ok:false into a rejected promise with the server's message", async () => {
    const h = harness({ "canvases:write": { ok: false, error: "This chat is open on another device." } });
    await expect(h.api.canvases.write({ id: "c1" })).rejects.toThrow("This chat is open on another device.");
  });
});

describe("createWebApi live events", () => {
  test("connects to /ws with the tab id and reports the connection", () => {
    const h = harness();
    expect(h.sockets[0].url).toBe("wss://my-mac.tail1234.ts.net/ws?client=client123456");
    expect(h.states).toEqual(["connecting"]);
    h.server.welcome(false);
    expect(h.states).toEqual(["connecting", "connected"]);
  });

  test("delivers chat events and ask-user requests to subscribers", () => {
    const h = harness();
    const chat = [];
    const asks = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    h.api.askUser.onRequest((req) => asks.push(req));
    h.server.event("chat:event", { chatId: "c1", type: "text_delta", text: "hi" });
    h.server.event("askUser:request", { id: "q1", nodeId: "n1", questions: [] });
    expect(chat).toEqual([{ chatId: "c1", type: "text_delta", text: "hi" }]);
    expect(asks).toEqual([{ id: "q1", nodeId: "n1", questions: [] }]);
  });

  test("marks running chats stopped when the Mac no longer knows this tab", async () => {
    const h = harness();
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    await h.api.chat.start({ chatId: "c1" });
    await h.api.chat.start({ chatId: "c2" });
    h.server.event("chat:event", { chatId: "c2", type: "done" });
    h.server.drop();
    h.scheduled[0].fn();
    h.server.welcome(false);
    expect(chat.slice(1)).toEqual([
      { chatId: "c1", type: "error", message: CONNECTION_LOST_MESSAGE },
      { chatId: "c1", type: "done", isError: true },
    ]);
  });

  test("a resumed tab gets no synthetic stop events", async () => {
    const h = harness();
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    await h.api.chat.start({ chatId: "c1" });
    h.server.drop();
    h.scheduled[0].fn();
    h.server.welcome(true);
    expect(chat).toEqual([]);
  });

  test("reconnects with backoff 1s, 2s, 4s, 8s, then 10s", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.server.drop();
      h.scheduled[i].fn();
    }
    expect(h.scheduled.map((s) => s.ms)).toEqual([1000, 2000, 4000, 8000, 10000]);
    expect(h.states.filter((s) => s === "reconnecting")).toHaveLength(5);
  });

  test("a successful connection resets the backoff", () => {
    const h = harness();
    h.server.drop();
    h.scheduled[0].fn();
    h.server.drop();
    h.scheduled[1].fn();
    h.sockets[h.sockets.length - 1].onopen();
    h.server.drop();
    expect(h.scheduled[2].ms).toBe(1000);
  });
});

describe("createWebApi desktop-only substitutes", () => {
  test("folder picking, file paths, links and login use the browser UI", async () => {
    const h = harness();
    expect(await h.api.dialog.pickFolder("/Users/me")).toBe("/Users/me/project");
    await h.api.shell.openPath("/Users/me/notes.md");
    await h.api.window.openCanvas("abc");
    await h.api.providers.openLoginTerminal("claude");
    expect(h.ui.picked).toEqual(["/Users/me"]);
    expect(h.ui.copied).toEqual(["/Users/me/notes.md"]);
    expect(h.ui.opened).toEqual([`${ORIGIN}/#/canvas/abc`]);
    expect(h.ui.notices).toEqual([LOGIN_ON_MAC_MESSAGE]);
  });

  test("browser-access management is refused in the browser", async () => {
    const h = harness();
    await expect(h.api.web.createPairingLink()).rejects.toThrow("desktop app");
    expect(h.fetchCalls).toEqual([]);
  });
});
