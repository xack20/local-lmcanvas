import { create } from "zustand";

/** Organize needs the canvas on screen to measure its nodes, so the canvas list asks for it here
 *  and the pane showing that canvas runs it once loaded. */
export type OrganizeRequest = {
  canvasId: string;
  /** Monotonic counter so asking again for the same canvas re-triggers. */
  requestedAt: number;
};

type OrganizeRequestState = {
  request: OrganizeRequest | null;
  requestOrganize: (canvasId: string) => void;
  /** Called by a pane after it has taken the request. */
  consume: (canvasId: string, requestedAt: number) => void;
};

export const useOrganizeRequestStore = create<OrganizeRequestState>((set) => ({
  request: null,
  requestOrganize: (canvasId) => set({ request: { canvasId, requestedAt: Date.now() } }),
  consume: (canvasId, requestedAt) =>
    set((s) =>
      s.request?.canvasId === canvasId && s.request.requestedAt === requestedAt ? { request: null } : s,
    ),
}));
