// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCanvasStoreApi, makeBlankNode } from "../hooks/useCanvasStore.ts";
import { SAVE_RETRY_MS, saveErrorText, startSaveScheduler } from "./saveRetry.ts";

const DELAY_MS = 1200;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at > now || !pending.has(id)) continue;
        pending.delete(id);
        timer.fn();
      }
      await flush();
    },
    pending: () => pending.size,
  };
}

function stubApi() {
  const net = { failing: false };
  const writes = [];
  const node = makeBlankNode({ x: 0, y: 0 });
  const canvas = { id: "canvas-1", name: "Notes", createdAt: 1, updatedAt: 1, nodes: [node], edges: [] };
  globalThis.window = {
    api: {
      canvases: {
        read: async () => canvas,
        write: async (c) => {
          if (net.failing) throw new TypeError("Failed to fetch");
          writes.push(c);
        },
      },
      settings: { read: async () => ({}) },
      canvasLock: { acquire: async () => ({ ok: true }), release: async () => {}, takeOver: async () => {} },
    },
    dispatchEvent: () => true,
  };
  return { net, writes };
}

describe("startSaveScheduler", () => {
  let store;
  let timers;
  let reconnected;
  let stop;

  beforeEach(() => {
    store = createCanvasStoreApi();
    timers = fakeTimers();
    reconnected = null;
  });
  afterEach(() => {
    stop?.();
    store.getState().releaseLock();
  });

  const start = () => {
    stop = startSaveScheduler(store, {
      delayMs: DELAY_MS,
      timers,
      onReconnect: (listener) => {
        reconnected = listener;
        return () => (reconnected = null);
      },
    });
  };

  test("saves once changes go quiet", async () => {
    const { writes } = stubApi();
    await store.getState().loadCanvas("canvas-1");
    start();
    store.getState().setName("One");
    await timers.advance(DELAY_MS - 1);
    expect(writes).toEqual([]);
    await timers.advance(1);
    expect(writes.map((c) => c.name)).toEqual(["One"]);
  });

  test("keeps retrying a failed save until it goes through", async () => {
    const { net, writes } = stubApi();
    await store.getState().loadCanvas("canvas-1");
    start();
    net.failing = true;
    store.getState().setName("One");
    await timers.advance(DELAY_MS);
    expect(store.getState().saveError).toBe("Failed to fetch");
    await timers.advance(SAVE_RETRY_MS);
    expect(store.getState().saveError).toBe("Failed to fetch");
    net.failing = false;
    await timers.advance(2 * SAVE_RETRY_MS);
    expect(writes.map((c) => c.name)).toEqual(["One"]);
    expect(store.getState().saveError).toBeNull();
  });

  test("retries an unsaved change as soon as the connection comes back", async () => {
    const { net, writes } = stubApi();
    await store.getState().loadCanvas("canvas-1");
    start();
    net.failing = true;
    store.getState().setName("One");
    await timers.advance(DELAY_MS);
    net.failing = false;

    reconnected();
    await timers.advance(0);

    expect(writes.map((c) => c.name)).toEqual(["One"]);
    expect(store.getState().saveError).toBeNull();
  });

  test("stops retrying once the lock is lost", async () => {
    const { net } = stubApi();
    await store.getState().loadCanvas("canvas-1");
    start();
    net.failing = true;
    store.getState().setName("One");
    await timers.advance(DELAY_MS);
    expect(timers.pending()).toBe(1);

    store.getState().markLockLost("canvas-1");
    await timers.advance(SAVE_RETRY_MS);

    expect(timers.pending()).toBe(0);
  });

  test("a reconnect while the lock isn't held schedules nothing", async () => {
    const { net } = stubApi();
    await store.getState().loadCanvas("canvas-1");
    start();
    net.failing = true;
    store.getState().setName("One");
    await timers.advance(DELAY_MS);
    store.getState().markLockLost("canvas-1");
    await timers.advance(SAVE_RETRY_MS);

    reconnected();

    expect(timers.pending()).toBe(0);
  });

  test("a reconnect with nothing unsaved saves nothing", async () => {
    const { writes } = stubApi();
    await store.getState().loadCanvas("canvas-1");
    start();
    reconnected();
    await timers.advance(0);
    expect(writes).toEqual([]);
  });

  test("stopping cancels pending saves and retries", async () => {
    const { writes } = stubApi();
    await store.getState().loadCanvas("canvas-1");
    start();
    store.getState().setName("One");
    stop();
    stop = null;
    await timers.advance(DELAY_MS);
    expect(writes).toEqual([]);
    expect(timers.pending()).toBe(0);
    expect(reconnected).toBeNull();
  });
});

describe("saveErrorText", () => {
  test("says the save failed and is being retried", () => {
    expect(saveErrorText("Failed to fetch")).toBe("Couldn't save: Failed to fetch. Retrying…");
    expect(saveErrorText("This browser is no longer paired.")).toBe("Couldn't save: This browser is no longer paired. Retrying…");
  });
});
