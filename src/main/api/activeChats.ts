import type { Client } from "./client";

export type ActiveChat = { controller: AbortController; nodeId: string; client: Client };

export type ActiveChats = {
  add(chatId: string, chat: ActiveChat): void;
  finish(chatId: string): void;
  abort(chatId: string): void;
  abortForNode(nodeId: string): void;
  abortForClient(client: Client): void;
  has(chatId: string): boolean;
};

export function createActiveChats(): ActiveChats {
  const chats = new Map<string, ActiveChat>();

  const abortWhere = (matches: (chat: ActiveChat) => boolean): void => {
    for (const [chatId, chat] of [...chats]) {
      if (!matches(chat)) continue;
      chat.controller.abort();
      chats.delete(chatId);
    }
  };

  return {
    add: (chatId, chat) => {
      chats.set(chatId, chat);
    },
    finish: (chatId) => {
      chats.delete(chatId);
    },
    abort: (chatId) => {
      chats.get(chatId)?.controller.abort();
      chats.delete(chatId);
    },
    abortForNode: (nodeId) => abortWhere((chat) => chat.nodeId === nodeId),
    abortForClient: (client) => abortWhere((chat) => chat.client === client),
    has: (chatId) => chats.has(chatId),
  };
}
