import { randomBytes } from "node:crypto";
import type { Client } from "../api/client";

export type SocketLike = { send(data: string): void; close(): void };

// Sent events are kept so a tab that reconnects can be sent what it missed,
// even events written into a socket that had silently died. Bounded per tab.
export const REPLAY_MAX_EVENTS = 5_000;
export const REPLAY_MAX_BYTES = 8 * 1024 * 1024;

const CLIENT_ID_PREFIX = "browser-";
const EPOCH_BYTES = 9;

/**
 * Where a reconnecting tab left off: the epoch of the client it was last welcomed
 * by (null before its first welcome) and the last event seq it processed (null
 * when unreadable). Seqs only mean something within one epoch.
 */
export type ResumePoint = { epoch: string | null; after: number | null };

const FIRST_CONNECT: ResumePoint = { epoch: null, after: 0 };

/** The tab id a browser client was registered under. */
export const tabIdOf = (client: Pick<Client, "id">): string =>
  client.id.startsWith(CLIENT_ID_PREFIX) ? client.id.slice(CLIENT_ID_PREFIX.length) : client.id;

export type Scheduler = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type BrowserClientRegistry = {
  ensure(clientId: string, deviceId: string): Client;
  /**
   * The tab is resumed, and sent every kept event after `from.after`, only when
   * `from.epoch` is this client's (or the tab has none yet) and the client still
   * has everything the tab is missing. Otherwise the old client is ended and the
   * tab gets a fresh one. `seq` is the last seq sent so far.
   */
  attach(
    clientId: string,
    deviceId: string,
    socket: SocketLike,
    from?: ResumePoint,
  ): { client: Client; resumed: boolean; seq: number; epoch: string };
  detach(clientId: string, socket: SocketLike): void;
  /** Ends a tab's client now (its page was closed or reloaded), skipping the grace period. */
  expire(clientId: string): void;
  expireDevice(deviceId: string): void;
  expireAll(): void;
  get(clientId: string): Client | undefined;
};

type SentEvent = { seq: number; frame: string; bytes: number };

type ClientState = {
  deviceId: string;
  epoch: string;
  socket: SocketLike | null;
  lastSeq: number;
  /** Oldest first; appended in place because every streamed token passes through here. */
  sent: SentEvent[];
  sentBytes: number;
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
  maxReplayEvents?: number;
  maxReplayBytes?: number;
}): BrowserClientRegistry {
  const scheduler = opts.scheduler ?? realScheduler;
  const maxEvents = opts.maxReplayEvents ?? REPLAY_MAX_EVENTS;
  const maxBytes = opts.maxReplayBytes ?? REPLAY_MAX_BYTES;
  const records = new Map<string, ClientRecord>();

  const keep = (state: ClientState, event: SentEvent): void => {
    state.sent.push(event);
    state.sentBytes += event.bytes;
    let drop = 0;
    while (drop < state.sent.length && (state.sent.length - drop > maxEvents || state.sentBytes > maxBytes)) {
      state.sentBytes -= state.sent[drop].bytes;
      drop++;
    }
    if (drop > 0) state.sent.splice(0, drop);
  };

  const oldestKept = (state: ClientState): number => state.sent[0]?.seq ?? state.lastSeq + 1;

  // A tab without an epoch has never been welcomed, and its id is new with its page,
  // so every client under that id was created for it.
  const canResume = (state: ClientState, { epoch, after }: ResumePoint): boolean =>
    (epoch === null || epoch === state.epoch) &&
    after !== null &&
    after <= state.lastSeq &&
    after >= oldestKept(state) - 1;

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
    state.sent = [];
    state.sentBytes = 0;
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
      epoch: randomBytes(EPOCH_BYTES).toString("base64url"),
      socket: null,
      lastSeq: 0,
      sent: [],
      sentBytes: 0,
      timer: undefined,
      gone: false,
      listeners: new Set(),
    };
    const client: Client = {
      id: `${CLIENT_ID_PREFIX}${clientId}`,
      kind: "browser",
      send(channel, payload) {
        if (state.gone) return;
        const seq = state.lastSeq + 1;
        const frame = JSON.stringify({ type: "event", seq, channel, payload });
        state.lastSeq = seq;
        keep(state, { seq, frame, bytes: Buffer.byteLength(frame) });
        state.socket?.send(frame);
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
    attach(clientId, deviceId, socket, from = FIRST_CONNECT) {
      const known = sameDevice(clientId, deviceId);
      const resumed = known !== undefined && canResume(known.state, from);
      // A tab that can't be resumed stops following its chats, so stop them here too
      // (and free its questions and locks) rather than leave them running unseen.
      if (known && !resumed) expire(clientId);
      const record = known && resumed ? known : create(clientId, deviceId);
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
      if (resumed) {
        for (const event of state.sent) {
          if (event.seq > (from.after ?? 0)) socket.send(event.frame);
        }
      }
      return { client: record.client, resumed, seq: state.lastSeq, epoch: state.epoch };
    },
    detach(clientId, socket) {
      const record = records.get(clientId);
      if (!record || record.state.socket !== socket) return;
      record.state.socket = null;
      startGrace(clientId, record.state);
    },
    expire,
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
