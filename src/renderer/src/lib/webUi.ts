import { create } from "zustand";

export type ConnectionState = "connecting" | "connected" | "reconnecting";
export type DirListing = { path: string; parent: string | null; dirs: string[] };

const NOTICE_MS = 3_000;

type WebUiState = {
  connection: ConnectionState;
  notice: string | null;
  setConnection: (connection: ConnectionState) => void;
  showNotice: (message: string) => void;
  clearNotice: () => void;
};

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export const useWebUiStore = create<WebUiState>()((set) => ({
  connection: "connecting",
  notice: null,
  setConnection: (connection) => set({ connection }),
  showNotice: (message) => {
    clearTimeout(noticeTimer);
    set({ notice: message });
    noticeTimer = setTimeout(() => set({ notice: null }), NOTICE_MS);
  },
  clearNotice: () => {
    clearTimeout(noticeTimer);
    set({ notice: null });
  },
}));

type FolderPicker = (defaultPath?: string) => Promise<string | null>;
let folderPicker: FolderPicker | null = null;

export function registerFolderPicker(picker: FolderPicker): () => void {
  folderPicker = picker;
  return () => {
    if (folderPicker === picker) folderPicker = null;
  };
}

export function pickFolderViaUi(defaultPath?: string): Promise<string | null> {
  return folderPicker ? folderPicker(defaultPath) : Promise.resolve(null);
}

export async function copyPathViaUi(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    useWebUiStore.getState().showNotice(`Path copied: ${path}`);
  } catch {
    useWebUiStore.getState().showNotice(path);
  }
}

export function parseDirListing(body: unknown): DirListing | null {
  if (typeof body !== "object" || body === null) return null;
  const { ok, result } = body as { ok?: unknown; result?: unknown };
  if (ok !== true || typeof result !== "object" || result === null) return null;
  const { path, parent, dirs } = result as { path?: unknown; parent?: unknown; dirs?: unknown };
  if (typeof path !== "string") return null;
  if (parent !== null && typeof parent !== "string") return null;
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === "string")) return null;
  return { path, parent, dirs };
}
