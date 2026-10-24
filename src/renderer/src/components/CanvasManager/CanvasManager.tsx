import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FileUp, PanelLeft, Plus, Settings } from "lucide-react";
import type { Canvas, CanvasSummary } from "@shared/types";
import { nameAfterRename } from "@shared/canvasName";
import { restoreFromUndo } from "@shared/canvasOrganize";
import { useOrganizeRequestStore } from "@/hooks/useOrganizeRequestStore";
import { navigateToCanvas } from "@/lib/canvasNavigation";
import { usePaneRegistry } from "@/hooks/usePaneRegistry";
import { isBrowser } from "@/lib/webBridge";
import { SettingsModal } from "@/components/SettingsModal";
import { useFocusRequestStore } from "@/hooks/useFocusRequestStore";
import { CanvasItem } from "./CanvasItem";
import { CanvasSearch, type CanvasSearchRef } from "./CanvasSearch";
import { DeleteCanvasModal } from "./DeleteCanvasModal";
import { onOpenSettings } from "@/lib/openSettings";

type CanvasManagerProps = {
  /** Canvas id of the currently-open canvas, if any. */
  currentCanvasId?: string | null;
  /** If true, the panel is open by default on mount. */
  defaultOpen?: boolean;
  /** Notified whenever the panel opens or closes. */
  onOpenChange?: (isOpen: boolean) => void;
};

export function CanvasManager({
  currentCanvasId = null,
  defaultOpen = false,
  onOpenChange,
}: CanvasManagerProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);
  useEffect(() => onOpenSettings(() => setShowSettings(true)), []);
  const [isLargeScreen, setIsLargeScreen] = useState(true);
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [deletingCanvasId, setDeletingCanvasId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const searchRef = useRef<CanvasSearchRef>(null);
  const requestFocus = useFocusRequestStore((s) => s.requestFocus);

  const refresh = async () => {
    setIsLoading(true);
    const list = await window.api.canvases.list();
    setCanvases(list);
    setIsLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const onCanvasesChanged = () => {
      void refresh();
    };
    window.addEventListener("lmc:canvases-changed", onCanvasesChanged);
    return () =>
      window.removeEventListener("lmc:canvases-changed", onCanvasesChanged);
  }, []);

  useEffect(() => {
    const check = () => setIsLargeScreen(window.innerWidth >= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const currentCanvas = useMemo(
    () => canvases.find((c) => c.id === currentCanvasId) ?? null,
    [canvases, currentCanvasId],
  );

  const filteredCanvases = useMemo(() => {
    const sorted = [...canvases].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((c) => (c.name ?? "").toLowerCase().includes(q));
  }, [canvases, searchQuery]);

  const isSearching = searchQuery.trim().length > 0;
  const noResults = isSearching && filteredCanvases.length === 0;

  const handleCreate = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const c = await window.api.canvases.create({});
      setIsOpen(false);
      await refresh();
      navigateToCanvas(c.id);
    } finally {
      setIsCreating(false);
    }
  };

  // Picking a chat closes the sidebar so the chat opens at full width.
  const handleSelect = (canvas: CanvasSummary) => {
    searchRef.current?.close();
    setIsOpen(false);
    navigateToCanvas(canvas.id);
  };

  const handleThreadSelect = (canvasId: string, startNodeId: string) => {
    setIsOpen(false);
    if (canvasId !== currentCanvasId) {
      navigateToCanvas(canvasId);
    }
    requestFocus(canvasId, startNodeId);
  };

  // An open canvas holds its own copy and saves it over the file, so changes go through its store.
  // Without the lock it can't save; callers then use the file as they always have.
  const openStoreFor = (id: string) => {
    const open = usePaneRegistry.getState().stores[id];
    return open?.getState().canvasId === id && open.getState().lock === "held" ? open : null;
  };

  const handleExport = async (id: string) => {
    await openStoreFor(id)?.getState().save();
    await window.api.canvases.exportToFile(id);
  };

  // Organize measures nodes on screen, so it runs in the pane once that canvas is showing.
  const handleOrganize = (id: string) => {
    useOrganizeRequestStore.getState().requestOrganize(id);
    if (id !== currentCanvasId) navigateToCanvas(id);
  };

  const handleUndoOrganize = async (id: string) => {
    const open = openStoreFor(id);
    if (open) {
      open.getState().undoOrganize();
    } else {
      const canvas: Canvas | null = await window.api.canvases.read(id);
      if (!canvas?.organized) return;
      await window.api.canvases.write({
        ...canvas,
        nodes: restoreFromUndo(canvas.nodes, canvas.organized),
        organized: undefined,
      });
    }
    void refresh();
  };

  const handleImport = async () => {
    const result = await window.api.canvases.importFromFile();
    if (result.status !== "imported") return;
    setIsOpen(false);
    await refresh();
    navigateToCanvas(result.canvasId);
  };

  const handleRename = async (id: string, newName: string) => {
    const open = openStoreFor(id);
    if (open) {
      open.getState().rename(newName);
      await open.getState().save();
    } else {
      const canvas: Canvas | null = await window.api.canvases.read(id);
      if (!canvas) return;
      await window.api.canvases.write({ ...canvas, ...nameAfterRename(newName, canvas.nodes, canvas.name) });
    }
    void refresh();
  };

  const handleDelete = (id: string, name: string) => {
    setPendingDelete({ id, name });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setPendingDelete(null);
    setDeletingCanvasId(id);
    try {
      await window.api.canvases.delete(id);
      void refresh();
    } finally {
      setDeletingCanvasId(null);
    }
  };

  return (
    <>
      {/* Toggle Button — sits to the right of the macOS traffic lights, vertically centered with them */}
      <motion.button
        onClick={() => setIsOpen((o) => !o)}
        className="fixed cursor-pointer top-[6px] left-[88px] z-50 h-6 w-6 rounded-md flex items-center justify-center text-foreground/70 hover:text-foreground hover:bg-muted no-drag focus:outline-none"
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        title={isOpen ? "Close sidebar" : "Open sidebar"}
      >
        <PanelLeft className="h-4 w-4" />
      </motion.button>

      {/* Side Panel */}
      <AnimatePresence>
        {isOpen && (
          <>
            {!isLargeScreen && (
              <motion.div
                className="fixed inset-0 z-30"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onClick={() => setIsOpen(false)}
              />
            )}
            <motion.div
              className="fixed left-0 top-0 h-screen w-80 border-r border-border shadow-lg z-40 flex flex-col bg-card no-drag"
              initial={{ x: -320 }}
              animate={{ x: 0 }}
              exit={{ x: -320 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
            >
              {/* Header */}
              <div className="flex items-center h-10 justify-between px-4 border-b border-border bg-card app-drag">
                <h2 className="pl-[104px] text-sm font-normal truncate text-foreground no-drag">
                  {currentCanvas?.name}
                </h2>
              </div>

              {/* Create canvas section */}
              <div className="p-2">
                <div className="relative my-2 flex h-11 w-full px-1">
                  <motion.button
                    onClick={() => void handleCreate()}
                    disabled={isCreating}
                    className="flex-1 cursor-pointer h-11 px-3 hover:opacity-90 rounded-md disabled:opacity-50 transition-colors bg-primary text-primary-foreground border-0"
                    title="Create new canvas"
                    whileHover={isCreating ? {} : { scale: 1.01 }}
                    whileTap={isCreating ? {} : { scale: 0.99 }}
                  >
                    <div className="flex justify-center items-center gap-1.5">
                      <div className="rounded-full">
                        <Plus className="h-5 w-5" />
                      </div>
                      <span className="text-md pb-0 font-normal">
                        New canvas
                      </span>
                    </div>
                  </motion.button>
                  {!isBrowser && (
                    <motion.button
                      onClick={() => void handleImport()}
                      className="ml-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-muted"
                      title="Import a canvas file"
                      aria-label="Import a canvas file"
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.99 }}
                    >
                      <FileUp className="h-5 w-5" />
                    </motion.button>
                  )}
                </div>
              </div>

              {/* Canvas list */}
              <div className="flex-1 overflow-y-auto px-3">
                <CanvasSearch
                  ref={searchRef}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                />

                {isLoading ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    loading…
                  </div>
                ) : noResults ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    No chats match &quot;{searchQuery}&quot;
                  </div>
                ) : filteredCanvases.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    No canvases yet. Click <span className="font-medium">New canvas</span> to start.
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {filteredCanvases.map((c) => (
                      <CanvasItem
                        key={c.id}
                        canvas={c}
                        isSelected={c.id === currentCanvasId}
                        isDeleting={deletingCanvasId === c.id}
                        onSelect={() => handleSelect(c)}
                        onRename={(newName) => handleRename(c.id, newName)}
                        onExport={() => void handleExport(c.id)}
                        onOrganize={() => handleOrganize(c.id)}
                        onUndoOrganize={() => void handleUndoOrganize(c.id)}
                        onDelete={() => handleDelete(c.id, c.name)}
                        onThreadSelect={handleThreadSelect}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="p-2 border-t border-border">
                <button
                  onClick={() => setShowSettings(true)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-muted text-sm text-foreground cursor-pointer"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />

      <DeleteCanvasModal
        isOpen={pendingDelete !== null}
        canvasName={pendingDelete?.name ?? ""}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
