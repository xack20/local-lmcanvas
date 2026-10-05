import type { IpcMain, WebContents } from "electron";
import type { Client } from "./client";

export type ApiHandler = (client: Client, ...args: never[]) => unknown;
export type ApiScope = "shared" | "desktop-only";
export type ApiErrorCode = "unknown-channel" | "forbidden";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiRegistry = {
  handle(channel: string, handler: ApiHandler, scope?: ApiScope): void;
  invoke(channel: string, client: Client, args: readonly unknown[]): Promise<unknown>;
  channels(): string[];
};

type CallableHandler = (client: Client, ...args: readonly unknown[]) => unknown;

export function createApiRegistry(): ApiRegistry {
  const entries = new Map<string, { handler: ApiHandler; scope: ApiScope }>();
  return {
    handle(channel, handler, scope = "shared") {
      if (entries.has(channel)) throw new Error(`Duplicate API channel: ${channel}`);
      entries.set(channel, { handler, scope });
    },
    async invoke(channel, client, args) {
      const entry = entries.get(channel);
      if (!entry) throw new ApiError("unknown-channel", `Unknown channel: ${channel}`);
      if (entry.scope === "desktop-only" && client.kind !== "desktop") {
        throw new ApiError("forbidden", `Only available in the desktop app: ${channel}`);
      }
      return (entry.handler as CallableHandler)(client, ...args);
    },
    channels: () => [...entries.keys()],
  };
}

export function bindRegistryToIpc(
  registry: ApiRegistry,
  ipc: Pick<IpcMain, "handle">,
  toClient: (sender: WebContents) => Client,
): void {
  for (const channel of registry.channels()) {
    ipc.handle(channel, (event, ...args: unknown[]) =>
      registry.invoke(channel, toClient(event.sender), args),
    );
  }
}
