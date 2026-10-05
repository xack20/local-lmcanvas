import type { Client } from "../api/client";

export type SocketLike = { send(data: string): void; close(): void };

export type Scheduler = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type BrowserClientRegistry = {
  ensure(clientId: string, deviceId: string): Client;
  attach(clientId: string, deviceId: string, socket: SocketLike): { client: Client; resumed: boolean };
  detach(clientId: string, socket: SocketLike): void;
  expireDevice(deviceId: string): void;
  expireAll(): void;
  get(clientId: string): Client | undefined;
};

type ClientState = {
  deviceId: string;
  socket: SocketLike | null;
  queue: string[];
  timer: unknown;
  gone: boolean;
  listeners: Set<() => void>;
};

type ClientRecord = { client: Client; state: ClientState };

const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createBrowserClientRegistry(opts: {
  graceMs: number;
  scheduler?: Scheduler;
  onCreated?: (client: Client) => void;
}): BrowserClientRegistry {
  const scheduler = opts.scheduler ?? realScheduler;
  const records = new Map<string, ClientRecord>();

  const expire = (clientId: string): void => {
    const record = records.get(clientId);
    if (!record) return;
    records.delete(clientId);
    const { state } = record;
    scheduler.clearTimeout(state.timer);
    state.gone = true;
    try {
      state.socket?.close();
    } catch (error) {
      console.error("[web] browser client cleanup failed:", error);
    }
    state.socket = null;
    state.queue = [];
    for (const listener of [...state.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[web] browser client cleanup failed:", error);
      }
    }
  };

  const startGrace = (clientId: string, state: ClientState): void => {
    scheduler.clearTimeout(state.timer);
    state.timer = scheduler.setTimeout(() => expire(clientId), opts.graceMs);
  };

  const create = (clientId: string, deviceId: string): ClientRecord => {
    const state: ClientState = {
      deviceId,
      socket: null,
      queue: [],
      timer: undefined,
      gone: false,
      listeners: new Set(),
    };
    const client: Client = {
      id: `browser-${clientId}`,
      kind: "browser",
      send(channel, payload) {
        if (state.gone) return;
        const message = JSON.stringify({ type: "event", channel, payload });
        if (state.socket) state.socket.send(message);
        else state.queue = [...state.queue, message];
      },
      isGone: () => state.gone,
      onGone(listener) {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
    };
    const record = { client, state };
    records.set(clientId, record);
    opts.onCreated?.(client);
    return record;
  };

  const sameDevice = (clientId: string, deviceId: string): ClientRecord | undefined => {
    const existing = records.get(clientId);
    if (!existing) return undefined;
    if (existing.state.deviceId === deviceId) return existing;
    expire(clientId);
    return undefined;
  };

  return {
    ensure(clientId, deviceId) {
      const existing = sameDevice(clientId, deviceId);
      if (existing) return existing.client;
      const record = create(clientId, deviceId);
      startGrace(clientId, record.state);
      return record.client;
    },
    attach(clientId, deviceId, socket) {
      const existing = sameDevice(clientId, deviceId);
      const resumed = existing !== undefined;
      const record = existing ?? create(clientId, deviceId);
      const { state } = record;
      scheduler.clearTimeout(state.timer);
      state.timer = undefined;
      const oldSocket = state.socket;
      state.socket = socket;
      if (oldSocket && oldSocket !== socket) {
        try {
          oldSocket.close();
        } catch (error) {
          console.error("[web] browser client cleanup failed:", error);
        }
      }
      const pending = state.queue;
      state.queue = [];
      for (const message of pending) socket.send(message);
      return { client: record.client, resumed };
    },
    detach(clientId, socket) {
      const record = records.get(clientId);
      if (!record || record.state.socket !== socket) return;
      record.state.socket = null;
      startGrace(clientId, record.state);
    },
    expireDevice(deviceId) {
      for (const [clientId, record] of [...records]) {
        if (record.state.deviceId === deviceId) expire(clientId);
      }
    },
    expireAll() {
      for (const clientId of [...records.keys()]) expire(clientId);
    },
    get: (clientId) => records.get(clientId)?.client,
  };
}
