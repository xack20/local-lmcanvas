import { create } from "zustand";

export type NodePanelState = {
  open: boolean;
  show: () => void;
  hide: () => void;
};

// The right-side NodePanel opens only on request (a node's "open in side
// panel" button), not on every selection. Not persisted: it starts closed.
export const useNodePanelStore = create<NodePanelState>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
