// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { createBrowserClientRegistry, tabIdOf } from "./browserClients.ts";

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

const setup = (bounds = {}) => {
  const scheduler = manualScheduler();
  const created = [];
  const registry = createBrowserClientRegistry({ graceMs: 120_000, scheduler, onCreated: (c) => created.push(c), ...bounds });
  return { scheduler, created, registry };
};

const seqs = (socket) => socket.messages.map((m) => m.seq);

describe("createBrowserClientRegistry", () => {
  test("a new tab gets a fresh client whose events reach the socket", () => {
    const { registry, created } = setup();
    const socket = fakeSocket();
    const { client, resumed } = registry.attach("tab1", "dev1", socket);
    expect(resumed).toBe(false);
    expect(client.kind).toBe("browser");
    client.send("chat:event", { chatId: "c1", type: "start" });
    expect(socket.messages).toEqual([{ type: "event", seq: 1, channel: "chat:event", payload: { chatId: "c1", type: "start" } }]);
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
    const again = registry.attach("tab1", "dev1", second, 0);
    expect(again.resumed).toBe(true);
    expect(again.client).toBe(client);
    expect(second.messages.map((m) => m.payload.n)).toEqual([1, 2]);
    expect(seqs(second)).toEqual([1, 2]);
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

describe("createBrowserClientRegistry replay", () => {
  test("events written to a socket the server still thinks is live are replayed after the tab's last seq", () => {
    const { registry } = setup();
    const first = fakeSocket();
    const { client } = registry.attach("tab1", "dev1", first, 0);
    client.send("chat:event", { n: 1 });
    client.send("chat:event", { n: 2 });
    client.send("chat:event", { n: 3 });
    expect(seqs(first)).toEqual([1, 2, 3]);

    const second = fakeSocket();
    const again = registry.attach("tab1", "dev1", second, 1);

    expect(again.resumed).toBe(true);
    expect(again.seq).toBe(3);
    expect(first.closed).toBe(true);
    expect(seqs(second)).toEqual([2, 3]);
    expect(second.messages.map((m) => m.payload.n)).toEqual([2, 3]);
  });

  test("a tab that is fully caught up gets nothing replayed and is resumed", () => {
    const { registry } = setup();
    const { client } = registry.attach("tab1", "dev1", fakeSocket(), 0);
    client.send("chat:event", { n: 1 });
    const second = fakeSocket();
    expect(registry.attach("tab1", "dev1", second, 1).resumed).toBe(true);
    expect(second.messages).toEqual([]);
  });

  // Five events sent while the tab was away, with room for only the newest three.
  const fiveWhileAway = () => {
    const ctx = setup({ maxReplayEvents: 3 });
    const first = fakeSocket();
    const { client } = ctx.registry.attach("tab1", "dev1", first, 0);
    ctx.registry.detach("tab1", first);
    for (let n = 1; n <= 5; n++) client.send("chat:event", { n });
    return { ...ctx, client };
  };

  test("keeps only the newest events by count, and replays them to a tab that needs no more", () => {
    const { registry } = fiveWhileAway();
    const justInTime = fakeSocket();
    expect(registry.attach("tab1", "dev1", justInTime, 2).resumed).toBe(true);
    expect(seqs(justInTime)).toEqual([3, 4, 5]);
  });

  test("a tab that needs a dropped event is not resumed", () => {
    const { registry } = fiveWhileAway();
    const behind = fakeSocket();
    expect(registry.attach("tab1", "dev1", behind, 1)).toMatchObject({ resumed: false, seq: 0 });
    expect(behind.messages).toEqual([]);
  });

  test("keeps only the newest events by size", () => {
    const sized = () => {
      const ctx = setup({ maxReplayBytes: 300 });
      const { client } = ctx.registry.attach("tab1", "dev1", fakeSocket(), 0);
      for (let n = 1; n <= 4; n++) client.send("chat:event", { text: "x".repeat(60) });
      return ctx.registry;
    };
    expect(sized().attach("tab1", "dev1", fakeSocket(), 0).resumed).toBe(false);
    const caughtUp = fakeSocket();
    expect(sized().attach("tab1", "dev1", caughtUp, 2).resumed).toBe(true);
    expect(seqs(caughtUp)).toEqual([3, 4]);
  });

  test("a tab that can't be resumed ends its old client and starts a fresh one", () => {
    const { registry, created, client } = fiveWhileAway();
    let gone = 0;
    client.onGone(() => gone++);

    const behind = fakeSocket();
    const fresh = registry.attach("tab1", "dev1", behind, 1);

    expect(gone).toBe(1);
    expect(client.isGone()).toBe(true);
    expect(fresh.client).not.toBe(client);
    expect(fresh.client.isGone()).toBe(false);
    expect(fresh.seq).toBe(0);
    expect(created).toEqual([client, fresh.client]);
    expect(registry.get("tab1")).toBe(fresh.client);
    fresh.client.send("chat:event", { n: 1 });
    expect(seqs(behind)).toEqual([1]);
  });

  test("a resumable tab keeps its client", () => {
    const { registry, client } = fiveWhileAway();
    expect(registry.attach("tab1", "dev1", fakeSocket(), 2).client).toBe(client);
    expect(client.isGone()).toBe(false);
  });

  test("a tab that saw more than this client ever sent belongs to an expired one and is not resumed", () => {
    const { registry } = setup();
    registry.ensure("tab1", "dev1");
    const socket = fakeSocket();
    expect(registry.attach("tab1", "dev1", socket, 7)).toMatchObject({ resumed: false, seq: 0 });
  });

  test("an unreadable last seq never resumes an existing client", () => {
    const { registry } = setup();
    const first = fakeSocket();
    const { client } = registry.attach("tab1", "dev1", first, 0);
    client.send("chat:event", { n: 1 });
    const second = fakeSocket();
    expect(registry.attach("tab1", "dev1", second, null).resumed).toBe(false);
    expect(second.messages).toEqual([]);
  });

  test("events sent before the first socket attaches reach it", () => {
    const { registry } = setup();
    const client = registry.ensure("tab1", "dev1");
    client.send("chat:event", { n: 1 });
    const socket = fakeSocket();
    expect(registry.attach("tab1", "dev1", socket, 0).resumed).toBe(true);
    expect(seqs(socket)).toEqual([1]);
  });
});

describe("createBrowserClientRegistry expire", () => {
  test("expiring a tab ends its client at once and frees the id", () => {
    const { registry, scheduler } = setup();
    const socket = fakeSocket();
    const { client } = registry.attach("tab1", "dev1", socket, 0);
    let gone = 0;
    client.onGone(() => gone++);

    registry.expire("tab1");

    expect(gone).toBe(1);
    expect(client.isGone()).toBe(true);
    expect(socket.closed).toBe(true);
    expect(registry.get("tab1")).toBeUndefined();
    expect(scheduler.pending()).toBe(0);
    expect(registry.attach("tab1", "dev1", fakeSocket(), 0).resumed).toBe(false);
  });

  test("expiring an unknown tab does nothing", () => {
    const { registry } = setup();
    const { client } = registry.attach("tab1", "dev1", fakeSocket(), 0);
    registry.expire("tab2");
    expect(client.isGone()).toBe(false);
  });

  test("a client's tab id can be read back from it", () => {
    const { registry } = setup();
    expect(tabIdOf(registry.ensure("tab1", "dev1"))).toBe("tab1");
  });
});
