import { useState } from "react";
import type { NodeId } from "@shared/types";
import { MAX_COMPACT_FOCUS_CHARS } from "@shared/contextSize";
import { canCompact, type CompactMode } from "@/lib/compactNode";
import { useCanvasStore } from "@/hooks/useCanvasStore";
import { useCompactActions } from "@/hooks/useCompactActions";

type Props = { nodeId: NodeId; onStart: () => void };

/** The context panel's compaction controls. Progress and failures also show on the node itself. */
export function CompactActions({ nodeId, onStart }: Props) {
  const compact = useCompactActions();
  const available = useCanvasStore((s) => canCompact(s, nodeId));
  const compacting = useCanvasStore((s) => s.compactingNodeIds[nodeId] === true);
  const error = useCanvasStore((s) => s.compactErrors[nodeId]);
  const [focus, setFocus] = useState("");

  const start = (mode: CompactMode): void => {
    void compact(nodeId, mode, focus.trim() || undefined);
    onStart();
  };

  return (
    <div className="mt-2 border-t border-border pt-2">
      <input
        type="text"
        value={focus}
        maxLength={MAX_COMPACT_FOCUS_CHARS}
        onChange={(e) => setFocus(e.target.value)}
        placeholder="Focus (optional), e.g. keep the API decisions"
        aria-label="Compaction focus"
        className="nodrag w-full rounded-md border border-border bg-background px-2 py-1 text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent/50"
      />
      <div className="mt-1.5 flex gap-1.5">
        <ActionButton label="Compact this node" disabled={!available} onClick={() => start("inPlace")} />
        <ActionButton label="Continue from summary" disabled={!available} onClick={() => start("summaryNode")} />
      </div>
      {compacting && <p className="mt-1 text-[9px] text-muted-foreground">Compacting…</p>}
      {error && <p className="mt-1 text-[9px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function ActionButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex-1 cursor-pointer rounded-md border border-border px-1.5 py-1 text-[10px] text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}
