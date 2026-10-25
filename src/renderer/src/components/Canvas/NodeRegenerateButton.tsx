import clsx from "clsx";
import { RotateCcw } from "lucide-react";

/** Sends the node's prompt again for a fresh answer. `confirming` is the second-click state shown
 *  when other nodes branch from the answer it would replace. */
export function NodeRegenerateButton({ onClick, confirming }: { onClick: () => void; confirming: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className={clsx(
        "flex h-5 min-w-5 items-center justify-center rounded-md px-1 transition-all duration-200 cursor-pointer bg-card hover:bg-muted",
        confirming ? "text-destructive" : "text-muted-foreground hover:text-foreground",
      )}
      aria-label={confirming ? "Click again to replace this answer" : "Regenerate response"}
      title={confirming ? "Nodes branch from this answer. Click again to replace it." : "Regenerate response"}
    >
      {confirming ? (
        <span className="text-[8px] leading-none whitespace-nowrap">Replace answer?</span>
      ) : (
        <RotateCcw className="h-[7px] w-[7px]" />
      )}
    </button>
  );
}
