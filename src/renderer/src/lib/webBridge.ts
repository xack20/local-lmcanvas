import type { ChatEvent, LmcApi } from "@shared/ipc";
import {
  copyPathViaUi,
  pickFolderViaUi,
  useWebUiStore,
  type ConnectionState,
} from "@/lib/webUi";

export const isBrowser: boolean = typeof window !== "undefined" && !("api" in window);
export const CONNECTION_LOST_MESSAGE = "Stopped: connection lost";
export const LOGIN_ON_MAC_MESSAGE =
  "To sign in to a provider, open LMCanvas on the Mac and sign in there.";
const DESKTOP_ONLY_MESSAGE = "Manage browser access from the LMCanvas desktop app.";
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

function resultOf(body: unknown, status: number): unknown {
  if (typeof body === "object" && body !== null) {
    const response = body as { ok?: unknown; result?: unknown; error?: unknown };
    if (response.ok === true) return response.result;
    if (typeof response.error === "string") throw new Error(response.error);
  }
  throw new Error(`Request failed (${status})`);
}

const desktopOnly = (): Promise<never> => Promise.reject(new Error(DESKTOP_ONLY_MESSAGE));

export function createWebApi(deps: WebBridgeDeps): LmcApi {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let following = new Set<string>();
  let retryMs = MIN_RETRY_MS;

  const emit = (channel: string, payload: unknown): void => {
    if (channel === "chat:event") {
      const ev = payload as ChatEvent;
      if (ev.type === "done") following = new Set([...following].filter((id) => id !== ev.chatId));
    }
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };

  const subscribe = <T>(channel: string, handler: (payload: T) => void): (() => void) => {
    const listener = (payload: unknown) => handler(payload as T);
    listeners.set(channel, new Set([...(listeners.get(channel) ?? []), listener]));
    return () => {
      listeners.set(channel, new Set([...(listeners.get(channel) ?? [])].filter((l) => l !== listener)));
    };
  };

  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const response = await deps.fetchFn(`${deps.origin}/api/${encodeURIComponent(channel)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-LMC-Client": deps.clientId },
      body: JSON.stringify({ args }),
    });
    const body: unknown = await response.json().catch(() => null);
    return resultOf(body, response.status) as T;
  };

  const stopFollowedChats = (): void => {
    for (const chatId of [...following]) {
      emit("chat:event", { chatId, type: "error", message: CONNECTION_LOST_MESSAGE });
      emit("chat:event", { chatId, type: "done", isError: true });
    }
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
      deps.onConnection("connected");
      if (!message.resumed) stopFollowedChats();
    };
    socket.onclose = () => {
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
      start: (args) => {
        following = new Set([...following, args.chatId]);
        return call("chat:start", args);
      },
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
