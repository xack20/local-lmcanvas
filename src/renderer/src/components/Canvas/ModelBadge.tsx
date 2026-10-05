import { useMemo } from "react";
import { Brain, Check, ChevronDown } from "lucide-react";
import clsx from "clsx";
import type { CanvasNode, NodeId } from "@shared/types";
import { findClaudeModel } from "@shared/claudeModels";
import { nodeModelPatch } from "@/lib/claudeModelChoice";
import { useProviderInfo } from "@/hooks/useProviderInfo";
import { useClaudeModelList, useRefreshClaudeModelsOnMount } from "@/hooks/useClaudeModels";
import { useCanvasStore } from "@/hooks/useCanvasStore";
import { claudeModelBadgeLabel } from "@/lib/modelLabel";
import { ProviderLogo } from "./ProviderLogo";
import { BadgePopover } from "./BadgePopover";

type Props = { nodeId: NodeId; popoverSide?: "top" | "bottom" };
type ClaudeUsageTotals = {
  turns: number;
  totalTokens: number;
  totalCostUsd: number;
  hasTokenData: boolean;
  hasCostData: boolean;
};

/** The node's Claude model: Settings' model by default, or any model the installed Claude Code offers. */
export function ModelBadge({ nodeId, popoverSide }: Props) {
  const effectiveProvider = useCanvasStore((s) => s.getEffectiveProvider(nodeId));
  const nodeModel = useCanvasStore((s) => s.nodes[nodeId]?.data.nodeSettings?.model);
  const storedEffort = useCanvasStore((s) => s.nodes[nodeId]?.data.nodeSettings?.reasoningEffort);
  const nodes = useCanvasStore((s) => s.nodes);
  const setNodeSettings = useCanvasStore((s) => s.setNodeSettings);
  const { label: providerLabel, claudeModelId } = useProviderInfo(effectiveProvider);
  const modelList = useClaudeModelList();
  const models = modelList?.models ?? null;
  const list = models ?? [];
  const usage = useMemo(() => aggregateClaudeUsage(nodes), [nodes]);

  const isClaude = effectiveProvider === "claude";
  const overridden = isClaude && nodeModel !== undefined;
  const label = isClaude ? claudeModelBadgeLabel(list, nodeModel ?? claudeModelId) : providerLabel;
  const settingsLabel = claudeModelBadgeLabel(list, claudeModelId);
  // Only a live list can say a model is gone; Claude Code's aliases don't list pinned ids.
  const retired =
    overridden && modelList?.live === true && findClaudeModel(list, nodeModel) === undefined;
  const activeValue = !isClaude || nodeModel === undefined
    ? undefined
    : (findClaudeModel(list, nodeModel)?.value ?? nodeModel);

  const choose = (model: string | undefined): void => {
    setNodeSettings(
      nodeId,
      nodeModelPatch({ models: list, model, settingsModel: claudeModelId, isClaude, storedEffort }),
    );
  };

  return (
    <BadgePopover
      side={popoverSide}
      title={`Model: ${label}${retired ? " (no longer offered by Claude Code)" : overridden ? " (node override)" : " (Settings)"} · click to change`}
      overridden={overridden}
      ariaHasPopup="listbox"
      panelClassName="w-[264px]"
      label={
        <>
          <ProviderLogo provider={effectiveProvider} size={10} />
          <span className="tracking-tight text-[8px]">{label}</span>
          {isClaude && <Brain className="w-[10px] h-[10px] text-amber-500 opacity-90" />}
          <ChevronDown className="w-[8px] h-[8px] text-muted-foreground" />
        </>
      }
    >
      {({ close }) => (
        // `nowheel` lets the list scroll instead of the canvas panning under it.
        <div role="listbox" aria-label="Claude model" className="nowheel max-h-[340px] overflow-y-auto pb-1">
          <div
            className="px-2.5 pt-2 pb-1 text-[8px] uppercase tracking-[0.14em] text-muted-foreground"
            style={{ fontFamily: "var(--font-geist-mono)" }}
          >
            Node model
          </div>
          <RefreshOnOpen />
          {retired && (
            <ModelOption
              active
              title={label}
              subtitle="No longer offered by Claude Code · pick another model"
              onSelect={close}
            />
          )}
          <ModelOption
            active={isClaude && nodeModel === undefined}
            title="Settings model"
            subtitle={`${settingsLabel} · follows Settings → Claude`}
            onSelect={() => {
              choose(undefined);
              close();
            }}
          />
          {models === null && (
            <p className="px-2.5 py-1.5 text-[10px] text-muted-foreground">Loading Claude Code models…</p>
          )}
          {list.map((model) => (
            <ModelOption
              key={model.value}
              active={activeValue === model.value}
              title={model.displayName}
              subtitle={model.description}
              onSelect={() => {
                choose(model.value);
                close();
              }}
            />
          ))}
          <div className="mt-1 border-t border-border px-2.5 pt-1.5 text-[9px] text-muted-foreground">
            This canvas: {formatUsage(usage)}
          </div>
        </div>
      )}
    </BadgePopover>
  );
}

/** Mounted only while the picker is open: asks for the latest list right away. */
function RefreshOnOpen(): null {
  useRefreshClaudeModelsOnMount();
  return null;
}

type ModelOptionProps = { active: boolean; title: string; subtitle: string; onSelect: () => void };

function ModelOption({ active, title, subtitle, onSelect }: ModelOptionProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={clsx(
        "w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors cursor-pointer",
        active ? "bg-accent/15 text-foreground" : "text-foreground hover:bg-muted",
      )}
    >
      <ProviderLogo provider="claude" size={12} />
      <span className="flex-1 min-w-0">
        <span className="block truncate">{title}</span>
        {subtitle && <span className="block truncate text-[9px] text-muted-foreground">{subtitle}</span>}
      </span>
      {active && <Check className="h-3 w-3 text-foreground/70" />}
    </button>
  );
}

function aggregateClaudeUsage(nodes: Record<string, CanvasNode>): ClaudeUsageTotals {
  return Object.values(nodes)
    .flatMap((node) => node.data.chat.messages)
    .filter((message) => message.role === "assistant" && message.provider === "claude")
    .reduce<ClaudeUsageTotals>(
      (totals, message) => ({
        turns: totals.turns + 1,
        totalTokens: totals.totalTokens + (message.usage?.totalTokens ?? 0),
        totalCostUsd: totals.totalCostUsd + (message.usage?.totalCostUsd ?? 0),
        hasTokenData: totals.hasTokenData || message.usage?.totalTokens !== undefined,
        hasCostData: totals.hasCostData || message.usage?.totalCostUsd !== undefined,
      }),
      { turns: 0, totalTokens: 0, totalCostUsd: 0, hasTokenData: false, hasCostData: false },
    );
}

function formatUsage(usage: ClaudeUsageTotals): string {
  const parts: string[] = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`];
  if (usage.hasTokenData) parts.push(`${formatNumber(usage.totalTokens)} tok`);
  if (usage.hasCostData) parts.push(`$${usage.totalCostUsd.toFixed(4)}`);
  return parts.join(" · ");
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}
