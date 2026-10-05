// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, spyOn, test } from "bun:test";
import { CONNECTION_LOST_MESSAGE, LOGIN_ON_MAC_MESSAGE, createWebApi } from "./webBridge.ts";

const ORIGIN = "https://my-mac.tail1234.ts.net";
const START_RECHECK_MS = 3000;
const WATCHDOG_MS = 45_000;
const PAIRING_MESSAGE = "This browser is no longer paired. Open a new pairing link from the Mac.";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// A fake clock for the connection watchdog.
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    set(fn, ms) {
      const id = next++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clear(id) {
      pending.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at > now || !pending.has(id)) continue;
        pending.delete(id);
        timer.fn();
      }
    },
    pending: () => pending.size,
  };
}

// `net` steers the fake network: channels in `failing` reject like a dropped
// fetch (no HTTP response), `statuses` overrides the HTTP status per channel,
// and `isActive` answers chat:isActive (a value, or a function returning a promise).
function harness(responses = {}) {
  const net = { failing: new Set(), statuses: {}, isActive: false };
  const fetchCalls = [];
  const sockets = [];
  const scheduled = [];
  const states = [];
  const ui = { picked: [], copied: [], opened: [], notices: [] };
  const timers = fakeTimers();
  const pageHide = [];
  let seq = 0;
  const api = createWebApi({
    fetchFn: async (url, init) => {
      fetchCalls.push({ url, init });
      const channel = decodeURIComponent(url.split("/api/")[1]);
      if (net.failing.has(channel)) throw new TypeError("Failed to fetch");
      const status = net.statuses[channel] ?? 200;
      if (channel === "chat:isActive" && !responses[channel]) {
        const result = typeof net.isActive === "function" ? await net.isActive() : net.isActive;
        return { status, json: async () => ({ ok: true, result }) };
      }
      if (status !== 200 && !responses[channel]) {
        return { status, json: async () => Promise.reject(new SyntaxError("Unexpected token <")) };
      }
      return { status, json: async () => responses[channel] ?? { ok: true, result: null } };
    },
    openSocket: (url) => {
      const socket = { url, onopen: null, onmessage: null, onclose: null, closed: false, close() { socket.closed = true; } };
      sockets.push(socket);
      return socket;
    },
    origin: ORIGIN,
    clientId: "client123456",
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
    timers,
    onPageHide: (listener) => pageHide.push(listener),
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
  const frame = (message) => last().onmessage({ data: JSON.stringify(message) });
  const server = {
    welcome: (resumed, seq) => frame({ type: "welcome", resumed, ...(seq === undefined ? {} : { seq }) }),
    event: (channel, payload) => frame({ type: "event", seq: ++seq, channel, payload }),
    // An event with an explicit seq; later `event` calls continue from it.
    eventAt: (at, channel, payload) => {
      seq = Math.max(seq, at);
      frame({ type: "event", seq: at, channel, payload });
    },
    tick: () => frame({ type: "tick" }),
    // A new server-side client numbers its events from 1 again.
    restartNumbering: () => (seq = 0),
    drop: () => last().onclose(),
    // Runs the newest pending reconnect (not a chat recheck).
    reconnect: () => [...scheduled].reverse().find((s) => s.ms !== START_RECHECK_MS).fn(),
  };
  const isActiveCalls = () => fetchCalls.filter((c) => c.url.endsWith("/api/chat%3AisActive"));
  const hidePage = (persisted) => pageHide.forEach((listener) => listener(persisted));
  return { api, net, fetchCalls, isActiveCalls, sockets, scheduled, states, ui, server, timers, hidePage };
}

const recheck = (h) => h.scheduled.filter((s) => s.ms === START_RECHECK_MS);

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
    expect(h.sockets[0].url).toBe("wss://my-mac.tail1234.ts.net/ws?client=client123456&after=0");
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

const syntheticStop = (chatId) => [
  { chatId, type: "error", message: CONNECTION_LOST_MESSAGE },
  { chatId, type: "done", isError: true },
];

// A connected tab whose chat:start request dies in transit (network change).
async function startDroppedChat(h, chatId = "c1") {
  const chat = [];
  h.api.chat.onEvent((ev) => chat.push(ev));
  h.server.welcome(true);
  h.net.failing.add("chat:start");
  const outcome = { state: "pending" };
  const started = h.api.chat.start({ chatId }).then(
    () => (outcome.state = "resolved"),
    (error) => ((outcome.state = "rejected"), (outcome.error = error)),
  );
  await flush();
  h.net.failing.delete("chat:start");
  return { chat, outcome, started };
}

const reconnectResumed = async (h) => {
  h.server.drop();
  h.server.reconnect();
  h.server.welcome(true);
  await flush();
};

describe("createWebApi chat start that loses its connection", () => {
  test("keeps following a dropped start and stops it after reconnect when the Mac is not running it", async () => {
    const h = harness();
    const { chat, outcome, started } = await startDroppedChat(h);
    expect(outcome.state).toBe("pending");
    h.net.isActive = false;
    await reconnectResumed(h);
    await started;
    expect(chat).toEqual(syntheticStop("c1"));
    expect(outcome.state).toBe("resolved");
    expect(JSON.parse(h.isActiveCalls()[0].init.body)).toEqual({ args: ["c1"] });
  });

  test("keeps waiting while the Mac is still running it, and resolves on the real done", async () => {
    const h = harness();
    const { chat, outcome, started } = await startDroppedChat(h);
    h.net.isActive = true;
    await reconnectResumed(h);
    expect(chat).toEqual([]);
    expect(outcome.state).toBe("pending");
    h.server.event("chat:event", { chatId: "c1", type: "text_delta", text: "late" });
    h.server.event("chat:event", { chatId: "c1", type: "done" });
    await started;
    expect(chat.map((ev) => ev.type)).toEqual(["text_delta", "done"]);
    expect(outcome.state).toBe("resolved");
    await reconnectResumed(h);
    expect(h.isActiveCalls()).toHaveLength(1);
  });

  test("asks nothing when the chat's done was replayed before the welcome", async () => {
    const h = harness();
    const { chat, outcome, started } = await startDroppedChat(h);
    h.server.drop();
    h.server.reconnect();
    h.server.event("chat:event", { chatId: "c1", type: "text_delta", text: "replayed" });
    h.server.event("chat:event", { chatId: "c1", type: "done" });
    h.server.welcome(true);
    await flush();
    await started;
    expect(h.isActiveCalls()).toEqual([]);
    expect(chat.map((ev) => ev.type)).toEqual(["text_delta", "done"]);
    expect(outcome.state).toBe("resolved");
  });

  test("rechecks 3 s after a failure while still connected and stops a chat the Mac is not running", async () => {
    const h = harness();
    const { chat, outcome, started } = await startDroppedChat(h);
    expect(recheck(h)).toHaveLength(1);
    expect(outcome.state).toBe("pending");
    h.net.isActive = false;
    await recheck(h)[0].fn();
    await started;
    expect(chat).toEqual(syntheticStop("c1"));
    expect(outcome.state).toBe("resolved");
  });

  test("schedules no recheck when the failure happens while disconnected", async () => {
    const h = harness();
    h.server.welcome(true);
    h.server.drop();
    h.net.failing.add("chat:start");
    h.api.chat.start({ chatId: "c1" });
    await flush();
    expect(recheck(h)).toEqual([]);
  });

  test("a recheck that fires after the socket dropped waits for the next welcome", async () => {
    const h = harness();
    const { chat, started } = await startDroppedChat(h);
    h.server.drop();
    await recheck(h)[0].fn();
    expect(h.isActiveCalls()).toEqual([]);
    h.server.reconnect();
    h.server.event("chat:event", { chatId: "c1", type: "done" });
    h.server.welcome(true);
    await started;
    expect(chat.map((ev) => ev.type)).toEqual(["done"]);
  });

  test("a done that lands while the question is in flight is not followed by a second stop", async () => {
    const h = harness();
    const { chat, started } = await startDroppedChat(h);
    let answer;
    h.net.isActive = () => new Promise((resolve) => (answer = resolve));
    const settling = recheck(h)[0].fn();
    await flush();
    h.server.event("chat:event", { chatId: "c1", type: "done" });
    answer(false);
    await settling;
    await started;
    expect(chat).toEqual([{ chatId: "c1", type: "done" }]);
  });

  test("an answer that arrives after the socket dropped is not believed", async () => {
    const h = harness();
    const { chat, started } = await startDroppedChat(h);
    let answer;
    h.net.isActive = () => new Promise((resolve) => (answer = resolve));
    const settling = recheck(h)[0].fn();
    await flush();
    h.server.drop();
    answer(false);
    await settling;
    expect(chat).toEqual([]);
    h.net.isActive = false;
    h.server.reconnect();
    h.server.event("chat:event", { chatId: "c1", type: "text_delta", text: "queued while away" });
    h.server.event("chat:event", { chatId: "c1", type: "done" });
    h.server.welcome(true);
    await started;
    expect(chat.map((ev) => ev.type)).toEqual(["text_delta", "done"]);
  });

  test("leaves the chat uncertain when the question itself fails, and the next welcome asks again", async () => {
    const h = harness();
    const { chat, outcome, started } = await startDroppedChat(h);
    h.net.failing.add("chat:isActive");
    await recheck(h)[0].fn();
    expect(chat).toEqual([]);
    expect(outcome.state).toBe("pending");
    h.net.failing.delete("chat:isActive");
    h.net.isActive = false;
    await reconnectResumed(h);
    await started;
    expect(chat).toEqual(syntheticStop("c1"));
  });

  test("a tab the Mac no longer knows stops the chat without asking", async () => {
    const h = harness();
    const { chat, outcome, started } = await startDroppedChat(h);
    h.server.drop();
    h.server.reconnect();
    h.server.welcome(false);
    await started;
    expect(chat).toEqual(syntheticStop("c1"));
    expect(outcome.state).toBe("resolved");
    expect(h.isActiveCalls()).toEqual([]);
  });

  test("a start the server rejected is not followed, so a later welcome(false) does not stop it", async () => {
    const h = harness({ "chat:start": { ok: false, error: "No such canvas" } });
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    await expect(h.api.chat.start({ chatId: "c1" })).rejects.toThrow("No such canvas");
    h.server.drop();
    h.server.reconnect();
    h.server.welcome(false);
    expect(chat).toEqual([]);
  });

  test("an HTTP error without a body is a server error too and is not followed", async () => {
    const h = harness();
    h.net.statuses["chat:start"] = 500;
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    await expect(h.api.chat.start({ chatId: "c1" })).rejects.toThrow("Request failed (500)");
    h.server.welcome(false);
    expect(chat).toEqual([]);
  });

  test("a done that beats the failed request leaves nothing to wait for", async () => {
    const h = harness();
    h.server.welcome(true);
    h.net.failing.add("chat:start");
    const started = h.api.chat.start({ chatId: "c1" });
    h.server.event("chat:event", { chatId: "c1", type: "done" });
    await started;
    expect(h.isActiveCalls()).toEqual([]);
  });
});

describe("createWebApi robustness", () => {
  test("a throwing subscriber does not stop the others", () => {
    const h = harness();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const second = [];
    h.api.chat.onEvent(() => {
      throw new Error("boom");
    });
    h.api.chat.onEvent((ev) => second.push(ev));
    h.server.event("chat:event", { chatId: "c1", type: "text_delta", text: "hi" });
    expect(second).toEqual([{ chatId: "c1", type: "text_delta", text: "hi" }]);
    expect(logged.mock.calls[0][0]).toBe("[web] event listener failed:");
    logged.mockRestore();
  });

  test("a throwing subscriber cannot break the synthetic stop of the other chats", async () => {
    const h = harness();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const seen = [];
    h.api.chat.onEvent(() => {
      throw new Error("boom");
    });
    h.api.chat.onEvent((ev) => seen.push(ev));
    await h.api.chat.start({ chatId: "c1" });
    await h.api.chat.start({ chatId: "c2" });
    h.server.welcome(false);
    expect(seen).toEqual([...syntheticStop("c1"), ...syntheticStop("c2")]);
    logged.mockRestore();
  });

  test("an event frame with no payload is ignored without throwing", () => {
    const h = harness();
    const seen = [];
    h.api.chat.onEvent((ev) => seen.push(ev));
    expect(() => h.server.event("chat:event", undefined)).not.toThrow();
    expect(() => h.server.event("chat:event", null)).not.toThrow();
    expect(() => h.server.event("chat:event", "text")).not.toThrow();
  });
});

describe("createWebApi pairing", () => {
  test("a 401 tells the user to pair again", async () => {
    const h = harness({ "canvases:list": { ok: false, error: "Unauthorized" } });
    h.net.statuses["canvases:list"] = 401;
    await expect(h.api.canvases.list()).rejects.toThrow(PAIRING_MESSAGE);
  });
});

describe("createWebApi event numbering", () => {
  test("ignores an event it has already processed", () => {
    const h = harness();
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    h.server.eventAt(1, "chat:event", { chatId: "c1", type: "text_delta", text: "a" });
    h.server.eventAt(2, "chat:event", { chatId: "c1", type: "text_delta", text: "b" });
    h.server.eventAt(2, "chat:event", { chatId: "c1", type: "text_delta", text: "b" });
    h.server.eventAt(1, "chat:event", { chatId: "c1", type: "text_delta", text: "a" });
    expect(chat.map((ev) => ev.text)).toEqual(["a", "b"]);
  });

  test("reconnects asking for everything after the last event it processed", () => {
    const h = harness();
    h.server.welcome(false);
    h.server.eventAt(1, "chat:event", { chatId: "c1", type: "start" });
    h.server.eventAt(2, "chat:event", { chatId: "c1", type: "text_delta", text: "hi" });
    h.server.drop();
    h.server.reconnect();
    expect(h.sockets[1].url).toBe("wss://my-mac.tail1234.ts.net/ws?client=client123456&after=2");
  });

  test("a replay after reconnect delivers only the missed events", () => {
    const h = harness();
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    h.server.welcome(false);
    h.server.eventAt(1, "chat:event", { chatId: "c1", type: "text_delta", text: "a" });
    h.server.drop();
    h.server.reconnect();
    h.server.eventAt(1, "chat:event", { chatId: "c1", type: "text_delta", text: "a" });
    h.server.eventAt(2, "chat:event", { chatId: "c1", type: "text_delta", text: "b" });
    h.server.welcome(true);
    expect(chat.map((ev) => ev.text)).toEqual(["a", "b"]);
  });

  test("a tab the Mac no longer knows starts counting again after stopping its chats", async () => {
    const h = harness();
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    await h.api.chat.start({ chatId: "c1" });
    h.server.welcome(true);
    h.server.eventAt(40, "chat:event", { chatId: "c1", type: "text_delta", text: "old" });
    h.server.drop();
    h.server.reconnect();
    expect(h.sockets[1].url).toContain("&after=40");
    h.server.welcome(false);
    h.server.restartNumbering();
    h.server.event("chat:event", { chatId: "c2", type: "text_delta", text: "new" });
    expect(chat).toEqual([
      { chatId: "c1", type: "text_delta", text: "old" },
      ...syntheticStop("c1"),
      { chatId: "c2", type: "text_delta", text: "new" },
    ]);
    h.server.drop();
    h.server.reconnect();
    expect(h.sockets[2].url).toContain("&after=1");
  });

  test("a tab the Mac still knows but can't resume continues from the Mac's count", async () => {
    const h = harness();
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    await h.api.chat.start({ chatId: "c1" });
    h.server.welcome(true);
    h.server.eventAt(3, "chat:event", { chatId: "c1", type: "text_delta", text: "a" });
    h.server.drop();
    h.server.reconnect();
    h.server.welcome(false, 6000);
    expect(chat.slice(1)).toEqual(syntheticStop("c1"));
    h.server.drop();
    h.server.reconnect();
    expect(h.sockets[2].url).toContain("&after=6000");
  });

  test("an event frame without a usable seq is ignored", () => {
    const h = harness();
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    for (const seq of [undefined, 0, -1, 1.5, "3"]) {
      h.sockets[0].onmessage({ data: JSON.stringify({ type: "event", seq, channel: "chat:event", payload: { chatId: "c1" } }) });
    }
    expect(chat).toEqual([]);
  });
});

describe("createWebApi connection watchdog", () => {
  test("closes a socket that has been silent for 45 s and reconnects", () => {
    const h = harness();
    h.server.welcome(true);
    h.timers.advance(WATCHDOG_MS - 1);
    expect(h.sockets[0].closed).toBe(false);
    h.timers.advance(1);
    expect(h.sockets[0].closed).toBe(true);
    expect(h.states[h.states.length - 1]).toBe("reconnecting");
    h.server.reconnect();
    expect(h.sockets).toHaveLength(2);
  });

  test("ticks keep a quiet connection alive", () => {
    const h = harness();
    h.server.welcome(true);
    h.timers.advance(30_000);
    h.server.tick();
    h.timers.advance(30_000);
    h.server.tick();
    h.timers.advance(30_000);
    expect(h.sockets[0].closed).toBe(false);
    h.timers.advance(15_000);
    expect(h.sockets[0].closed).toBe(true);
  });

  test("a socket that never opens is given up on too", () => {
    const h = harness();
    h.timers.advance(WATCHDOG_MS);
    expect(h.sockets[0].closed).toBe(true);
    expect(h.scheduled).toHaveLength(1);
  });

  test("a late close from a socket the watchdog gave up on does not schedule a second reconnect", () => {
    const h = harness();
    h.server.welcome(true);
    const stale = h.sockets[0];
    h.timers.advance(WATCHDOG_MS);
    expect(h.scheduled).toHaveLength(1);
    stale.onclose?.();
    expect(h.scheduled).toHaveLength(1);
  });

  test("a closed connection leaves no watchdog running", () => {
    const h = harness();
    h.server.welcome(true);
    h.server.drop();
    expect(h.timers.pending()).toBe(0);
  });
});

describe("createWebApi leaving the page", () => {
  test("says goodbye when the page is unloaded, so the Mac frees this tab at once", () => {
    const h = harness();
    h.hidePage(false);
    expect(h.fetchCalls).toHaveLength(1);
    const { url, init } = h.fetchCalls[0];
    expect(url).toBe(`${ORIGIN}/api/client%3Abye`);
    expect(init).toEqual({
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-LMC-Client": "client123456" },
      body: '{"args":[]}',
    });
  });

  test("stays registered when the page is only put in the back-forward cache", () => {
    const h = harness();
    h.hidePage(true);
    expect(h.fetchCalls).toEqual([]);
  });

  test("a goodbye that can't be sent is dropped quietly", async () => {
    const h = harness();
    h.net.failing.add("client:bye");
    expect(() => h.hidePage(false)).not.toThrow();
    await flush();
  });
});
