import type { CompactResult, LmcApi } from "@shared/ipc";
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

  state.setCompactError(args.nodeId, undefined);
  state.setCompacting(args.nodeId, true);
  let result: CompactResult;
  try {
    result = await deps.compact({
      canvasId: args.canvasId,
      nodeId: args.nodeId,
      mode: args.mode,
      ...(args.focus ? { focus: args.focus } : {}),
      session,
      ...(node.data.nodeSettings?.model ? { model: node.data.nodeSettings.model } : {}),
      cwd: state.getEffectiveCwd(args.nodeId),
    });
  } catch (error) {
    const message = `Couldn't compact: ${reasonOf(error)}`;
    deps.store.getState().setCompacting(args.nodeId, false);
    deps.store.getState().setCompactError(args.nodeId, message);
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
    void s.save();
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
  void s.save();
  return { ok: true };
}
