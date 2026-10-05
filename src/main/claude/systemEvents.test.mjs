// src/main/claude/systemEvents.test.mjs
import { describe, expect, test } from "bun:test";
import { mapSystemMessage } from "./systemEvents.ts";

describe("mapSystemMessage", () => {
  test("compacting status starts the indicator", () => {
    expect(mapSystemMessage({ type: "system", subtype: "status", status: "compacting" })).toEqual({ kind: "compacting", active: true });
  });
  test("a finished status stops it, with the error when compaction failed", () => {
    expect(mapSystemMessage({ type: "system", subtype: "status", status: null, compact_result: "success" })).toEqual({ kind: "compacting", active: false });
    expect(mapSystemMessage({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "boom" })).toEqual({ kind: "compacting", active: false, error: "boom" });
  });
  test("a compact boundary reports trigger and sizes", () => {
    expect(mapSystemMessage({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 940_000, post_tokens: 62_000 } }))
      .toEqual({ kind: "compacted", trigger: "auto", before: 940_000, after: 62_000 });
    expect(mapSystemMessage({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 5 } }))
      .toEqual({ kind: "compacted", trigger: "manual", before: 5, after: null });
  });
  test("ignores everything else", () => {
    expect(mapSystemMessage({ type: "system", subtype: "init" })).toBeNull();
    expect(mapSystemMessage({ type: "system", subtype: "status", status: "requesting" })).toBeNull();
    expect(mapSystemMessage({ type: "assistant" })).toBeNull();
    expect(mapSystemMessage(null)).toBeNull();
  });
});
