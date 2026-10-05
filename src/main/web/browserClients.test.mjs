// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { createBrowserClientRegistry } from "./browserClients.ts";

function manualScheduler() {
  let next = 1;
  const timers = new Map();
  return {
    setTimeout(fn) {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fireAll() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    pending: () => timers.size,
  };
}

function fakeSocket() {
  const socket = { messages: [], closed: false, send: (m) => socket.messages.push(JSON.parse(m)), close: () => { socket.closed = true; } };
  return socket;
}

const setup = () => {
  const scheduler = manualScheduler();
  const created = [];
  const registry = createBrowserClientRegistry({ graceMs: 120_000, scheduler, onCreated: (c) => created.push(c) });
  return { scheduler, created, registry };
};

describe("createBrowserClientRegistry", () => {
  test("a new tab gets a fresh client whose events reach the socket", () => {
    const { registry, created } = setup();
    const socket = fakeSocket();
    const { client, resumed } = registry.attach("tab1", "dev1", socket);
    expect(resumed).toBe(false);
    expect(client.kind).toBe("browser");
    client.send("chat:event", { chatId: "c1", type: "start" });
    expect(socket.messages).toEqual([{ type: "event", channel: "chat:event", payload: { chatId: "c1", type: "start" } }]);
    expect(created).toEqual([client]);
  });

  test("events during a dropped connection are replayed in order on reconnect", () => {
    const { registry } = setup();
    const first = fakeSocket();
    const { client } = registry.attach("tab1", "dev1", first);
    registry.detach("tab1", first);
    client.send("chat:event", { n: 1 });
    client.send("chat:event", { n: 2 });
    const second = fakeSocket();
    const again = registry.attach("tab1", "dev1", second);
    expect(again.resumed).toBe(true);
    expect(again.client).toBe(client);
    expect(second.messages.map((m) => m.payload.n)).toEqual([1, 2]);
  });

  test("a tab that never comes back is gone after the grace period", () => {
    const { registry, scheduler } = setup();
    const socket = fakeSocket();
    const { client } = registry.attach("tab1", "dev1", socket);
    let gone = 0;
    client.onGone(() => gone++);
    registry.detach("tab1", socket);
    scheduler.fireAll();
    expect(gone).toBe(1);
    expect(client.isGone()).toBe(true);
    expect(registry.get("tab1")).toBeUndefined();
    expect(registry.attach("tab1", "dev1", fakeSocket()).resumed).toBe(false);
  });

  test("a stale close from an old socket does not detach the new one", () => {
    const { registry, scheduler } = setup();
    const old = fakeSocket();
    registry.attach("tab1", "dev1", old);
    const fresh = fakeSocket();
    registry.attach("tab1", "dev1", fresh);
    expect(old.closed).toBe(true);
    registry.detach("tab1", old);
    expect(scheduler.pending()).toBe(0);
  });

  test("the same tab id from a different device starts over", () => {
    const { registry } = setup();
    const { client } = registry.attach("tab1", "dev1", fakeSocket());
    const other = registry.attach("tab1", "dev2", fakeSocket());
    expect(other.resumed).toBe(false);
    expect(client.isGone()).toBe(true);
  });

  test("removing a device closes its sockets and ends its clients", () => {
    const { registry } = setup();
    const socket = fakeSocket();
    const { client } = registry.attach("tab1", "dev1", socket);
    const keep = registry.attach("tab2", "dev2", fakeSocket()).client;
    registry.expireDevice("dev1");
    expect(socket.closed).toBe(true);
    expect(client.isGone()).toBe(true);
    expect(keep.isGone()).toBe(false);
  });

  test("ensure creates a detached client that expires if no socket ever attaches", () => {
    const { registry, scheduler } = setup();
    const client = registry.ensure("tab9", "dev1");
    expect(registry.ensure("tab9", "dev1")).toBe(client);
    scheduler.fireAll();
    expect(client.isGone()).toBe(true);
  });

  test("expireAll ends every client", () => {
    const { registry } = setup();
    const a = registry.attach("a1", "dev1", fakeSocket()).client;
    const b = registry.ensure("b1", "dev2");
    registry.expireAll();
    expect(a.isGone() && b.isGone()).toBe(true);
  });

  test("a throwing cleanup step does not skip the others", () => {
    const { registry } = setup();
    let errorLogged = false;
    const oldError = console.error;
    console.error = () => { errorLogged = true; };
    try {
      const socketA = { messages: [], closed: false, send: () => {}, close: () => { throw new Error("close failed"); } };
      const { client: clientA } = registry.attach("tab1", "dev1", socketA);
      let listenerACount = 0;
      let listenerBCount = 0;
      clientA.onGone(() => {
        listenerACount++;
        throw new Error("listener failed");
      });
      clientA.onGone(() => {
        listenerACount++;
      });
      const socketB = fakeSocket();
      const { client: clientB } = registry.attach("tab2", "dev1", socketB);
      clientB.onGone(() => {
        listenerBCount++;
      });
      registry.expireDevice("dev1");
      expect(errorLogged).toBe(true);
      expect(listenerACount).toBe(2);
      expect(listenerBCount).toBe(1);
      expect(clientA.isGone()).toBe(true);
      expect(clientB.isGone()).toBe(true);
    } finally {
      console.error = oldError;
    }
  });

  test("re-attaching while the old socket's close detaches does not leave a grace timer", () => {
    const { registry, scheduler } = setup();
    const first = {
      messages: [],
      closed: false,
      send: () => {},
      close() {
        this.closed = true;
        registry.detach("tab1", this);
      }
    };
    const { client } = registry.attach("tab1", "dev1", first);
    const second = fakeSocket();
    registry.attach("tab1", "dev1", second);
    expect(scheduler.pending()).toBe(0);
    scheduler.fireAll();
    expect(client.isGone()).toBe(false);
  });
});
