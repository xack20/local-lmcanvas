import { ChevronDown, Gauge } from "lucide-react";
import clsx from "clsx";
import { isClaudeEffort, type ClaudeEffort, type NodeId } from "@shared/types";
import { effortsForClaudeModel } from "@shared/claudeModels";
import { useCanvasStore } from "@/hooks/useCanvasStore";
import { useClaudeModels } from "@/hooks/useClaudeModels";
import { useProviderInfo } from "@/hooks/useProviderInfo";
import { LABEL_BY_EFFORT, SHORT_LABEL_BY_EFFORT } from "@/lib/effortLabels";
import { BadgePopover } from "./BadgePopover";

type Props = { nodeId: NodeId; popoverSide?: "top" | "bottom" };

function effortLabel(effort: ClaudeEffort | undefined, short: boolean): string {
  if (effort === undefined) return "default";
  return short ? SHORT_LABEL_BY_EFFORT[effort] : LABEL_BY_EFFORT[effort];
}

export function ClaudeEffortBadge({ nodeId, popoverSide }: Props) {
  const provider = useCanvasStore((s) => s.getEffectiveProvider(nodeId));
  const storedEffort = useCanvasStore(
    (s) => s.nodes[nodeId]?.data.nodeSettings?.reasoningEffort,
  );
  const nodeModel = useCanvasStore((s) => s.nodes[nodeId]?.data.nodeSettings?.model);
  const setNodeSettings = useCanvasStore((s) => s.setNodeSettings);
  const { claudeModelId } = useProviderInfo(provider);
  const models = useClaudeModels();

  // Only the levels the node's model accepts; none at all hides the badge (e.g. Haiku).
  const supported = effortsForClaudeModel(models ?? [], nodeModel ?? claudeModelId);
  if (provider !== "claude" || supported.length === 0) return null;
  const effortOptions: readonly (ClaudeEffort | undefined)[] = [undefined, ...supported];

  // A stored level this model can't take isn't sent (chat:start drops it), so show Default.
  const effort =
    isClaudeEffort(storedEffort) && supported.includes(storedEffort) ? storedEffort : undefined;
  const overridden = effort !== undefined;

  return (
    <BadgePopover
      side={popoverSide}
      title={
        overridden
          ? `Thinking: ${effortLabel(effort, false)} (node override) · click to change`
          : "Thinking: your Claude Code default · click to change"
      }
      overridden={overridden}
      ariaHasPopup="listbox"
      panelClassName="w-[216px]"
      label={
        <>
          <Gauge className="w-[10px] h-[10px] text-muted-foreground" />
          <span className="text-[8px] tracking-tight capitalize">
            {effortLabel(effort, true)}
          </span>
          <ChevronDown className="w-[8px] h-[8px] text-muted-foreground" />
        </>
      }
    >
      {({ close }) => (
        <div className="p-2" style={{ fontFamily: "var(--font-geist-sans)" }}>
          <div className="px-0.5 pb-1.5">
            <div className="text-[10px] font-medium text-foreground">
              Thinking effort
            </div>
            <div className="mt-0.5 text-[8px] text-muted-foreground">
              Choose how deeply Claude reasons
            </div>
          </div>

          <div
            role="listbox"
            aria-label="Thinking effort"
            className="grid grid-cols-3 gap-1"
          >
            {effortOptions.map((next) => {
              const isActive = next === effort;
              return (
                <button
                  key={next ?? "default"}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    setNodeSettings(nodeId, { reasoningEffort: next });
                    close();
                  }}
                  className={clsx(
                    "flex h-7 cursor-pointer items-center justify-center rounded-md px-1 text-[9px] font-medium capitalize transition-colors",
                    isActive
                      ? "bg-foreground text-background"
                      : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {effortLabel(next, false)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </BadgePopover>
  );
}
