import { nanoid } from "nanoid";
import type { CompactResult, LmcApi } from "@shared/ipc";
import { COMPACTION_STOPPED_MESSAGE } from "@shared/contextSize";
import type { NodeId } from "@shared/types";
import type { CanvasStoreApi, CanvasStoreState } from "@/hooks/useCanvasStore";

export const SUMMARY_FALLBACK_TEXT = "Claude compacted this branch, but its summary text isn't available.";

export type CompactMode = "inPlace" | "summaryNode";
export type CompactNodeResult = { ok: true; summaryNodeId?: NodeId } | { ok: false; error: string };

// Electron wraps errors thrown by a main-process handler: "Error invoking remote method 'x': Error: <reason>".
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/;

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(IPC_ERROR_PREFIX, "");
}
type Deps = { store: CanvasStoreApi; compact: LmcApi["chat"]["compact"] };

/** Idle, Claude session present, chat open here. */
export function canCompact(state: CanvasStoreState, nodeId: NodeId): boolean {
  const node = state.nodes[nodeId];
  if (!node || state.lock !== "held" || state.compactingNodeIds[nodeId]) return false;
  if (node.data.chat.providerSession?.provider !== "claude") return false;
  return !node.data.chat.messages.some((m) => m.status === "streaming");
}

export async function compactNode(
  deps: Deps,
  args: { canvasId: string; nodeId: NodeId; mode: CompactMode; focus?: string },
): Promise<CompactNodeResult> {
  const state = deps.store.getState();
  const node = state.nodes[args.nodeId];
  const session = node?.data.chat.providerSession;
  if (!node || !session || !canCompact(state, args.nodeId)) return { ok: false, error: "This node is busy." };

  // A running operation like a reply: the canvas keeps its lock until the result is saved,
  // and main can stop it, wait for it on quit, and see it on a takeover.
  const operationId = `compact-${nanoid(10)}`;
  const settle = (): void => {
    const s = deps.store.getState();
    s.chatSettled(operationId);
    void s.save();
  };
  state.setCompactError(args.nodeId, undefined);
  state.setCompacting(args.nodeId, true);
  state.chatStarted(operationId);
  let result: CompactResult;
  try {
    result = await deps.compact({
      chatId: operationId,
      canvasId: args.canvasId,
      nodeId: args.nodeId,
      mode: args.mode,
      ...(args.focus ? { focus: args.focus } : {}),
      session,
      ...(node.data.nodeSettings?.model ? { model: node.data.nodeSettings.model } : {}),
      cwd: state.getEffectiveCwd(args.nodeId),
    });
  } catch (error) {
    const reason = reasonOf(error);
    deps.store.getState().setCompacting(args.nodeId, false);
    if (reason === COMPACTION_STOPPED_MESSAGE) {
      settle();
      return { ok: false, error: "Stopped." };
    }
    const message = `Couldn't compact: ${reason}`;
    deps.store.getState().setCompactError(args.nodeId, message);
    settle();
    return { ok: false, error: message };
  }

  const s = deps.store.getState();
  s.setCompacting(args.nodeId, false);
  if (args.mode === "summaryNode") {
    const summaryNodeId = s.createSummaryNode(args.nodeId, {
      summary: result.summary?.trim() || SUMMARY_FALLBACK_TEXT,
      sessionId: result.sessionId,
      context: result.context,
      before: result.before,
      after: result.after,
      ...(result.usage ? { usage: result.usage } : {}),
    });
    settle();
    return summaryNodeId ? { ok: true, summaryNodeId } : { ok: false, error: "Couldn't add the summary node." };
  }
  s.setProviderSession(args.nodeId, { provider: "claude", id: result.sessionId });
  const reply = [...node.data.chat.messages].reverse().find((m) => m.role === "assistant");
  if (reply) {
    s.appendBlock(args.nodeId, reply.id, {
      type: "compaction",
      trigger: "manual",
      before: result.before,
      after: result.after,
      ...(result.usage ? { usage: result.usage } : {}),
      at: Date.now(),
    });
  }
  if (result.context) s.setNodeContext(args.nodeId, result.context);
  settle();
  return { ok: true };
}
