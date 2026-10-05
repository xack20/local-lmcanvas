import type { RunnerEvent } from "../agents/types";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Claude Code's compaction status and boundary messages, as runner events. Everything else is ignored. */
export function mapSystemMessage(msg: unknown): RunnerEvent | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "system") return null;
  if (m.subtype === "status") {
    if (m.status === "compacting") return { kind: "compacting", active: true };
    if (m.compact_result === "failed") {
      return { kind: "compacting", active: false, error: typeof m.compact_error === "string" ? m.compact_error : "Compaction failed" };
    }
    if (m.compact_result === "success") return { kind: "compacting", active: false };
    return null;
  }
  if (m.subtype === "compact_boundary" && typeof m.compact_metadata === "object" && m.compact_metadata !== null) {
    const meta = m.compact_metadata as Record<string, unknown>;
    return { kind: "compacted", trigger: meta.trigger === "manual" ? "manual" : "auto", before: num(meta.pre_tokens), after: num(meta.post_tokens) };
  }
  return null;
}
