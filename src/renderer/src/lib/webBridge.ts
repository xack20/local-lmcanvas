import type { ChatEvent, ChatStartArgs, LmcApi } from "@shared/ipc";
import {
  copyPathViaUi,
  pickFolderViaUi,
  useWebUiStore,
  type ConnectionState,
} from "@/lib/webUi";

export type { ConnectionState } from "@/lib/webUi";

export const isBrowser: boolean = typeof window !== "undefined" && !("api" in window);
export const CONNECTION_LOST_MESSAGE = "Stopped: connection lost";
export const LOGIN_ON_MAC_MESSAGE =
  "To sign in to a provider, open LMCanvas on the Mac and sign in there.";
const DESKTOP_ONLY_MESSAGE = "Manage browser access from the LMCanvas desktop app.";
const UNPAIRED_MESSAGE = "This browser is no longer paired. Open a new pairing link from the Mac.";
const HTTP_UNAUTHORIZED = 401;
// Delay before asking the Mac whether a start that lost its connection is running:
// the request may have reached it without having registered the chat yet.
const START_RECHECK_MS = 3_000;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 10_000;

export type WebSocketLike = {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  close(): void;
};

type FetchLike = (
  url: string,
  init: { method: string; credentials: "same-origin"; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type WebBridgeDeps = {
  fetchFn: FetchLike;
  openSocket: (url: string) => WebSocketLike;
  origin: string;
  clientId: string;
  schedule: (fn: () => void, ms: number) => void;
  ui: {
    pickFolder(defaultPath?: string): Promise<string | null>;
    copyPath(path: string): Promise<void>;
    openUrl(url: string): void;
    notify(message: string): void;
  };
  onConnection: (state: ConnectionState) => void;
};

type ServerMessage =
  | { type: "welcome"; resumed: boolean }
  | { type: "event"; channel: string; payload: unknown };

function parseMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null) return null;
    const message = value as Record<string, unknown>;
    if (message.type === "welcome") return { type: "welcome", resumed: message.resumed === true };
    if (message.type === "event" && typeof message.channel === "string") {
      return { type: "event", channel: message.channel, payload: message.payload };
    }
    return null;
  } catch {
    return null;
  }
}

/** The request got no HTTP response at all (network drop), so the Mac may or may not have run it. */
export class TransportError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Network request failed");
    this.name = "TransportError";
  }
}

function resultOf(body: unknown, status: number): unknown {
  if (status === HTTP_UNAUTHORIZED) throw new Error(UNPAIRED_MESSAGE);
  if (typeof body === "object" && body !== null) {
    const response = body as { ok?: unknown; result?: unknown; error?: unknown };
    if (response.ok === true) return response.result;
    if (typeof response.error === "string") throw new Error(response.error);
  }
  throw new Error(`Request failed (${status})`);
}

const desktopOnly = (): Promise<never> => Promise.reject(new Error(DESKTOP_ONLY_MESSAGE));

const withId = (ids: ReadonlySet<string>, chatId: string): Set<string> => new Set([...ids, chatId]);
const withoutId = (ids: ReadonlySet<string>, chatId: string): Set<string> =>
  new Set([...ids].filter((id) => id !== chatId));

/** The chat id of a `done` chat event, or null for anything else (including a missing payload). */
function doneChatId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { type, chatId } = payload as { type?: unknown; chatId?: unknown };
  return type === "done" && typeof chatId === "string" ? chatId : null;
}

export function createWebApi(deps: WebBridgeDeps): LmcApi {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  // Chats this tab started and has not seen end. `uncertain` is the subset whose
  // chat:start request died in transit, so the Mac may or may not still be running them.
  let following = new Set<string>();
  let uncertain = new Set<string>();
  // True from a welcome frame until the socket closes: the replay queue is drained.
  let connected = false;
  let retryMs = MIN_RETRY_MS;

  const emit = (channel: string, payload: unknown): void => {
    const doneId = channel === "chat:event" ? doneChatId(payload) : null;
    if (doneId !== null) {
      following = withoutId(following, doneId);
      uncertain = withoutId(uncertain, doneId);
    }
    for (const listener of listeners.get(channel) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        console.error("[web] event listener failed:", error);
      }
    }
  };

  const subscribe = <T>(channel: string, handler: (payload: T) => void): (() => void) => {
    const listener = (payload: unknown) => handler(payload as T);
    listeners.set(channel, new Set([...(listeners.get(channel) ?? []), listener]));
    return () => {
      listeners.set(channel, new Set([...(listeners.get(channel) ?? [])].filter((l) => l !== listener)));
    };
  };

  const send = async (channel: string, args: unknown[]) => {
    try {
      return await deps.fetchFn(`${deps.origin}/api/${encodeURIComponent(channel)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-LMC-Client": deps.clientId },
        body: JSON.stringify({ args }),
      });
    } catch (error) {
      throw new TransportError(error);
    }
  };

  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const response = await send(channel, args);
    const body: unknown = await response.json().catch(() => null);
    return resultOf(body, response.status) as T;
  };

  const stopChat = (chatId: string): void => {
    const error: ChatEvent = { chatId, type: "error", message: CONNECTION_LOST_MESSAGE };
    const done: ChatEvent = { chatId, type: "done", isError: true };
    emit("chat:event", error);
    emit("chat:event", done);
  };

  const stopFollowedChats = (): void => {
    for (const chatId of [...following]) stopChat(chatId);
  };

  /** true/false from the Mac, or null when the question itself could not be answered. */
  const queryActive = async (chatId: string): Promise<boolean | null> => {
    try {
      const active = await call<unknown>("chat:isActive", chatId);
      return typeof active === "boolean" ? active : null;
    } catch {
      return null;
    }
  };

  // "Not running" is only believed while connected: a chat that finished while the
  // socket was down has its output waiting in the replay queue, not lost.
  const settleOne = async (chatId: string): Promise<void> => {
    const active = await queryActive(chatId);
    if (active === false && connected && uncertain.has(chatId)) stopChat(chatId);
  };

  const settleUncertain = async (): Promise<void> => {
    if (!connected) return;
    await Promise.all([...uncertain].map(settleOne));
  };

  const waitForDone = (chatId: string): Promise<void> =>
    new Promise((resolve) => {
      const unsubscribe = subscribe<unknown>("chat:event", (payload) => {
        if (doneChatId(payload) !== chatId) return;
        unsubscribe();
        resolve();
      });
    });

  const startChat = async (args: ChatStartArgs): Promise<void> => {
    const { chatId } = args;
    following = withId(following, chatId);
    try {
      await call<void>("chat:start", args);
    } catch (error) {
      if (!(error instanceof TransportError)) {
        following = withoutId(following, chatId);
        throw error;
      }
      if (!following.has(chatId)) return;
      uncertain = withId(uncertain, chatId);
      if (connected) deps.schedule(settleUncertain, START_RECHECK_MS);
      return waitForDone(chatId);
    }
  };

  const onWelcome = (resumed: boolean): void => {
    connected = true;
    deps.onConnection("connected");
    if (resumed) void settleUncertain();
    else stopFollowedChats();
  };

  const connect = (): void => {
    const socket = deps.openSocket(
      `${deps.origin.replace(/^http/, "ws")}/ws?client=${encodeURIComponent(deps.clientId)}`,
    );
    socket.onopen = () => {
      retryMs = MIN_RETRY_MS;
    };
    socket.onmessage = (ev) => {
      const message = parseMessage(ev.data);
      if (!message) return;
      if (message.type === "event") return emit(message.channel, message.payload);
      onWelcome(message.resumed);
    };
    socket.onclose = () => {
      connected = false;
      deps.onConnection("reconnecting");
      deps.schedule(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };
  };

  deps.onConnection("connecting");
  connect();

  return {
    canvases: {
      list: () => call("canvases:list"),
      create: (args) => call("canvases:create", args),
      read: (id) => call("canvases:read", id),
      write: (canvas) => call("canvases:write", canvas),
      delete: (id) => call("canvases:delete", id),
    },
    settings: {
      read: () => call("settings:read"),
      write: (s) => call("settings:write", s),
    },
    chat: {
      start: startChat,
      cancel: (chatId) => call("chat:cancel", chatId),
      cancelForNode: (nodeId) => call("chat:cancelForNode", nodeId),
      onEvent: (handler) => subscribe("chat:event", handler),
    },
    dialog: { pickFolder: (defaultPath) => deps.ui.pickFolder(defaultPath) },
    shell: { openPath: (path) => deps.ui.copyPath(path) },
    processes: {
      start: (args) => call("processes:start", args),
      stop: (id) => call("processes:stop", id),
    },
    files: { list: (cwd) => call("files:list", cwd) },
    slash: { list: (cwd) => call("slash:list", cwd) },
    providers: {
      authStatus: (provider) => call("providers:authStatus", provider),
      openLoginTerminal: async () => {
        deps.ui.notify(LOGIN_ON_MAC_MESSAGE);
      },
      codexRuntime: () => call("providers:codexRuntime"),
    },
    askUser: {
      onRequest: (handler) => subscribe("askUser:request", handler),
      respond: (payload) => call("askUser:respond", payload),
    },
    window: {
      openCanvas: async (canvasId) => {
        deps.ui.openUrl(canvasId ? `${deps.origin}/#/canvas/${canvasId}` : `${deps.origin}/`);
      },
    },
    groupSummary: { generate: (args) => call("groupSummary:generate", args) },
    canvasName: { generate: (args) => call("canvasName:generate", args) },
    canvasLock: {
      acquire: (canvasId) => call("canvasLock:acquire", canvasId),
      takeOver: (canvasId) => call("canvasLock:takeOver", canvasId),
      release: (canvasId) => call("canvasLock:release", canvasId),
      onLost: (handler) => subscribe("canvas:lockLost", handler),
    },
    web: {
      status: desktopOnly,
      setEnabled: desktopOnly,
      setKeepAwake: desktopOnly,
      createPairingLink: desktopOnly,
      removeDevice: desktopOnly,
    },
  };
}

function browserSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  const like: WebSocketLike = { onopen: null, onmessage: null, onclose: null, close: () => ws.close() };
  ws.onopen = () => like.onopen?.();
  ws.onmessage = (ev) => like.onmessage?.({ data: ev.data });
  ws.onclose = () => like.onclose?.();
  return like;
}

export function installWebApiIfNeeded(): void {
  if (!isBrowser) return;
  window.api = createWebApi({
    fetchFn: (url, init) => window.fetch(url, init),
    openSocket: browserSocket,
    origin: window.location.origin,
    clientId: crypto.randomUUID().replace(/-/g, ""),
    schedule: (fn, ms) => {
      window.setTimeout(fn, ms);
    },
    ui: {
      pickFolder: pickFolderViaUi,
      copyPath: copyPathViaUi,
      openUrl: (url) => {
        window.open(url, "_blank", "noopener");
      },
      notify: (message) => useWebUiStore.getState().showNotice(message),
    },
    onConnection: (state) => useWebUiStore.getState().setConnection(state),
  });
}
