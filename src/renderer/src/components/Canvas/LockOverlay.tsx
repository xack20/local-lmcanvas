import { lockOverlayText, type CanvasLockState, type LockHolderKind } from "@/lib/lockText";

type Props = {
  state: CanvasLockState;
  holderKind: LockHolderKind;
  replyRunning: boolean;
  onTakeOver: () => void;
};

export function LockOverlay({ state, holderKind, replyRunning, onTakeOver }: Props) {
  const text = lockOverlayText(state, holderKind, replyRunning);
  if (!text) return null;
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/60">
      <div className="max-w-sm rounded-lg border border-border bg-card p-4 text-sm shadow-lg">
        <p className="font-medium text-foreground">{text.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{text.detail}</p>
        <button
          type="button"
          onClick={onTakeOver}
          className="mt-3 cursor-pointer rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-card hover:opacity-90"
        >
          Take over here
        </button>
      </div>
    </div>
  );
}
