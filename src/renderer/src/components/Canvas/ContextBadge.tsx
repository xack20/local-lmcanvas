import { useMemo, type ReactNode } from "react";
import clsx from "clsx";
import type { NodeId } from "@shared/types";
import { contextLabel, contextView, formatTokens, type ContextView } from "@shared/contextSize";
import { useCanvasStore } from "@/hooks/useCanvasStore";
import { BadgePopover } from "./BadgePopover";

type Props = { nodeId: NodeId; popoverSide?: "top" | "bottom"; actions?: (close: () => void) => ReactNode };

const LEVEL_CLASS: Record<ContextView["level"], string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  full: "text-red-600 dark:text-red-400",
};

/** Own and root→here context size for a Claude node; click for details and compaction. */
export function ContextBadge({ nodeId, popoverSide, actions }: Props) {
  const provider = useCanvasStore((s) => s.getEffectiveProvider(nodeId));
  const nodes = useCanvasStore((s) => s.nodes);
  // Other providers' nodes skip the sizing work entirely.
  const view = useMemo(() => (provider === "claude" ? contextView(nodeId, nodes) : null), [provider, nodeId, nodes]);
  if (!view) return null;

  return (
    <BadgePopover
      side={popoverSide}
      title={`Context: ${contextLabel(view)} of ${formatTokens(view.window)} · click for details`}
      ariaHasPopup="dialog"
      panelClassName="w-[248px]"
      label={
        <>
          <Pie percent={view.percent} level={view.level} />
          <span className={clsx("text-[8px] tracking-tight", LEVEL_CLASS[view.level])}>{contextLabel(view)}</span>
        </>
      }
    >
      {({ close }) => (
        <div className="p-2.5 text-[10px] text-foreground" style={{ fontFamily: "var(--font-geist-sans)" }}>
          <Row label="This node" value={`${view.exact ? "" : "~"}${formatTokens(view.own)}`} />
          {!view.isRoot && <Row label="Root → here" value={`${view.exact ? "" : "~"}${formatTokens(view.combined)}`} />}
          <Row label="Window" value={`${formatTokens(view.window)} · ${Math.round(view.percent * 100)}%`} />
          {view.autoCompactAt !== undefined && (
            <Row label="Auto-compact" value={`${view.autoCompactEnabled ? "at" : "off ·"} ${formatTokens(view.autoCompactAt)}`} />
          )}
          {view.breakdown && (
            <Row
              label="Breakdown"
              value={`setup ${formatTokens(view.breakdown.setup)} · chat ${formatTokens(view.breakdown.conversation)} · tools ${formatTokens(view.breakdown.toolResults)}`}
            />
          )}
          {view.compactions > 0 && <Row label="Compactions" value={`${view.compactions} on this path`} />}
          {view.isRoot && (
            <p className="mt-1 text-[9px] text-muted-foreground">Includes Claude Code's setup (system prompt, tools, CLAUDE.md).</p>
          )}
          {!view.exact && <p className="mt-1 text-[9px] text-muted-foreground">Estimated; the next run measures it exactly.</p>}
          {actions?.(close)}
        </div>
      )}
    </BadgePopover>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function Pie({ percent, level }: { percent: number; level: ContextView["level"] }) {
  const clamped = Math.min(1, Math.max(0, percent));
  return (
    <span
      aria-hidden
      className={clsx("inline-block h-[9px] w-[9px] rounded-full border border-current", LEVEL_CLASS[level])}
      style={{ background: `conic-gradient(currentColor ${clamped * 360}deg, transparent 0deg)` }}
    />
  );
}
