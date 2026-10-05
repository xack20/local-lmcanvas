import type { WebContents } from "electron";

export type ClientKind = "desktop" | "browser";

export interface Client {
  readonly id: string;
  readonly kind: ClientKind;
  send(channel: string, payload: unknown): void;
  isGone(): boolean;
  onGone(listener: () => void): () => void;
}

type WebContentsLike = Pick<WebContents, "id" | "send" | "isDestroyed" | "once" | "off">;

const desktopClients = new WeakMap<WebContentsLike, Client>();

export function desktopClient(wc: WebContentsLike): Client {
  const existing = desktopClients.get(wc);
  if (existing) return existing;
  const client: Client = {
    id: `desktop-${wc.id}`,
    kind: "desktop",
    send: (channel, payload) => {
      if (!wc.isDestroyed()) wc.send(channel, payload);
    },
    isGone: () => wc.isDestroyed(),
    onGone: (listener) => {
      wc.once("destroyed", listener);
      return () => {
        if (!wc.isDestroyed()) wc.off("destroyed", listener);
      };
    },
  };
  desktopClients.set(wc, client);
  return client;
}
