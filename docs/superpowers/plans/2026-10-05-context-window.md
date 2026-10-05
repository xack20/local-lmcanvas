# Context Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Claude node shows its own context size and its combined root→here size. Claude Code's compaction becomes visible. A node can be compacted in place or continued from a summary, and a long branch never fails with "prompt is too long".

**Architecture:**
- **Measuring:** the Claude runner keeps each run's prompt stream open until the final `result`. It then asks the live session for `getContextUsage()` (2-second limit) and emits a `context` event. It also maps Claude Code's `status: compacting` and `compact_boundary` system messages into events.
- **Compaction:** a new `chat:compact` channel runs `/compact` on a node's session, either in place or on a fork that becomes a Summary node.
- **Replay:** `chat:start` fits an oversized history replay by summarizing its older part. It retries once after compacting when a resumed session overflows.
- **Display:** pure helpers derive own/combined sizes. A toolbar badge, a bottom bar and a reply divider render them.

**Tech Stack:** Electron 33, React 19, TypeScript (strict), Zustand, `@anthropic-ai/claude-agent-sdk` 0.2.141 (Claude Code 2.1.289 installed), Bun 1.4.2 tests.

**Spec:** `docs/superpowers/specs/2026-10-05-context-window-design.md`

## Global Constraints

- **Provider:** Claude only. Codex and Cursor runs, events and UI behave exactly as before.
- **Display format:**
  - root: own size only, e.g. `12k`;
  - other nodes: `+<own> · <combined>`, e.g. `+30k · 42k`;
  - estimates: prefix each number with `~`.
- **Colours:** amber from 70% of the window, red from 90%.
- **Sizes and their sources:**
  - Combined size (root→here) = `getContextUsage().totalTokens` measured at the end of the node's run, stored as `node.data.context.tokens`.
  - Own size = combined − the largest parent's combined (floored at 0). The root's own size = its combined size.
- **Defaults:**
  - measurement limit 2,000 ms;
  - estimate 4 characters per token;
  - setup allowance 20,000 tokens (or the last measured setup size);
  - unknown window 200,000 tokens;
  - reply headroom 20% of the window;
  - recent-message budget half of the prompt budget.
- **Divider texts:**
  - auto/manual: `Context compacted: <before> → <after> (<auto|manual>)`;
  - replay summary: `Earlier messages were summarized to fit: <before> → <after>`;
  - replay trim: `Earlier messages were left out to fit`.
- **Summary node:**
  - user message `Continue from summary`;
  - header `Summary of this branch · <before> → <after>`;
  - fallback text when no summary was captured: `Claude compacted this branch, but its summary text isn't available.`
- **Indicator text** while compacting: `Compacting conversation…`.
- **Channel:** `chat:compact` is registered `"shared"` and refused unless `canvasLocks.canWrite(canvasId, client)`. On refusal it throws `CANVAS_LOCKED_MESSAGE`.
- **Tests:**
  - run each `*.test.mjs` in its own `bun test <file>` process;
  - tests never touch the real `~/.local-lmcanvas`;
  - never run `tailscale`;
  - `bun run typecheck` must be clean before any task is reported done.
- **Commits:** conventional messages with no attribution lines.

## Review Focus

1. **A slow or failing context measurement must never hold a reply open.** Even if `getContextUsage()` hangs or throws, `done` is still emitted within about 2 seconds of `result`. Test: Task 3 "measureContext gives up after the limit".
2. **Old canvases must render without crashing.** Nodes without `context`, nodes whose `parentIds` point at a missing node, and nodes on other providers show estimates or nothing. Test: Task 2 "a dangling parent counts as a root".
3. **Compacting must not run twice, or while the node is streaming.** The second request is refused, and nothing is sent. Test: Task 8 "refuses while the node is busy".
4. **A Summary node must never be blank.** When the PostCompact hook didn't deliver a summary, it gets the fallback text. Test: Task 8 "uses the fallback text when no summary was captured".
5. **A single giant message bigger than the whole budget must still produce a prompt that fits.** It's cut, not sent whole, and not dropped silently. Test: Task 9 "cuts a single oversized message".

---

### Task 1: Spike — confirm the SDK behaviours (throwaway)

**Files:**
- Create: `scratch/context-spike.mjs` (gitignored scratch, not committed; delete at the end of the task)
- Write findings to the SDD ledger, or to `scratch/context-spike-findings.md` if there's no ledger

**Interfaces:**
- Consumes: the installed `claude` (`command -v claude`), `@anthropic-ai/claude-agent-sdk`.
- Produces: a findings note answering the questions below with YES/NO plus evidence. Later tasks assume all are YES. **If any is NO, stop and report. Don't build on it.**

- [ ] **Step 1: Write the spike script**

```js
// scratch/context-spike.mjs — throwaway; uses tiny prompts on throwaway sessions.
import { query } from "../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

const bin = execSync("command -v claude", { shell: "/bin/zsh" }).toString().trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function heldOpen(text) {
  let release;
  const idle = new Promise((r) => (release = r));
  async function* input() {
    yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: text } };
    await idle;
  }
  return { input: input(), release: () => release() };
}

async function run(label, text, extra = {}) {
  const held = heldOpen(text);
  let summary = null;
  const q = query({
    prompt: held.input,
    options: {
      pathToClaudeCodeExecutable: bin,
      cwd: homedir(),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project"],
      model: "haiku",
      hooks: {
        PostCompact: [{ hooks: [async (input) => { summary = input.compact_summary; return {}; }] }],
      },
      ...extra,
    },
  });
  let sessionId = null;
  for await (const msg of q) {
    if (msg.session_id) sessionId = msg.session_id;
    if (msg.type === "system" && (msg.subtype === "status" || msg.subtype === "compact_boundary")) log(label, "SYSTEM", JSON.stringify(msg).slice(0, 300));
    if (msg.type === "result") {
      log(label, "result", msg.subtype, msg.is_error);
      try {
        const usage = await Promise.race([q.getContextUsage(), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5000))]);
        log(label, "getContextUsage", JSON.stringify({ totalTokens: usage.totalTokens, maxTokens: usage.maxTokens, percentage: usage.percentage, autoCompactThreshold: usage.autoCompactThreshold, isAutoCompactEnabled: usage.isAutoCompactEnabled, model: usage.model, categories: usage.categories.map((c) => [c.name, c.tokens]), messageBreakdown: usage.messageBreakdown }));
      } catch (e) { log(label, "getContextUsage FAILED", e.message); }
      break;
    }
  }
  held.release();
  log(label, "session", sessionId, "summary", summary ? summary.slice(0, 120) : null);
  return sessionId;
}

const s1 = await run("Q3 measure", "Reply with exactly: spike one");
await run("Q2 compact in place", "/compact keep only the phrase 'spike one'", { resume: s1 });
const forked = await run("Q2 compact fork", "/compact", { resume: s1, forkSession: true });
log("fork id differs from original:", forked !== s1);
```

- [ ] **Step 2: Run it and record the answers**

Run: `node scratch/context-spike.mjs 2>&1 | tee scratch/context-spike.log`

Record YES/NO plus the log lines for:
- **Q1.** Do `status` messages with `status: "compacting"` and `compact_boundary` messages (with `compact_metadata.pre_tokens` / `post_tokens`) appear during `/compact`? Treat this as the auto-compaction evidence too, since it's the same message path.
- **Q2.** Does `/compact [focus]` work as a held-open prompt, both in place (`resume`) and on a fork (`resume` + `forkSession: true`, giving a new session id)?
- **Q3.** Does `getContextUsage()` answer after `result`, returning `totalTokens`, `maxTokens`, `autoCompactThreshold` (tokens or a fraction?), `model`, a category named like `Messages`, and `messageBreakdown.toolResultTokens`?
- **Q4.** Does the `PostCompact` hook deliver `compact_summary`?

Note the exact `categories[].name` values and whether `autoCompactThreshold` is a token count or a fraction. Task 3's `toContextSnapshot` reads them.

- [ ] **Step 3: Clean up**

Delete `scratch/context-spike.mjs` and its log. Move the throwaway session files the spike created into `~/.Trash`: search `~/.claude/projects/-Users-xack/*.jsonl` for "spike one". Commit nothing.

---

### Task 2: Shared types and the context-size helpers

**Files:**
- Modify: `src/shared/types.ts` (add `ContextBreakdown`, `ContextSnapshot`, `CompactionTrigger`, `CompactionBlock`; extend `ContentBlock`, `CanvasNode.data`, `ErrorCode`)
- Modify: `src/shared/history.ts` (`isErrorCode` accepts `"prompt_too_long"`; `blocksToPlainText` skips compaction blocks)
- Create: `src/shared/contextSize.ts`
- Test: `src/shared/contextSize.test.mjs`

**Interfaces:**
- Produces:
  - `type ContextSnapshot = { tokens: number; window: number; autoCompactAt?: number; autoCompactEnabled: boolean; breakdown?: ContextBreakdown; model?: string; exact: boolean; measuredAt: number }`
  - `type ContextBreakdown = { setup: number; conversation: number; toolResults: number }`
  - `type CompactionTrigger = "auto" | "manual" | "replay"`
  - `type CompactionBlock = { type: "compaction"; trigger: CompactionTrigger; before: number | null; after: number | null; method?: "summary" | "trimmed"; usage?: UsageSummary }`
  - `CanvasNode.data.context?: ContextSnapshot`
  - `ErrorCode` gains `"prompt_too_long"`
  - from `contextSize.ts`:
    - `contextView(nodeId: NodeId, nodes: Record<NodeId, CanvasNode>, opts?: { setupTokens?: number; defaultWindow?: number }): ContextView | null`
    - `formatTokens(n: number): string`
    - `contextLabel(view: ContextView): string`
    - `contextLevel(percent: number): ContextLevel`
    - `compactionText(block: CompactionBlock): string`
    - constants `CHARS_PER_TOKEN = 4`, `DEFAULT_SETUP_TOKENS = 20_000`, `DEFAULT_WINDOW = 200_000`, `WARN_AT = 0.7`, `FULL_AT = 0.9`
  - `type ContextLevel = "ok" | "warn" | "full"`
  - `type ContextView = { isRoot: boolean; own: number; combined: number; window: number; percent: number; exact: boolean; level: ContextLevel; autoCompactAt?: number; autoCompactEnabled?: boolean; breakdown?: ContextBreakdown; compactions: number }`

- [ ] **Step 1: Write the failing test**

```js
// src/shared/contextSize.test.mjs — .mjs keeps bun:test out of typecheck.
import { describe, expect, test } from "bun:test";
import { compactionText, contextLabel, contextLevel, contextView, formatTokens } from "./contextSize.ts";

const ctx = (tokens, extra = {}) => ({ tokens, window: 1_000_000, autoCompactEnabled: true, exact: true, measuredAt: 1, ...extra });
const node = (id, parentIds, context, messages = []) => ({
  id, type: "custom", position: { x: 0, y: 0 },
  data: { chat: { messages, parentIds, childIds: [] }, ...(context ? { context } : {}) },
});
const text = (role, t) => ({ id: `${role}-${t.length}`, role, createdAt: 1, blocks: [{ type: "text", text: t }] });

describe("formatTokens", () => {
  test("uses k and M", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(412_000)).toBe("412k");
    expect(formatTokens(1_300_000)).toBe("1.3M");
    expect(formatTokens(1_000_000)).toBe("1M");
  });
});

describe("contextView", () => {
  const nodes = {
    root: node("root", [], ctx(12_000)),
    two: node("two", ["root"], ctx(42_000)),
    three: node("three", ["two"], ctx(60_000)),
  };

  test("the root shows only its own size, which is also everything the model holds", () => {
    const view = contextView("root", nodes);
    expect(view).toMatchObject({ isRoot: true, own: 12_000, combined: 12_000, exact: true });
    expect(contextLabel(view)).toBe("12k");
  });

  test("other nodes show their own size and the combined size from the root", () => {
    expect(contextLabel(contextView("two", nodes))).toBe("+30k · 42k");
    expect(contextLabel(contextView("three", nodes))).toBe("+18k · 60k");
  });

  test("a merge node measures its own size against its largest parent", () => {
    const merged = { ...nodes, other: node("other", ["root"], ctx(20_000)), merge: node("merge", ["two", "other"], ctx(50_000)) };
    expect(contextView("merge", merged).own).toBe(8_000);
  });

  test("own size never goes negative after a compaction", () => {
    const compacted = { ...nodes, four: node("four", ["three"], ctx(30_000)) };
    expect(contextView("four", compacted).own).toBe(0);
  });

  test("a dangling parent counts as a root", () => {
    const lonely = { x: node("x", ["missing"], ctx(5_000)) };
    expect(contextView("x", lonely)).toMatchObject({ isRoot: true, own: 5_000 });
  });

  test("unmeasured nodes get a marked estimate built on the nearest measured ancestor", () => {
    const withNew = { ...nodes, four: node("four", ["three"], undefined, [text("user", "a".repeat(4_000)), text("assistant", "b".repeat(8_000))]) };
    const view = contextView("four", withNew);
    expect(view.exact).toBe(false);
    expect(view.combined).toBe(63_000);
    expect(view.own).toBe(3_000);
    expect(contextLabel(view)).toBe("~+3k · ~63k");
  });

  test("an unmeasured root estimates its text plus the setup allowance", () => {
    const view = contextView("r", { r: node("r", [], undefined, [text("user", "a".repeat(400))]) });
    expect(view).toMatchObject({ exact: false, combined: 20_100, window: 200_000 });
  });

  test("percent and level follow the window, with the window inherited from the nearest measured ancestor", () => {
    const big = { a: node("a", [], ctx(750_000)), b: node("b", ["a"], undefined, []) };
    expect(contextView("a", big)).toMatchObject({ percent: 0.75, level: "warn" });
    expect(contextView("b", big).window).toBe(1_000_000);
  });

  test("counts compactions along the path", () => {
    const compactedPath = {
      a: node("a", [], ctx(10_000), [{ id: "m", role: "assistant", createdAt: 1, blocks: [{ type: "compaction", trigger: "auto", before: 900_000, after: 60_000 }] }]),
      b: node("b", ["a"], ctx(20_000)),
    };
    expect(contextView("b", compactedPath).compactions).toBe(1);
  });

  test("returns null for an unknown node", () => {
    expect(contextView("nope", nodes)).toBeNull();
  });
});

describe("contextLevel and compactionText", () => {
  test("amber from 70%, red from 90%", () => {
    expect(contextLevel(0.69)).toBe("ok");
    expect(contextLevel(0.7)).toBe("warn");
    expect(contextLevel(0.9)).toBe("full");
  });

  test("divider texts", () => {
    expect(compactionText({ type: "compaction", trigger: "auto", before: 940_000, after: 62_000 })).toBe("Context compacted: 940k → 62k (auto)");
    expect(compactionText({ type: "compaction", trigger: "manual", before: 412_000, after: 38_000 })).toBe("Context compacted: 412k → 38k (manual)");
    expect(compactionText({ type: "compaction", trigger: "replay", before: 1_300_000, after: 180_000, method: "summary" })).toBe("Earlier messages were summarized to fit: 1.3M → 180k");
    expect(compactionText({ type: "compaction", trigger: "replay", before: null, after: null, method: "trimmed" })).toBe("Earlier messages were left out to fit");
    expect(compactionText({ type: "compaction", trigger: "auto", before: null, after: null })).toBe("Context compacted (auto)");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/shared/contextSize.test.mjs`
Expected: FAIL, `Cannot find module './contextSize.ts'`.

- [ ] **Step 3: Add the shared types**

In `src/shared/types.ts`, change the `ContentBlock` and `ErrorCode` lines and add the new types near them:

```ts
export type CompactionTrigger = "auto" | "manual" | "replay";

/** A marker where the conversation was summarized (sizes in tokens, when known). */
export type CompactionBlock = {
  type: "compaction";
  trigger: CompactionTrigger;
  before: number | null;
  after: number | null;
  /** Replay only: whether older messages were summarized or left out. */
  method?: "summary" | "trimmed";
  /** A manual compaction's own cost (it is a real Claude call). */
  usage?: UsageSummary;
};

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | ImageBlock | CompactionBlock;

export type ErrorCode = "auth_required" | "policy_refusal" | "prompt_too_long";

export type ContextBreakdown = { setup: number; conversation: number; toolResults: number };

/** What the model holds after a node's run (root→here), from Claude Code's getContextUsage(). */
export type ContextSnapshot = {
  tokens: number;
  window: number;
  autoCompactAt?: number;
  autoCompactEnabled: boolean;
  breakdown?: ContextBreakdown;
  model?: string;
  /** False for an estimate (older nodes, other providers, a failed measurement). */
  exact: boolean;
  measuredAt: number;
};
```

In `CanvasNode.data`, after `nodeSettings?: NodeSettings;`, add:

```ts
    /** Context size after this node's last Claude run (combined, root→here). */
    context?: ContextSnapshot;
```

In `src/shared/history.ts`:
- change `isErrorCode` to `return value === "auth_required" || value === "policy_refusal" || value === "prompt_too_long";`;
- in `blocksToPlainText`, add a branch `} else if (b.type === "compaction") { // a marker, not conversation` before the `image` branch.

- [ ] **Step 4: Implement `src/shared/contextSize.ts`**

```ts
import { blocksToPlainText } from "./history";
import type { CanvasNode, CompactionBlock, ContextBreakdown, NodeId } from "./types";

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_SETUP_TOKENS = 20_000;
export const DEFAULT_WINDOW = 200_000;
export const WARN_AT = 0.7;
export const FULL_AT = 0.9;

export type ContextLevel = "ok" | "warn" | "full";

export type ContextView = {
  isRoot: boolean;
  own: number;
  combined: number;
  window: number;
  percent: number;
  exact: boolean;
  level: ContextLevel;
  autoCompactAt?: number;
  autoCompactEnabled?: boolean;
  breakdown?: ContextBreakdown;
  compactions: number;
};

type Nodes = Record<NodeId, CanvasNode>;
type Combined = { tokens: number; exact: boolean; window: number | undefined };

export function formatTokens(n: number): string {
  if (n < 1_000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function contextLevel(percent: number): ContextLevel {
  if (percent >= FULL_AT) return "full";
  if (percent >= WARN_AT) return "warn";
  return "ok";
}

export function compactionText(block: CompactionBlock): string {
  const sizes =
    block.before !== null && block.after !== null
      ? `: ${formatTokens(block.before)} → ${formatTokens(block.after)}`
      : "";
  if (block.trigger === "replay") {
    return block.method === "trimmed"
      ? "Earlier messages were left out to fit"
      : `Earlier messages were summarized to fit${sizes}`;
  }
  return `Context compacted${sizes} (${block.trigger})`;
}

function parentsOf(node: CanvasNode, nodes: Nodes): CanvasNode[] {
  return node.data.chat.parentIds.flatMap((id) => (nodes[id] ? [nodes[id]] : []));
}

function estimateOwnTokens(node: CanvasNode): number {
  const chars = node.data.chat.messages.reduce((sum, m) => sum + blocksToPlainText(m.blocks).length, 0);
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Exact when measured; otherwise the nearest measured ancestor's size plus estimates below it. */
function combinedOf(node: CanvasNode, nodes: Nodes, setupTokens: number, seen: Set<NodeId>): Combined {
  if (node.data.context) {
    return { tokens: node.data.context.tokens, exact: node.data.context.exact, window: node.data.context.window };
  }
  if (seen.has(node.id)) return { tokens: estimateOwnTokens(node), exact: false, window: undefined };
  const nextSeen = new Set(seen).add(node.id);
  const parents = parentsOf(node, nodes).map((p) => combinedOf(p, nodes, setupTokens, nextSeen));
  const base = parents.reduce<Combined | null>((best, p) => (best === null || p.tokens > best.tokens ? p : best), null);
  return {
    tokens: (base ? base.tokens : setupTokens) + estimateOwnTokens(node),
    exact: false,
    window: base?.window,
  };
}

function countCompactions(node: CanvasNode, nodes: Nodes): number {
  let count = 0;
  const seen = new Set<NodeId>();
  let current: CanvasNode | undefined = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    for (const m of current.data.chat.messages) {
      count += m.blocks.filter((b) => b.type === "compaction").length;
    }
    const parentId: NodeId | undefined = current.data.chat.parentIds[0];
    current = parentId ? nodes[parentId] : undefined;
  }
  return count;
}

/** Own and combined (root→here) context sizes for a node, measured or estimated. */
export function contextView(
  nodeId: NodeId,
  nodes: Nodes,
  opts: { setupTokens?: number; defaultWindow?: number } = {},
): ContextView | null {
  const node = nodes[nodeId];
  if (!node) return null;
  const setupTokens = opts.setupTokens ?? DEFAULT_SETUP_TOKENS;
  const combined = combinedOf(node, nodes, setupTokens, new Set());
  const parents = parentsOf(node, nodes).map((p) => combinedOf(p, nodes, setupTokens, new Set([nodeId])));
  const isRoot = parents.length === 0;
  const largestParent = parents.reduce((max, p) => Math.max(max, p.tokens), 0);
  const own = isRoot ? combined.tokens : Math.max(0, combined.tokens - largestParent);
  const window = combined.window ?? opts.defaultWindow ?? DEFAULT_WINDOW;
  const percent = window > 0 ? combined.tokens / window : 0;
  const context = node.data.context;
  return {
    isRoot,
    own,
    combined: combined.tokens,
    window,
    percent,
    exact: combined.exact,
    level: contextLevel(percent),
    autoCompactAt: context?.autoCompactAt,
    autoCompactEnabled: context?.autoCompactEnabled,
    breakdown: context?.breakdown,
    compactions: countCompactions(node, nodes),
  };
}

/** Root: `12k`. Others: `+30k · 42k`. Estimates carry a leading `~`. */
export function contextLabel(view: ContextView): string {
  const mark = view.exact ? "" : "~";
  if (view.isRoot) return `${mark}${formatTokens(view.combined)}`;
  return `${mark}+${formatTokens(view.own)} · ${mark}${formatTokens(view.combined)}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
bun test src/shared/contextSize.test.mjs
bun test src/shared/history.test.mjs
bun run typecheck
```
Expected: PASS; PASS; clean. If typecheck flags an exhaustive `switch` over `ContentBlock` somewhere, add an explicit `compaction` case that renders/ignores it per Task 6.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/history.ts src/shared/contextSize.ts src/shared/contextSize.test.mjs
git commit -m "feat(context): shared context-size types and helpers"
```

---

### Task 3: Runner — compaction events and end-of-run measurement

**Files:**
- Create: `src/main/claude/systemEvents.ts`, `src/main/claude/contextUsage.ts`, `src/main/claude/heldOpenPrompt.ts`
- Modify: `src/main/agents/types.ts` (new `RunnerEvent` kinds; `isPromptTooLong`)
- Modify: `src/main/claude/runner.ts` (held-open prompt, map system messages, measure before leaving the loop, `prompt_too_long` code)
- Test: `src/main/claude/systemEvents.test.mjs`, `src/main/claude/contextUsage.test.mjs`, `src/main/claude/heldOpenPrompt.test.mjs`

**Interfaces:**
- Consumes: `ContextSnapshot`, `CompactionTrigger` (Task 2); Task 1's recorded category names and the `autoCompactThreshold` unit.
- Produces:
  - `RunnerEvent` gains:
    - `{ kind: "compacting"; active: boolean; error?: string }`
    - `{ kind: "compacted"; trigger: CompactionTrigger; before: number | null; after: number | null; method?: "summary" | "trimmed" }`
    - `{ kind: "context"; context: ContextSnapshot }`
  - `isPromptTooLong(message: string): boolean`
  - `mapSystemMessage(msg: unknown): RunnerEvent | null`
  - `toContextSnapshot(raw: unknown, now: number): ContextSnapshot | null`
  - `measureContext(session: { getContextUsage(): Promise<unknown> }, timeoutMs?: number, now?: () => number): Promise<ContextSnapshot | null>`
  - `heldOpenPrompt(message: SDKUserMessage): { input: AsyncIterable<SDKUserMessage>; release(): void }`
  - `CONTEXT_MEASURE_TIMEOUT_MS = 2_000`

- [ ] **Step 1: Write the failing tests**

```js
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
```

```js
// src/main/claude/contextUsage.test.mjs
import { describe, expect, test } from "bun:test";
import { measureContext, toContextSnapshot } from "./contextUsage.ts";

const USAGE = {
  totalTokens: 412_000, maxTokens: 1_000_000, percentage: 41.2, autoCompactThreshold: 950_000, isAutoCompactEnabled: true,
  model: "claude-opus-5-5",
  categories: [{ name: "System prompt", tokens: 9_000 }, { name: "Messages", tokens: 380_000 }],
  messageBreakdown: { toolCallTokens: 2_000, toolResultTokens: 120_000, attachmentTokens: 0 },
};

describe("toContextSnapshot", () => {
  test("keeps totals, window, auto-compact and a short breakdown", () => {
    expect(toContextSnapshot(USAGE, 7)).toEqual({
      tokens: 412_000, window: 1_000_000, autoCompactAt: 950_000, autoCompactEnabled: true, model: "claude-opus-5-5",
      breakdown: { setup: 32_000, conversation: 260_000, toolResults: 120_000 },
      exact: true, measuredAt: 7,
    });
  });
  test("rejects a response without totals", () => {
    expect(toContextSnapshot({ maxTokens: 5 }, 1)).toBeNull();
    expect(toContextSnapshot(null, 1)).toBeNull();
  });
});

describe("measureContext", () => {
  test("returns the snapshot", async () => {
    expect((await measureContext({ getContextUsage: async () => USAGE }, 100, () => 3))?.tokens).toBe(412_000);
  });
  test("gives up after the limit", async () => {
    const started = Date.now();
    expect(await measureContext({ getContextUsage: () => new Promise(() => {}) }, 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
  test("a failing call is null, not a throw", async () => {
    expect(await measureContext({ getContextUsage: async () => { throw new Error("closed"); } }, 100)).toBeNull();
  });
});
```

```js
// src/main/claude/heldOpenPrompt.test.mjs
import { expect, test } from "bun:test";
import { heldOpenPrompt } from "./heldOpenPrompt.ts";

test("yields the message, then stays open until released", async () => {
  const message = { type: "user", parent_tool_use_id: null, message: { role: "user", content: "hi" } };
  const held = heldOpenPrompt(message);
  const it = held.input[Symbol.asyncIterator]();
  expect((await it.next()).value).toBe(message);
  let finished = false;
  const next = it.next().then((r) => (finished = r.done));
  await new Promise((r) => setTimeout(r, 10));
  expect(finished).toBe(false);
  held.release();
  await next;
  expect(finished).toBe(true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run each: `bun test src/main/claude/systemEvents.test.mjs`, `bun test src/main/claude/contextUsage.test.mjs`, `bun test src/main/claude/heldOpenPrompt.test.mjs`
Expected: FAIL, modules not found.

- [ ] **Step 3: Extend `RunnerEvent` and add `isPromptTooLong`**

In `src/main/agents/types.ts`, add `CompactionTrigger, ContextSnapshot` to the `@shared/types` import, and add these members to `RunnerEvent` (before `| { kind: "error"; ... }`):

```ts
  | { kind: "compacting"; active: boolean; error?: string }
  | {
      kind: "compacted";
      trigger: CompactionTrigger;
      before: number | null;
      after: number | null;
      method?: "summary" | "trimmed";
    }
  | { kind: "context"; context: ContextSnapshot }
```

Below `isPolicyRefusal`, add:

```ts
const PROMPT_TOO_LONG_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /input is too long/i,
  /context (?:length|window) (?:exceeded|limit)/i,
  /exceeds? the (?:maximum )?context/i,
];

export function isPromptTooLong(message: string): boolean {
  if (!message) return false;
  return PROMPT_TOO_LONG_PATTERNS.some((re) => re.test(message));
}
```

- [ ] **Step 4: Implement the three helpers**

```ts
// src/main/claude/systemEvents.ts
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
```

```ts
// src/main/claude/contextUsage.ts
import type { ContextSnapshot } from "@shared/types";

export const CONTEXT_MEASURE_TIMEOUT_MS = 2_000;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Normalizes the SDK's getContextUsage() answer. Category names per the Task 1 spike ("Messages"). */
export function toContextSnapshot(raw: unknown, now: number): ContextSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const tokens = num(r.totalTokens);
  const window = num(r.maxTokens);
  if (tokens === undefined || window === undefined) return null;
  const categories = Array.isArray(r.categories) ? (r.categories as Array<Record<string, unknown>>) : [];
  const messages = num(categories.find((c) => typeof c.name === "string" && /^messages$/i.test(c.name))?.tokens);
  const breakdownRaw = (r.messageBreakdown ?? {}) as Record<string, unknown>;
  const toolResults = num(breakdownRaw.toolResultTokens) ?? 0;
  const breakdown =
    messages !== undefined
      ? { setup: Math.max(0, tokens - messages), conversation: Math.max(0, messages - toolResults), toolResults }
      : undefined;
  const autoCompactAt = num(r.autoCompactThreshold);
  return {
    tokens,
    window,
    ...(autoCompactAt !== undefined ? { autoCompactAt } : {}),
    autoCompactEnabled: r.isAutoCompactEnabled === true,
    ...(typeof r.model === "string" ? { model: r.model } : {}),
    ...(breakdown ? { breakdown } : {}),
    exact: true,
    measuredAt: now,
  };
}

/** Asks a live session for its context usage; null after `timeoutMs` or on any failure. Never throws. */
export async function measureContext(
  session: { getContextUsage(): Promise<unknown> },
  timeoutMs: number = CONTEXT_MEASURE_TIMEOUT_MS,
  now: () => number = Date.now,
): Promise<ContextSnapshot | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const raw = await Promise.race([Promise.resolve().then(() => session.getContextUsage()), timeout]);
    return raw === null ? null : toContextSnapshot(raw, now());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

If Task 1 found `autoCompactThreshold` is a fraction rather than tokens, store `Math.round(threshold * window)` instead, and add a test case for it.

```ts
// src/main/claude/heldOpenPrompt.ts
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** A one-message prompt stream that stays open until released, so the session still answers
 *  control requests (e.g. getContextUsage) after its final result. */
export function heldOpenPrompt(message: SDKUserMessage): { input: AsyncIterable<SDKUserMessage>; release(): void } {
  let release = (): void => {};
  const idle = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* input(): AsyncGenerator<SDKUserMessage, void> {
    yield message;
    await idle;
  }
  return { input: input(), release: () => release() };
}
```

- [ ] **Step 5: Wire them into `runner.ts`**

Imports to add:

```ts
import { isPromptTooLong } from "../agents/types";
import { measureContext } from "./contextUsage";
import { heldOpenPrompt } from "./heldOpenPrompt";
import { mapSystemMessage } from "./systemEvents";
```

In `emit`, after the policy-refusal blocks, add:

```ts
    if (ev.kind === "error" && !ev.code && isPromptTooLong(ev.message)) {
      opts.onEvent({ ...ev, code: "prompt_too_long" });
      return;
    }
    if (ev.kind === "done" && ev.isError && !ev.code && isPromptTooLong(ev.result ?? "")) {
      opts.onEvent({ ...ev, code: "prompt_too_long" });
      return;
    }
```

Replace the `promptInput` construction:
- delete the `const promptInput … = attachments.length > 0 ? buildStreamingPrompt(…) : prompt;` lines;
- change `buildStreamingPrompt` into a plain `buildUserMessage(text, attachments): SDKUserMessage` that returns the same object it used to yield (text-only messages included);
- then:

```ts
  const held = heldOpenPrompt(buildUserMessage(prompt, attachments));
```

Pass `prompt: held.input` to `query(...)`.

Replace the loop body so system messages are mapped, and the context is measured before leaving at `result`:

```ts
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      const sessionId = (msg as { session_id?: unknown }).session_id;
      if (typeof sessionId === "string" && sessionId.length > 0 && sessionId !== emittedSessionId) {
        emittedSessionId = sessionId;
        emit({ kind: "session", session: { provider: "claude", id: sessionId } });
      }
      const systemEvent = mapSystemMessage(msg);
      if (systemEvent) emit(systemEvent);
      if (msg.type === "result") {
        const context = await measureContext(q);
        if (context) emit({ kind: "context", context });
      }
      handleMessage(msg, seenToolUseIds, emit);
      if (msg.type === "result") break;
    }
```

In the `finally`, before `if (!doneEmitted) …`, add `held.release();`.

Keep `buildUserMessage` producing a string `content` when there are no attachments (`message: { role: "user", content: text }`), so plain prompts reach Claude Code exactly as before.

- [ ] **Step 6: Run the tests and typecheck**

Run each file separately:
```bash
bun test src/main/claude/systemEvents.test.mjs
bun test src/main/claude/contextUsage.test.mjs
bun test src/main/claude/heldOpenPrompt.test.mjs
bun run typecheck
```
Expected: all PASS; typecheck clean. `src/main/index.ts` will flag the new `RunnerEvent` kinds in `forwardEvent`'s `switch` only if it's exhaustive. If it does, add temporary `case "compacting": case "compacted": case "context": return;`, which Task 4 replaces.

- [ ] **Step 7: Commit**

```bash
git add src/main/agents/types.ts src/main/claude/systemEvents.ts src/main/claude/systemEvents.test.mjs src/main/claude/contextUsage.ts src/main/claude/contextUsage.test.mjs src/main/claude/heldOpenPrompt.ts src/main/claude/heldOpenPrompt.test.mjs src/main/claude/runner.ts src/main/index.ts
git commit -m "feat(context): report compaction and measure the context at the end of each Claude run"
```

---

### Task 4: Forward the new events, and remember model windows

**Files:**
- Create: `src/main/claude/modelWindows.ts`
- Test: `src/main/claude/modelWindows.test.mjs`
- Modify: `src/shared/ipc.ts` (`ChatEvent` members)
- Modify: `src/main/index.ts` (`forwardEvent` cases; load windows at startup; learn from `context`)

**Interfaces:**
- Consumes: the Task 3 `RunnerEvent` kinds.
- Produces:
  - `ChatEvent` gains:
    - `{ chatId; type: "compacting"; active: boolean; error?: string }`
    - `{ chatId; type: "compacted"; trigger: CompactionTrigger; before: number | null; after: number | null; method?: "summary" | "trimmed" }`
    - `{ chatId; type: "context"; context: ContextSnapshot }`
  - `type ModelWindows = { windowFor(model: string | undefined): number | undefined; learn(model: string | undefined, window: number): Promise<void> }`
  - `loadModelWindows(filePath: string, write?: (path: string, data: string) => Promise<void>): Promise<ModelWindows>`
  - module-level `modelWindows` in `index.ts`, loaded from `join(ROOT_DIR, "model-windows.json")`

- [ ] **Step 1: Write the failing test**

```js
// src/main/claude/modelWindows.test.mjs
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelWindows } from "./modelWindows.ts";

const dir = mkdtempSync(join(tmpdir(), "lmc-windows-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadModelWindows", () => {
  test("starts empty when the file is missing or broken", async () => {
    expect((await loadModelWindows(join(dir, "none.json"))).windowFor("claude-opus-5-5")).toBeUndefined();
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect((await loadModelWindows(join(dir, "bad.json"))).windowFor("x")).toBeUndefined();
  });

  test("learns windows, persists them, and ignores bad input", async () => {
    const file = join(dir, "w.json");
    const windows = await loadModelWindows(file);
    await windows.learn("claude-opus-5-5", 1_000_000);
    await windows.learn(undefined, 5);
    await windows.learn("bad", -1);
    expect(windows.windowFor("claude-opus-5-5")).toBe(1_000_000);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "claude-opus-5-5": 1_000_000 });
    expect((await loadModelWindows(file)).windowFor("claude-opus-5-5")).toBe(1_000_000);
  });

  test("concurrent learns all land", async () => {
    const file = join(dir, "c.json");
    const windows = await loadModelWindows(file);
    await Promise.all([windows.learn("a", 1), windows.learn("b", 2), windows.learn("c", 3)]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 1, b: 2, c: 3 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/claude/modelWindows.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/main/claude/modelWindows.ts`**

```ts
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../storage/paths";

export type ModelWindows = {
  windowFor(model: string | undefined): number | undefined;
  learn(model: string | undefined, window: number): Promise<void>;
};

/** Context windows seen per model, so a replay can be sized before the model is asked. */
export async function loadModelWindows(
  filePath: string,
  write: (path: string, data: string) => Promise<void> = atomicWriteFile,
): Promise<ModelWindows> {
  let windows: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf-8"));
    if (parsed && typeof parsed === "object") {
      windows = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0,
        ),
      );
    }
  } catch {
    windows = {};
  }
  let writes: Promise<void> = Promise.resolve();

  return {
    windowFor: (model) => (model ? windows[model] : undefined),
    learn(model, window) {
      if (!model || !Number.isFinite(window) || window <= 0 || windows[model] === window) return writes;
      windows = { ...windows, [model]: window };
      const run = writes.then(() => write(filePath, JSON.stringify(windows, null, 2)));
      writes = run.catch(() => undefined);
      return run;
    },
  };
}
```

Check `atomicWriteFile`'s signature in `src/main/storage/paths.ts`. If it differs from `(path, data) => Promise<void>`, adapt the default argument.

- [ ] **Step 4: Add the `ChatEvent` members**

In `src/shared/ipc.ts`, add `CompactionTrigger, ContextSnapshot` to the type import, and add these to `ChatEvent` before the `"done"` member:

```ts
  | { chatId: string; type: "compacting"; active: boolean; error?: string }
  | {
      chatId: string;
      type: "compacted";
      trigger: CompactionTrigger;
      before: number | null;
      after: number | null;
      method?: "summary" | "trimmed";
    }
  | { chatId: string; type: "context"; context: ContextSnapshot }
```

- [ ] **Step 5: Forward them in `index.ts`, and learn windows**

Near the other module-level singletons:

```ts
let modelWindows: ModelWindows | null = null;
```

In `app.whenReady()` before `registerIpc()`:

```ts
  modelWindows = await loadModelWindows(join(ROOT_DIR, "model-windows.json")).catch(() => null);
```

In `forwardEvent`'s `switch`, add (replacing any temporary Task 3 cases):

```ts
        case "compacting":
          send({ chatId, type: "compacting", active: ev.active, ...(ev.error ? { error: ev.error } : {}) });
          return;
        case "compacted":
          send({ chatId, type: "compacted", trigger: ev.trigger, before: ev.before, after: ev.after, ...(ev.method ? { method: ev.method } : {}) });
          return;
        case "context":
          void modelWindows?.learn(ev.context.model, ev.context.window).catch((error: unknown) =>
            console.warn("[context] couldn't save the model window:", error),
          );
          send({ chatId, type: "context", context: ev.context });
          return;
```

Imports: `import { loadModelWindows, type ModelWindows } from "./claude/modelWindows";` (`ROOT_DIR` and `join` are already imported).

- [ ] **Step 6: Run the tests and typecheck**

Run: `bun test src/main/claude/modelWindows.test.mjs` and `bun run typecheck`
Expected: PASS; clean. The renderer's `useNodeChat` switch isn't exhaustive, so typecheck stays clean until Task 5 handles the events.

- [ ] **Step 7: Commit**

```bash
git add src/main/claude/modelWindows.ts src/main/claude/modelWindows.test.mjs src/shared/ipc.ts src/main/index.ts
git commit -m "feat(context): forward context and compaction events, remember model windows"
```

---

### Task 5: Canvas store — save sizes, show compaction

**Files:**
- Modify: `src/renderer/src/hooks/useCanvasStore.ts` (new state `compactingNodeIds`; actions `setNodeContext`, `setCompacting`)
- Modify: `src/renderer/src/hooks/useNodeChat.ts` (handle `compacting`, `compacted`, `context`)
- Test: `src/renderer/src/hooks/useCanvasStore.context.test.mjs`

**Interfaces:**
- Consumes: Task 2 types; Task 4 `ChatEvent` members.
- Produces (store):
  - `compactingNodeIds: Record<NodeId, true>` (transient, never saved)
  - `setNodeContext(nodeId: NodeId, context: ContextSnapshot | undefined): void` (undefined clears it)
  - `setCompacting(nodeId: NodeId, active: boolean): void`

- [ ] **Step 1: Write the failing test**

```js
// src/renderer/src/hooks/useCanvasStore.context.test.mjs
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCanvasStoreApi, makeBlankNode } from "./useCanvasStore.ts";

const CANVAS_ID = "canvas-ctx";
function stubApi() {
  const node = makeBlankNode({ x: 0, y: 0 });
  const writes = [];
  globalThis.window = {
    api: {
      canvases: { read: async () => ({ id: CANVAS_ID, name: "C", createdAt: 1, updatedAt: 1, nodes: [node], edges: [] }), write: async (c) => { writes.push(c); } },
      settings: { read: async () => ({}), write: async (s) => s },
      canvasLock: { acquire: async () => ({ ok: true }), release: async () => {}, takeOver: async () => {} },
    },
    dispatchEvent: () => true,
  };
  return { nodeId: node.id, writes };
}

describe("context in the canvas store", () => {
  let store;
  beforeEach(() => { store = createCanvasStoreApi(); });
  afterEach(() => store.getState().releaseLock());

  test("setNodeContext stores the snapshot on the node and saves it", async () => {
    const { nodeId, writes } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    const context = { tokens: 42_000, window: 1_000_000, autoCompactEnabled: true, exact: true, measuredAt: 1 };
    store.getState().setNodeContext(nodeId, context);
    expect(store.getState().nodes[nodeId].data.context).toEqual(context);
    await store.getState().save();
    expect(writes.at(-1).nodes[0].data.context).toEqual(context);
  });

  test("clearing the size (a node re-running) removes it, so a failed measurement shows an estimate", async () => {
    const { nodeId } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setNodeContext(nodeId, { tokens: 5, window: 10, autoCompactEnabled: true, exact: true, measuredAt: 1 });
    store.getState().setNodeContext(nodeId, undefined);
    expect("context" in store.getState().nodes[nodeId].data).toBe(false);
  });

  test("compacting state is per node and never saved", async () => {
    const { nodeId, writes } = stubApi();
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setCompacting(nodeId, true);
    expect(store.getState().compactingNodeIds[nodeId]).toBe(true);
    store.getState().setNodeContext(nodeId, { tokens: 1, window: 2, autoCompactEnabled: false, exact: true, measuredAt: 1 });
    await store.getState().save();
    expect(JSON.stringify(writes.at(-1))).not.toContain("compacting");
    store.getState().setCompacting(nodeId, false);
    expect(store.getState().compactingNodeIds[nodeId]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/renderer/src/hooks/useCanvasStore.context.test.mjs`
Expected: FAIL, `setNodeContext is not a function`.

- [ ] **Step 3: Implement the store actions**

In the store's state type, add:

```ts
  /** Nodes Claude Code is compacting right now (not saved). */
  compactingNodeIds: Record<NodeId, true>;
  setNodeContext: (nodeId: NodeId, context: ContextSnapshot | undefined) => void;
  setCompacting: (nodeId: NodeId, active: boolean) => void;
```

Initial state: `compactingNodeIds: {},`. Implementations, next to `setProviderSession`:

```ts
      setNodeContext: (nodeId, context) => {
        set((s) => {
          const node = s.nodes[nodeId];
          if (!node) return s;
          const { context: _previous, ...rest } = node.data;
          const data = context ? { ...rest, context } : rest;
          return { nodes: { ...s.nodes, [nodeId]: { ...node, data } } };
        });
        get().markDirty();
      },

      setCompacting: (nodeId, active) => {
        set((s) => {
          if (active) return { compactingNodeIds: { ...s.compactingNodeIds, [nodeId]: true as const } };
          const { [nodeId]: _done, ...rest } = s.compactingNodeIds;
          return { compactingNodeIds: rest };
        });
      },
```

Import `ContextSnapshot` from `@shared/types`. Make sure `loadCanvas` resets `compactingNodeIds: {}` wherever it resets transient state.

- [ ] **Step 4: Handle the events in `useNodeChat.ts`**

Inside the `switch (ev.type)`, add:

```ts
          case "compacting":
            s.setCompacting(nodeId, ev.active);
            return;
          case "compacted": {
            nextStepsStreamer.flush();
            flushText();
            flushThinking();
            const block: CompactionBlock = {
              type: "compaction",
              trigger: ev.trigger,
              before: ev.before,
              after: ev.after,
              ...(ev.method ? { method: ev.method } : {}),
            };
            s.appendBlock(nodeId, asstMsgId, block);
            s.setCompacting(nodeId, false);
            return;
          }
          case "context":
            s.setNodeContext(nodeId, ev.context);
            return;
```

Also call `s.setCompacting(nodeId, false)` in `cleanup()`, so the indicator can never stick. Import `CompactionBlock` from `@shared/types`.

When a run starts, clear the node's old size, so a failed measurement falls back to an estimate instead of a stale exact number. Add `storeApi.getState().setNodeContext(nodeId, undefined);` right before the `window.api.chat.start(...)` call in the submit path.

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun test src/renderer/src/hooks/useCanvasStore.context.test.mjs` and `bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/hooks/useCanvasStore.ts src/renderer/src/hooks/useNodeChat.ts src/renderer/src/hooks/useCanvasStore.context.test.mjs
git commit -m "feat(context): keep each node's measured size and live compaction state"
```

---

### Task 6: The badge, the bar, and the compaction divider

**Files:**
- Create: `src/renderer/src/components/Canvas/ContextBadge.tsx`, `src/renderer/src/components/Canvas/ContextBar.tsx`
- Modify: `src/renderer/src/components/Canvas/CustomNode.tsx` (badge after `ClaudeEffortBadge`; bar inside the card; pass `compacting` to `NodeResponse`)
- Modify: `src/renderer/src/components/NodePanel/NodePanelComposer.tsx` (badge after `ClaudeEffortBadge`)
- Modify: `src/renderer/src/components/Canvas/NodeResponse.tsx` (render `compaction` blocks; indicator text while compacting)

**Interfaces:**
- Consumes: `contextView`, `contextLabel`, `formatTokens`, `compactionText` (Task 2); store `compactingNodeIds` (Task 5); `useCanvasStore` selectors `getEffectiveProvider`, `nodes`.
- Produces:
  - `ContextBadge({ nodeId, popoverSide })`. Its panel body has an `actions` slot, which Task 8 fills.
  - `ContextBar({ nodeId })`.
  - `NodeResponse` accepts `compacting?: boolean`.

This task is UI only. Its logic is covered by Task 2's tests, and its gate is typecheck plus the visual check in Task 11.

- [ ] **Step 1: `ContextBadge.tsx`**

```tsx
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
  const view = useMemo(() => contextView(nodeId, nodes), [nodeId, nodes]);
  if (provider !== "claude" || !view) return null;

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
```

- [ ] **Step 2: `ContextBar.tsx`**

```tsx
import { useMemo } from "react";
import clsx from "clsx";
import type { NodeId } from "@shared/types";
import { contextView } from "@shared/contextSize";
import { useCanvasStore } from "@/hooks/useCanvasStore";

/** A 2px bar along the node's bottom edge: root→here against the model's window. */
export function ContextBar({ nodeId }: { nodeId: NodeId }) {
  const provider = useCanvasStore((s) => s.getEffectiveProvider(nodeId));
  const nodes = useCanvasStore((s) => s.nodes);
  const view = useMemo(() => contextView(nodeId, nodes), [nodeId, nodes]);
  if (provider !== "claude" || !view) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden rounded-b-[inherit] bg-transparent">
      <div
        className={clsx(
          "h-full transition-[width] duration-300",
          view.level === "full" ? "bg-red-500" : view.level === "warn" ? "bg-amber-500" : "bg-foreground/25",
        )}
        style={{ width: `${Math.min(100, Math.round(view.percent * 100))}%` }}
      />
    </div>
  );
}
```

- [ ] **Step 3: Mount them**

In `CustomNode.tsx`:
- after `<ClaudeEffortBadge nodeId={id} />`, add `<ContextBadge nodeId={id} />`;
- inside the node card's root element, which already has `position: relative` (check; add `relative` if not), add `<ContextBar nodeId={id} />` as its last child;
- read `const compacting = useCanvasStore((s) => s.compactingNodeIds[id] === true);` and pass `compacting={compacting}` to every `<NodeResponse … />`.

In `NodePanelComposer.tsx`, after `<ClaudeEffortBadge nodeId={parentId} popoverSide="top" />`, add `<ContextBadge nodeId={parentId} popoverSide="top" />`.

- [ ] **Step 4: Render compaction blocks and the indicator text in `NodeResponse.tsx`**

- In the grouping helper's item union, add `| { kind: "compaction"; block: CompactionBlock; key: string }`. In `blocks.forEach`, add `else if (b.type === "compaction") { items.push({ kind: "compaction", block: b, key: \`c-${i}\` }); }` after the `thinking` branch.
- Where items render, add:

```tsx
            {item.kind === "compaction" && (
              <div key={item.key} className="my-2 flex items-center gap-2 text-[9px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>{compactionText(item.block)}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
```

- Add `compacting?: boolean` to `Props`. Pass `label={compacting ? "Compacting conversation…" : undefined}` to `GeneratingIndicator`. Extend `GeneratingIndicator` with an optional `label` prop that replaces its "Generating response…" text when set.
- Imports: `compactionText` from `@shared/contextSize`, `CompactionBlock` from `@shared/types`.

- [ ] **Step 5: Typecheck and build**

Run: `bun run typecheck && bun run build`
Expected: clean; `✓ built`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/Canvas/ContextBadge.tsx src/renderer/src/components/Canvas/ContextBar.tsx src/renderer/src/components/Canvas/CustomNode.tsx src/renderer/src/components/NodePanel/NodePanelComposer.tsx src/renderer/src/components/Canvas/NodeResponse.tsx
git commit -m "feat(context): context badge, fill bar and compaction divider on nodes"
```

---

### Task 7: Compaction runner and the `chat:compact` channel

**Files:**
- Create: `src/main/claude/compaction.ts`
- Test: `src/main/claude/compaction.test.mjs`
- Modify: `src/shared/ipc.ts` (`CompactArgs`, `CompactResult`, `LmcApi.chat.compact`)
- Modify: `src/main/index.ts` (handler, `"shared"`, lock-checked)
- Modify: `src/preload/index.ts`, `src/renderer/src/lib/webBridge.ts` (`chat.compact`)

**Interfaces:**
- Consumes: `heldOpenPrompt`, `measureContext`, `mapSystemMessage` (Task 3); `resolveClaudeRun`, `claudeModels`, `claudeExecutable`, `claudeBinPathOf`, `canvasLocks.canWrite`, `CANVAS_LOCKED_MESSAGE` (existing).
- Produces:
  - `type CompactArgs = { canvasId: string; nodeId: string; mode: "inPlace" | "summaryNode"; focus?: string; session: ProviderSessionRef; model?: string; cwd?: string }`
  - `type CompactResult = { sessionId: string; before: number | null; after: number | null; summary: string | null; context: ContextSnapshot | null; usage?: UsageSummary }`
  - `LmcApi.chat.compact(args: CompactArgs): Promise<CompactResult>`
  - `runCompaction(req: CompactionRequest): Promise<CompactResult>`, where `CompactionRequest = { executable?: string; sessionId: string; fork: boolean; focus?: string; model?: string; cwd: string; queryFn?: typeof query; timeoutMs?: number }`
  - `compactFocus(raw: unknown): string | undefined`: one line, at most 500 characters, otherwise undefined

- [ ] **Step 1: Write the failing test**

```js
// src/main/claude/compaction.test.mjs
import { describe, expect, test } from "bun:test";
import { compactFocus, runCompaction } from "./compaction.ts";

function fakeQuery(messages, { usage, summary } = {}) {
  const seen = {};
  const queryFn = ({ prompt, options }) => {
    seen.options = options;
    seen.prompt = prompt;
    async function* stream() {
      if (summary !== undefined) await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: "PostCompact", trigger: "manual", compact_summary: summary }, undefined, { signal: new AbortController().signal });
      for (const m of messages) yield m;
    }
    const it = stream();
    return Object.assign(it, { getContextUsage: async () => usage });
  };
  return { queryFn, seen };
}

const BOUNDARY = { type: "system", subtype: "compact_boundary", session_id: "s2", compact_metadata: { trigger: "manual", pre_tokens: 412_000, post_tokens: 38_000 } };
const RESULT = { type: "result", subtype: "success", is_error: false, session_id: "s2", result: "", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 };
const USAGE = { totalTokens: 38_500, maxTokens: 1_000_000, isAutoCompactEnabled: true, categories: [] };

describe("runCompaction", () => {
  test("compacts a fork with the focus and returns the new session, sizes, summary and context", async () => {
    const { queryFn, seen } = fakeQuery([BOUNDARY, RESULT], { usage: USAGE, summary: "We decided X." });
    const out = await runCompaction({ sessionId: "s1", fork: true, focus: "keep X", cwd: "/tmp", queryFn });
    expect(out).toMatchObject({ sessionId: "s2", before: 412_000, after: 38_000, summary: "We decided X." });
    expect(out.context.tokens).toBe(38_500);
    expect(out.usage.totalCostUsd).toBe(0.01);
    expect(seen.options).toMatchObject({ resume: "s1", forkSession: true, cwd: "/tmp" });
    const first = await seen.prompt[Symbol.asyncIterator]().next();
    expect(first.value.message.content).toBe("/compact keep X");
  });

  test("in place resumes without forking", async () => {
    const { queryFn, seen } = fakeQuery([BOUNDARY, RESULT], { usage: USAGE });
    const out = await runCompaction({ sessionId: "s1", fork: false, cwd: "/tmp", queryFn });
    expect(seen.options.forkSession).toBeUndefined();
    expect(out.summary).toBeNull();
  });

  test("fails clearly when Claude Code didn't compact", async () => {
    const { queryFn } = fakeQuery([RESULT], { usage: USAGE });
    await expect(runCompaction({ sessionId: "s1", fork: false, cwd: "/tmp", queryFn })).rejects.toThrow("didn't compact");
  });

  test("fails with Claude Code's error text on an error result", async () => {
    const { queryFn } = fakeQuery([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Not enough messages to compact"] }]);
    await expect(runCompaction({ sessionId: "s1", fork: false, cwd: "/tmp", queryFn })).rejects.toThrow("Not enough messages to compact");
  });
});

describe("compactFocus", () => {
  test("keeps one short line", () => {
    expect(compactFocus("  keep the API decisions ")).toBe("keep the API decisions");
    expect(compactFocus("a\nb")).toBe("a b");
    expect(compactFocus("x".repeat(501))).toBeUndefined();
    expect(compactFocus("")).toBeUndefined();
    expect(compactFocus(7)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/claude/compaction.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/main/claude/compaction.ts`**

```ts
import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CompactResult } from "@shared/ipc";
import { normalizeUsage } from "../agents/usage";
import { measureContext } from "./contextUsage";
import { heldOpenPrompt } from "./heldOpenPrompt";
import { mapSystemMessage } from "./systemEvents";

const COMPACTION_TIMEOUT_MS = 10 * 60_000;
const MAX_FOCUS_CHARS = 500;

export type CompactionRequest = {
  executable?: string;
  sessionId: string;
  fork: boolean;
  focus?: string;
  model?: string;
  cwd: string;
  queryFn?: typeof query;
  timeoutMs?: number;
};

export function compactFocus(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > 0 && line.length <= MAX_FOCUS_CHARS ? line : undefined;
}

/** Runs Claude Code's /compact on a session (in place, or on a fork) and reports what changed. */
export async function runCompaction(req: CompactionRequest): Promise<CompactResult> {
  const queryFn = req.queryFn ?? query;
  const controller = new AbortController();
  let summary: string | null = null;
  const onPostCompact: HookCallback = async (input) => {
    if (input.hook_event_name === "PostCompact") summary = input.compact_summary;
    return {};
  };
  const held = heldOpenPrompt({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: req.focus ? `/compact ${req.focus}` : "/compact" },
  });
  const session = queryFn({
    prompt: held.input,
    options: {
      pathToClaudeCodeExecutable: req.executable,
      cwd: req.cwd,
      model: req.model,
      resume: req.sessionId,
      ...(req.fork ? { forkSession: true } : {}),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project"],
      hooks: { PostCompact: [{ hooks: [onPostCompact] }] },
      abortController: controller,
    },
  });
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? COMPACTION_TIMEOUT_MS);
  let sessionId = req.sessionId;
  let before: number | null = null;
  let after: number | null = null;
  let compacted = false;
  try {
    for await (const msg of session as AsyncIterable<SDKMessage>) {
      const id = (msg as { session_id?: unknown }).session_id;
      if (typeof id === "string" && id.length > 0) sessionId = id;
      const event = mapSystemMessage(msg);
      if (event?.kind === "compacted") {
        compacted = true;
        before = event.before;
        after = event.after;
      }
      if (msg.type === "result") {
        if (msg.is_error || msg.subtype !== "success") {
          const errors = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("\n") : msg.subtype;
          throw new Error(errors || "Compaction failed");
        }
        if (!compacted) throw new Error("Claude Code didn't compact this session.");
        const context = await measureContext(session);
        const usage = normalizeUsage((msg as { usage?: unknown }).usage, {
          totalCostUsd: (msg as { total_cost_usd?: unknown }).total_cost_usd,
        });
        return { sessionId, before, after, summary, context, ...(usage ? { usage } : {}) };
      }
    }
    throw new Error("Claude Code ended before compacting.");
  } finally {
    clearTimeout(timer);
    held.release();
    controller.abort();
  }
}
```

If Task 1 showed the fork's new session id only appears on later messages, the "last seen `session_id`" rule above already covers it. Keep it.

- [ ] **Step 4: Add the API surface**

In `src/shared/ipc.ts`, add `ContextSnapshot` to the type import (if Task 4 hasn't already), plus:

```ts
export type CompactArgs = {
  canvasId: string;
  nodeId: string;
  mode: "inPlace" | "summaryNode";
  focus?: string;
  session: ProviderSessionRef;
  model?: string;
  cwd?: string;
};

export type CompactResult = {
  sessionId: string;
  before: number | null;
  after: number | null;
  summary: string | null;
  context: ContextSnapshot | null;
  /** The compaction call's own token use and cost. */
  usage?: UsageSummary;
};
```

In `LmcApi.chat`, add: `/** Runs Claude Code's /compact on a node's session, in place or as a summary fork. */ compact(args: CompactArgs): Promise<CompactResult>;`

- preload: `compact: (args: CompactArgs) => ipcRenderer.invoke("chat:compact", args),`
- webBridge `chat`: `compact: (args) => call("chat:compact", args),`

- [ ] **Step 5: Register the channel in `index.ts`**

Next to `chat:cancelForNode`:

```ts
  api.handle(
    "chat:compact",
    async (client, args: CompactArgs): Promise<CompactResult> => {
      if (!canvasLocks.canWrite(args.canvasId, client)) throw new Error(CANVAS_LOCKED_MESSAGE);
      const session = args.session;
      if (session?.provider !== "claude" || typeof session.id !== "string" || session.id.length === 0) {
        throw new Error("This node has no Claude session to compact.");
      }
      const settings = await readSettings();
      const binPath = claudeBinPathOf(settings);
      const run = resolveClaudeRun({
        nodeModel: args.model,
        settingsModel: settings.providers?.claude?.model,
        legacyModel: settings.claudeModel,
        models: await claudeModels.modelsWithin(binPath, CLAUDE_MODEL_LIST_BUDGET_MS),
      });
      const result = await runCompaction({
        executable: claudeExecutable(binPath),
        sessionId: session.id,
        fork: args.mode === "summaryNode",
        focus: compactFocus(args.focus),
        model: run.model,
        cwd: typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : homedir(),
      });
      if (result.context) void modelWindows?.learn(result.context.model, result.context.window).catch(() => undefined);
      return result;
    },
    "shared",
  );
```

Imports: `runCompaction, compactFocus` from `./claude/compaction`; `CompactArgs, CompactResult` from `@shared/ipc`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `bun test src/main/claude/compaction.test.mjs` and `bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/claude/compaction.ts src/main/claude/compaction.test.mjs src/shared/ipc.ts src/main/index.ts src/preload/index.ts src/renderer/src/lib/webBridge.ts
git commit -m "feat(context): compact a node's Claude session in place or on a fork"
```

---

### Task 8: Compact actions in the UI, and the Summary node

**Files:**
- Create: `src/renderer/src/lib/compactNode.ts`
- Test: `src/renderer/src/lib/compactNode.test.mjs`
- Modify: `src/renderer/src/hooks/useCanvasStore.ts` (action `createSummaryNode`)
- Modify: `src/renderer/src/components/Canvas/ContextBadge.tsx` (actions with Focus input), `src/renderer/src/components/Canvas/CustomNode.tsx` (pass `actions`), `src/renderer/src/components/Canvas/ContextMenu.tsx` (two items)

**Interfaces:**
- Consumes: `LmcApi.chat.compact`, `CompactResult` (Task 7); store `setCompacting`, `setNodeContext`, `setProviderSession`, `appendBlock`, `getEffectiveCwd`, `lock`, `compactingNodeIds`, `save` (existing and Task 5); `keyboardBranchPosition` (existing `lib/childPlacement`).
- Produces:
  - `createSummaryNode(parentId: NodeId, input: { summary: string; sessionId: string; context: ContextSnapshot | null; before: number | null; after: number | null; usage?: UsageSummary }): NodeId | null`
  - `compactNode(deps: { store: CanvasStoreApi; compact: LmcApi["chat"]["compact"] }, args: { canvasId: string; nodeId: NodeId; mode: "inPlace" | "summaryNode"; focus?: string }): Promise<{ ok: true; summaryNodeId?: NodeId } | { ok: false; error: string }>`
  - `canCompact(state: CanvasStoreState, nodeId: NodeId): boolean`
  - `SUMMARY_FALLBACK_TEXT`

- [ ] **Step 1: Write the failing test**

```js
// src/renderer/src/lib/compactNode.test.mjs
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCanvasStoreApi, makeBlankNode } from "../hooks/useCanvasStore.ts";
import { SUMMARY_FALLBACK_TEXT, canCompact, compactNode } from "./compactNode.ts";

const CANVAS_ID = "canvas-compact";
function setup() {
  const node = makeBlankNode({ x: 0, y: 0 });
  node.data.chat.providerSession = { provider: "claude", id: "s1" };
  node.data.chat.messages = [
    { id: "u", role: "user", createdAt: 1, blocks: [{ type: "text", text: "hi" }] },
    { id: "a", role: "assistant", createdAt: 2, status: "complete", provider: "claude", blocks: [{ type: "text", text: "hello" }] },
  ];
  globalThis.window = {
    api: {
      canvases: { read: async () => ({ id: CANVAS_ID, name: "C", createdAt: 1, updatedAt: 1, nodes: [node], edges: [] }), write: async () => {} },
      settings: { read: async () => ({}), write: async (s) => s },
      canvasLock: { acquire: async () => ({ ok: true }), release: async () => {}, takeOver: async () => {} },
    },
    dispatchEvent: () => true,
  };
  return node.id;
}
const CONTEXT = { tokens: 38_000, window: 1_000_000, autoCompactEnabled: true, exact: true, measuredAt: 1 };

describe("compactNode", () => {
  let store;
  beforeEach(() => { store = createCanvasStoreApi(); });
  afterEach(() => store.getState().releaseLock());

  test("in place: new session, divider on the reply, new size", async () => {
    const nodeId = setup();
    await store.getState().loadCanvas(CANVAS_ID);
    const calls = [];
    const compact = async (args) => { calls.push(args); return { sessionId: "s1", before: 412_000, after: 38_000, summary: null, context: CONTEXT }; };
    const out = await compactNode({ store, compact }, { canvasId: CANVAS_ID, nodeId, mode: "inPlace", focus: "keep X" });
    expect(out).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ canvasId: CANVAS_ID, nodeId, mode: "inPlace", focus: "keep X", session: { provider: "claude", id: "s1" } });
    const node = store.getState().nodes[nodeId];
    expect(node.data.context).toEqual(CONTEXT);
    expect(node.data.chat.messages[1].blocks.at(-1)).toEqual({ type: "compaction", trigger: "manual", before: 412_000, after: 38_000 });
    expect(store.getState().compactingNodeIds[nodeId]).toBeUndefined();
  });

  test("summary node: a child with the summary, the fork's session and its size", async () => {
    const nodeId = setup();
    await store.getState().loadCanvas(CANVAS_ID);
    const compact = async () => ({ sessionId: "s2", before: 412_000, after: 38_000, summary: "We decided X.", context: CONTEXT });
    const out = await compactNode({ store, compact }, { canvasId: CANVAS_ID, nodeId, mode: "summaryNode" });
    const child = store.getState().nodes[out.summaryNodeId];
    expect(child.data.chat.parentIds).toEqual([nodeId]);
    expect(child.data.chat.providerSession).toEqual({ provider: "claude", id: "s2" });
    expect(child.data.context).toEqual(CONTEXT);
    expect(child.data.chat.messages[0].blocks[0].text).toBe("Continue from summary");
    expect(child.data.chat.messages[1].blocks).toEqual([
      { type: "compaction", trigger: "manual", before: 412_000, after: 38_000 },
      { type: "text", text: "We decided X." },
    ]);
    expect(store.getState().nodes[nodeId].data.chat.providerSession.id).toBe("s1");
  });

  test("uses the fallback text when no summary was captured", async () => {
    const nodeId = setup();
    await store.getState().loadCanvas(CANVAS_ID);
    const out = await compactNode({ store, compact: async () => ({ sessionId: "s2", before: null, after: null, summary: null, context: null }) }, { canvasId: CANVAS_ID, nodeId, mode: "summaryNode" });
    expect(store.getState().nodes[out.summaryNodeId].data.chat.messages[1].blocks.at(-1)).toEqual({ type: "text", text: SUMMARY_FALLBACK_TEXT });
  });

  test("refuses while the node is busy, and reports a failed compaction without changing anything", async () => {
    const nodeId = setup();
    await store.getState().loadCanvas(CANVAS_ID);
    store.getState().setCompacting(nodeId, true);
    expect(canCompact(store.getState(), nodeId)).toBe(false);
    const neverCalled = async () => { throw new Error("should not be called"); };
    expect(await compactNode({ store, compact: neverCalled }, { canvasId: CANVAS_ID, nodeId, mode: "inPlace" })).toEqual({ ok: false, error: "This node is busy." });
    store.getState().setCompacting(nodeId, false);

    const before = JSON.stringify(store.getState().nodes[nodeId]);
    const out = await compactNode({ store, compact: async () => { throw new Error("Not enough messages to compact"); } }, { canvasId: CANVAS_ID, nodeId, mode: "inPlace" });
    expect(out).toEqual({ ok: false, error: "Couldn't compact: Not enough messages to compact" });
    expect(JSON.stringify(store.getState().nodes[nodeId])).toBe(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/renderer/src/lib/compactNode.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Add `createSummaryNode` to the store**

```ts
      createSummaryNode: (parentId, input) => {
        const parent = get().nodes[parentId];
        if (!parent) return null;
        const child = makeBlankNode(keyboardBranchPosition(parent), parentId);
        const now = Date.now();
        const summaryNode: CanvasNode = {
          ...child,
          data: {
            ...child.data,
            title: "Summary",
            ...(parent.data.nodeSettings ? { nodeSettings: { ...parent.data.nodeSettings } } : {}),
            ...(input.context ? { context: input.context } : {}),
            chat: {
              ...child.data.chat,
              providerSession: { provider: "claude", id: input.sessionId },
              messages: [
                { id: `${child.id}-u`, role: "user", createdAt: now, blocks: [{ type: "text", text: "Continue from summary" }] },
                {
                  id: `${child.id}-a`,
                  role: "assistant",
                  createdAt: now,
                  status: "complete",
                  provider: "claude",
                  ...(input.usage ? { usage: input.usage } : {}),
                  blocks: [
                    { type: "compaction", trigger: "manual", before: input.before, after: input.after },
                    { type: "text", text: input.summary },
                  ],
                },
              ],
            },
          },
        };
        get().addNode(summaryNode);
        get().connectEdge(parentId, summaryNode.id);
        return summaryNode.id;
      },
```

Add the signature to the state type: `createSummaryNode: (parentId: NodeId, input: { summary: string; sessionId: string; context: ContextSnapshot | null; before: number | null; after: number | null; usage?: UsageSummary }) => NodeId | null;`. Import `keyboardBranchPosition` from `@/lib/childPlacement`.

- [ ] **Step 4: Implement `src/renderer/src/lib/compactNode.ts`**

```ts
import type { CompactResult, LmcApi } from "@shared/ipc";
import type { NodeId } from "@shared/types";
import type { CanvasStoreApi, CanvasStoreState } from "@/hooks/useCanvasStore";

export const SUMMARY_FALLBACK_TEXT = "Claude compacted this branch, but its summary text isn't available.";

type CompactMode = "inPlace" | "summaryNode";
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
): Promise<{ ok: true; summaryNodeId?: NodeId } | { ok: false; error: string }> {
  const state = deps.store.getState();
  const node = state.nodes[args.nodeId];
  const session = node?.data.chat.providerSession;
  if (!node || !session || !canCompact(state, args.nodeId)) return { ok: false, error: "This node is busy." };

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
    deps.store.getState().setCompacting(args.nodeId, false);
    return { ok: false, error: `Couldn't compact: ${error instanceof Error ? error.message : String(error)}` };
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
    });
  }
  if (result.context) s.setNodeContext(args.nodeId, result.context);
  void s.save();
  return { ok: true };
}
```

`CanvasStoreApi` and `CanvasStoreState` are already exported from `useCanvasStore.ts`.

- [ ] **Step 5: Wire the actions**

- **`ContextBadge`'s `actions` slot.** `CustomNode.tsx` passes a render function. It shows a Focus `<input>` (one line, `maxLength={500}`, placeholder "Focus (optional), e.g. keep the API decisions") and two buttons: **Compact this node** and **Continue from summary**.
  - Both are disabled unless `canCompact(store.getState(), id)`.
  - Each calls `compactNode({ store: storeApi, compact: window.api.chat.compact }, { canvasId, nodeId: id, mode, focus })`, then `close()`. When the result isn't ok, it shows the error in red text under the buttons.
  - After a summary node is created, select it (`setSelectedNodeId(summaryNodeId)`) so the side panel and camera follow the existing selection behaviour.
- **Right-click menu.** In `ContextMenu.tsx`, add two options when the right-clicked node is a Claude node with a session: **Compact this node** and **Continue from summary**. Each calls `compactNode` with no focus. Keep the existing options' order, and put these after "Add child node".

- [ ] **Step 6: Run the tests, typecheck and build**

Run: `bun test src/renderer/src/lib/compactNode.test.mjs`, `bun run typecheck`, `bun run build`
Expected: PASS; clean; `✓ built`.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/compactNode.ts src/renderer/src/lib/compactNode.test.mjs src/renderer/src/hooks/useCanvasStore.ts src/renderer/src/components/Canvas/ContextBadge.tsx src/renderer/src/components/Canvas/CustomNode.tsx src/renderer/src/components/Canvas/ContextMenu.tsx
git commit -m "feat(context): compact a node in place or continue from a summary node"
```

---

### Task 9: Replay auto-fit

**Files:**
- Create: `src/main/claude/replayFit.ts`, `src/main/claude/replaySummary.ts`
- Test: `src/main/claude/replayFit.test.mjs`
- Modify: `src/main/index.ts` (`chat:start`: plan the replay, summarize or trim, emit the divider event)

**Interfaces:**
- Consumes: `buildPromptWithHistory` (existing), `CHARS_PER_TOKEN`, `DEFAULT_SETUP_TOKENS`, `DEFAULT_WINDOW` (Task 2), `modelWindows` (Task 4), `heldOpenPrompt` (Task 3).
- Produces:
  - `estimateTokens(text: string): number`
  - `planReplay(input: { history: Message[]; newPrompt: string; window: number; setupTokens: number }): ReplayPlan`, where `ReplayPlan = { fits: true; estimate: number } | { fits: false; estimate: number; budget: number; olderText: string; recent: Message[] }`
  - `chunkText(text: string, maxChars: number): string[]`
  - `fittedPrompt(summary: string, recent: Message[], newPrompt: string): string`
  - `trimToFit(history: Message[], newPrompt: string, budgetTokens: number): string`
  - `summarizeForReplay(text: string, opts: { executable?: string; model?: string; cwd: string; window: number }): Promise<string>`

- [ ] **Step 1: Write the failing test**

```js
// src/main/claude/replayFit.test.mjs
import { describe, expect, test } from "bun:test";
import { chunkText, estimateTokens, fittedPrompt, planReplay, trimToFit } from "./replayFit.ts";

const msg = (role, chars, tag = role) => ({ id: `${tag}-${chars}`, role, createdAt: 1, blocks: [{ type: "text", text: tag[0].repeat(chars) }] });

describe("planReplay", () => {
  test("a small history fits as-is", () => {
    const plan = planReplay({ history: [msg("user", 400), msg("assistant", 400)], newPrompt: "next", window: 200_000, setupTokens: 20_000 });
    expect(plan.fits).toBe(true);
  });

  test("a big history keeps recent messages verbatim within half the budget and hands back the older text", () => {
    const history = [msg("user", 400_000, "old-u"), msg("assistant", 400_000, "old-a"), msg("user", 40_000, "new-u"), msg("assistant", 40_000, "new-a")];
    const plan = planReplay({ history, newPrompt: "next", window: 200_000, setupTokens: 20_000 });
    expect(plan.fits).toBe(false);
    expect(plan.budget).toBe(140_000);
    expect(plan.recent.map((m) => m.id)).toEqual(["new-u-40000", "new-a-40000"]);
    expect(plan.olderText).toContain("[User]");
    expect(plan.olderText.length).toBeGreaterThan(790_000);
  });

  test("cuts a single oversized message instead of sending or dropping it whole", () => {
    const plan = planReplay({ history: [msg("user", 2_000_000, "giant")], newPrompt: "next", window: 200_000, setupTokens: 20_000 });
    expect(plan.fits).toBe(false);
    expect(plan.recent).toEqual([]);
    expect(estimateTokens(trimToFit([msg("user", 2_000_000, "giant")], "next", plan.budget))).toBeLessThanOrEqual(plan.budget);
  });
});

describe("chunkText / fittedPrompt / trimToFit", () => {
  test("chunks at section boundaries within the limit", () => {
    const text = ["[User]\n" + "a".repeat(50), "[Assistant]\n" + "b".repeat(50), "[User]\n" + "c".repeat(50)].join("\n\n");
    const chunks = chunkText(text, 130);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= 130)).toBe(true);
    expect(chunks.join("\n\n")).toBe(text);
  });

  test("fittedPrompt puts the summary first, then the recent messages and the new prompt", () => {
    const prompt = fittedPrompt("We decided X.", [msg("user", 3, "recent")], "next");
    expect(prompt.startsWith("[Summary of the earlier conversation]\nWe decided X.")).toBe(true);
    expect(prompt).toContain("[User]\nrrr");
    expect(prompt.endsWith("[User]\nnext\n\n[Assistant]")).toBe(true);
  });

  test("trimToFit drops the oldest messages first and keeps the new prompt", () => {
    const history = [msg("user", 400_000, "old"), msg("assistant", 4_000, "kept")];
    const prompt = trimToFit(history, "next", 50_000);
    expect(prompt).not.toContain("o".repeat(100));
    expect(prompt).toContain("k".repeat(100));
    expect(prompt.endsWith("[User]\nnext\n\n[Assistant]")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/claude/replayFit.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/main/claude/replayFit.ts`**

```ts
import type { Message } from "@shared/types";
import { CHARS_PER_TOKEN } from "@shared/contextSize";
import { blocksToPlainText } from "@shared/history";
import { buildPromptWithHistory } from "./history";

const REPLY_HEADROOM = 0.2;
const RECENT_SHARE = 0.5;

export type ReplayPlan =
  | { fits: true; estimate: number }
  | { fits: false; estimate: number; budget: number; olderText: string; recent: Message[] };

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const sectionOf = (m: Message): string => {
  const text = blocksToPlainText(m.blocks);
  return text ? `[${m.role === "user" ? "User" : "Assistant"}]\n${text}` : "";
};

/** Whether a replayed branch fits the window; if not, which recent messages stay verbatim. */
export function planReplay(input: { history: Message[]; newPrompt: string; window: number; setupTokens: number }): ReplayPlan {
  const estimate = estimateTokens(buildPromptWithHistory(input.history, input.newPrompt)) + input.setupTokens;
  const budget = Math.floor(input.window * (1 - REPLY_HEADROOM)) - input.setupTokens;
  if (estimate <= input.setupTokens + budget) return { fits: true, estimate };
  const recentBudget = Math.floor(budget * RECENT_SHARE);
  let used = 0;
  let split = input.history.length;
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(sectionOf(input.history[i]));
    if (used + cost > recentBudget) break;
    used += cost;
    split = i;
  }
  const older = input.history.slice(0, split);
  return {
    fits: false,
    estimate,
    budget,
    olderText: older.map(sectionOf).filter(Boolean).join("\n\n"),
    recent: input.history.slice(split),
  };
}

/** Splits text into chunks of at most `maxChars`, at "\n\n[" section boundaries where possible. */
export function chunkText(text: string, maxChars: number): string[] {
  const sections = text.split(/\n\n(?=\[)/);
  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    const pieces = section.length > maxChars ? section.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, "g")) ?? [] : [section];
    for (const piece of pieces) {
      const joined = current ? `${current}\n\n${piece}` : piece;
      if (joined.length <= maxChars) {
        current = joined;
      } else {
        if (current) chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function fittedPrompt(summary: string, recent: Message[], newPrompt: string): string {
  return `[Summary of the earlier conversation]\n${summary}\n\n${buildPromptWithHistory(recent, newPrompt)}`;
}

/** Drops the oldest messages (cutting the oldest kept one if needed) until the prompt fits. */
export function trimToFit(history: Message[], newPrompt: string, budgetTokens: number): string {
  for (let start = 0; start < history.length; start += 1) {
    const prompt = buildPromptWithHistory(history.slice(start), newPrompt);
    if (estimateTokens(prompt) <= budgetTokens) return prompt;
  }
  const bare = buildPromptWithHistory([], newPrompt);
  const room = Math.max(0, budgetTokens * CHARS_PER_TOKEN - bare.length - 64);
  const last = history.at(-1);
  if (!last || room === 0) return bare;
  const tail = sectionOf(last).slice(-room);
  return `[Earlier message, cut to fit]\n${tail}\n\n${bare}`;
}
```

- [ ] **Step 4: Implement `src/main/claude/replaySummary.ts`**

```ts
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CHARS_PER_TOKEN } from "@shared/contextSize";
import { heldOpenPrompt } from "./heldOpenPrompt";
import { chunkText } from "./replayFit";

const SUMMARY_SYSTEM_PROMPT =
  "You summarize an earlier part of a conversation so it can continue with less context. Keep decisions, facts, names, numbers, open questions and the user's goals. Write plain prose, no preamble.";
const CHUNK_SHARE = 0.6;

async function summarizeOnce(text: string, opts: { executable?: string; model?: string; cwd: string }): Promise<string> {
  const held = heldOpenPrompt({ type: "user", parent_tool_use_id: null, message: { role: "user", content: `Summarize this earlier conversation:\n\n${text}` } });
  const controller = new AbortController();
  const session = query({
    prompt: held.input,
    options: {
      pathToClaudeCodeExecutable: opts.executable,
      model: opts.model,
      cwd: opts.cwd,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 1,
      abortController: controller,
    },
  });
  try {
    for await (const msg of session as AsyncIterable<SDKMessage>) {
      if (msg.type === "result") {
        if (msg.subtype !== "success" || msg.is_error) throw new Error("Couldn't summarize the earlier conversation.");
        return msg.result.trim();
      }
    }
    throw new Error("Summarizing ended early.");
  } finally {
    held.release();
    controller.abort();
  }
}

/** Summarizes text that may be larger than the window: chunk, summarize each, then combine. */
export async function summarizeForReplay(
  text: string,
  opts: { executable?: string; model?: string; cwd: string; window: number },
): Promise<string> {
  const maxChars = Math.floor(opts.window * CHUNK_SHARE * CHARS_PER_TOKEN);
  const chunks = chunkText(text, maxChars);
  if (chunks.length === 1) return summarizeOnce(chunks[0], opts);
  const parts: string[] = [];
  for (const chunk of chunks) parts.push(await summarizeOnce(chunk, opts));
  const joined = parts.join("\n\n");
  return joined.length > maxChars ? summarizeForReplay(joined, opts) : joined;
}
```

- [ ] **Step 5: Use it in `chat:start`**

Make `agentPrompt` a `let`. Inside the `try` block, right after `claudeRun` is computed and before the first `runAttempt`, add:

```ts
      // Never fail on replay: a branch replayed without a Claude session is fitted to the window.
      if (provider === "claude" && !compatibleCurrentSession && !compatibleParentSession) {
        const window = modelWindows?.windowFor(claudeRun?.resolvedModel) ?? DEFAULT_WINDOW;
        const plan = planReplay({ history, newPrompt: prompt, window, setupTokens: DEFAULT_SETUP_TOKENS });
        if (!plan.fits) {
          send({ chatId, type: "compacting", active: true });
          try {
            const summary = await summarizeForReplay(plan.olderText, {
              executable: claudeExecutable(binPath),
              model: claudeRun?.model,
              cwd: effectiveCwd,
              window,
            });
            agentPrompt = fittedPrompt(summary, plan.recent, prompt);
            send({ chatId, type: "compacted", trigger: "replay", method: "summary", before: plan.estimate, after: estimateTokens(agentPrompt) + DEFAULT_SETUP_TOKENS });
          } catch (error) {
            console.warn("[context] replay summary failed; trimming instead:", error);
            agentPrompt = trimToFit(history, prompt, plan.budget);
            send({ chatId, type: "compacted", trigger: "replay", method: "trimmed", before: null, after: null });
          }
        }
      }
```

Here `history` and `prompt` are the handler's existing variables, the same ones passed to `buildPromptWithHistory`. Imports: `planReplay, fittedPrompt, trimToFit, estimateTokens` from `./claude/replayFit`; `summarizeForReplay` from `./claude/replaySummary`; `DEFAULT_WINDOW, DEFAULT_SETUP_TOKENS` from `@shared/contextSize`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `bun test src/main/claude/replayFit.test.mjs` and `bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/claude/replayFit.ts src/main/claude/replayFit.test.mjs src/main/claude/replaySummary.ts src/main/index.ts
git commit -m "feat(context): fit an oversized history replay instead of failing"
```

---

### Task 10: Compact and retry when a resumed session overflows

**Files:**
- Create: `src/main/claude/overflowRetry.ts`
- Test: `src/main/claude/overflowRetry.test.mjs`
- Modify: `src/main/index.ts` (`runAttempt` intercepts `prompt_too_long`; one compact-and-retry)

**Interfaces:**
- Consumes: `runCompaction` (Task 7); the `prompt_too_long` `ErrorCode` (Tasks 2–3).
- Produces:
  - `overflowRetryTarget(sessions: { current?: ProviderSessionRef; parent?: ProviderSessionRef }): { sessionId: string; fork: boolean } | null`
  - `isPromptTooLongEvent(ev: RunnerEvent): boolean`

- [ ] **Step 1: Write the failing test**

```js
// src/main/claude/overflowRetry.test.mjs
import { describe, expect, test } from "bun:test";
import { isPromptTooLongEvent, overflowRetryTarget } from "./overflowRetry.ts";

describe("overflowRetryTarget", () => {
  test("compacts the node's own session in place", () => {
    expect(overflowRetryTarget({ current: { provider: "claude", id: "c" }, parent: { provider: "claude", id: "p" } })).toEqual({ sessionId: "c", fork: false });
  });
  test("compacts a fork of the parent's session so the parent and its other branches stay intact", () => {
    expect(overflowRetryTarget({ parent: { provider: "claude", id: "p" } })).toEqual({ sessionId: "p", fork: true });
  });
  test("nothing to compact without a Claude session", () => {
    expect(overflowRetryTarget({})).toBeNull();
    expect(overflowRetryTarget({ current: { provider: "codex", id: "x" } })).toBeNull();
  });
});

describe("isPromptTooLongEvent", () => {
  test("matches the coded error and done events only", () => {
    expect(isPromptTooLongEvent({ kind: "error", message: "x", code: "prompt_too_long" })).toBe(true);
    expect(isPromptTooLongEvent({ kind: "done", isError: true, code: "prompt_too_long" })).toBe(true);
    expect(isPromptTooLongEvent({ kind: "error", message: "x", code: "auth_required" })).toBe(false);
    expect(isPromptTooLongEvent({ kind: "text_delta", text: "prompt is too long" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/claude/overflowRetry.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/main/claude/overflowRetry.ts`**

```ts
import type { ProviderSessionRef } from "@shared/types";
import type { RunnerEvent } from "../agents/types";

/** Which session to compact before retrying an overflowed run: the node's own in place,
 *  or a fork of its parent's so the parent and its other branches stay untouched. */
export function overflowRetryTarget(sessions: {
  current?: ProviderSessionRef;
  parent?: ProviderSessionRef;
}): { sessionId: string; fork: boolean } | null {
  if (sessions.current?.provider === "claude") return { sessionId: sessions.current.id, fork: false };
  if (sessions.parent?.provider === "claude") return { sessionId: sessions.parent.id, fork: true };
  return null;
}

export function isPromptTooLongEvent(ev: RunnerEvent): boolean {
  return (ev.kind === "error" || (ev.kind === "done" && ev.isError === true)) && ev.code === "prompt_too_long";
}
```

- [ ] **Step 4: Retry once in `chat:start`**

- **Signature:** extend `runAttempt`'s signature with a fourth parameter, `allowOverflowRetry: boolean`, and make it return `{ policyRefused: boolean; overflowed: boolean }`. Update every caller to read `.policyRefused`.
- **Intercepting the error:** inside `onEvent`, before forwarding, add:

```ts
            if (allowOverflowRetry && isPromptTooLongEvent(ev)) {
              overflowed = true;
              attemptController.abort(new Error("Compacting the session and retrying."));
              return;
            }
```

- **The first attempt:** pass `provider === "claude"` as `allowOverflowRetry`.
- **After the first attempt:** add:

```ts
      if (firstAttempt.overflowed && !controller.signal.aborted) {
        const target = overflowRetryTarget({ current: compatibleCurrentSession, parent: compatibleParentSession });
        if (!target) throw new Error("This conversation is too long for the model, and there's no session to compact.");
        send({ chatId, type: "compacting", active: true });
        const compacted = await runCompaction({
          executable: claudeExecutable(binPath),
          sessionId: target.sessionId,
          fork: target.fork,
          model: claudeRun?.model,
          cwd: effectiveCwd,
        });
        send({ chatId, type: "compacted", trigger: "auto", before: compacted.before, after: compacted.after });
        retrySession = { provider: "claude", id: compacted.sessionId };
        await runAttempt(model, claudeRun ? claudeRun.reasoningEffort : requestedEffort, false, false);
      }
```

- **The retried run resumes the compacted session:**
  - Declare `let retrySession: ProviderSessionRef | undefined;` before `runAttempt`.
  - In `runAttempt`'s `runAgent` options, use `currentSession: retrySession ?? compatibleCurrentSession` and `parentSession: retrySession ? undefined : compatibleParentSession`.
  - Use the bare `prompt` (not `agentPrompt`) when `retrySession` is set.

Imports: `overflowRetryTarget, isPromptTooLongEvent` from `./claude/overflowRetry`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun test src/main/claude/overflowRetry.test.mjs` and `bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/claude/overflowRetry.ts src/main/claude/overflowRetry.test.mjs src/main/index.ts
git commit -m "feat(context): compact and retry once when a resumed Claude session overflows"
```

---

### Task 11: README, full check, install and real-app verification

**Files:**
- Modify: `README.md` (a "Context window" bullet group under "What's different in this fork → Claude improvements", plus a "Context sizes and compaction" subsection)

- [ ] **Step 1: Document it**

Add to `README.md` under "Claude improvements":

```markdown
- **Context sizes on every node.**
  - The root shows its own size.
  - Every other node shows `+its own · root→here`, for example `+30k · 42k`.
  - A bar along the bottom edge fills against the model's window, turning amber at 70% and red at 90%.
  - Click the badge for the window, the auto-compact point, a breakdown, and how many compactions happened on the path.
  - Sizes come from Claude Code itself at the end of each run. Older nodes show `~` estimates until their next run.
- **Compaction you can see and control.**
  - When Claude Code compacts, the node shows "Compacting conversation…" and leaves a divider such as `Context compacted: 940k → 62k (auto)`.
  - **Compact this node** summarizes the node's own session in place.
  - **Continue from summary** creates a Summary node from a compacted fork. The full branch stays available.
  - Both are in the context badge and the right-click menu, with an optional focus.
- **Long branches never fail.**
  - A branch replayed without a Claude session is fitted to the model's window: older messages are summarized, or left out if summarizing fails.
  - A resumed session that still overflows is compacted and retried once.
```

- [ ] **Step 2: Run every test file and the typecheck**

```bash
for f in $(git ls-files --cached --others --exclude-standard '*.test.mjs'); do bun test "$f" >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"; done
bun run typecheck
```
Expected: every line `PASS`; typecheck clean.

- [ ] **Step 3: Build, sign and install**

```bash
rm -rf dist out && bun run build
bunx electron-builder --mac dir --arm64 --publish never -c.mac.notarize=false -c.mac.identity=null
codesign --force --deep --sign - --options runtime --entitlements build/entitlements.mac.plist dist/mac-arm64/LMCanvas.app
codesign --verify --deep --strict dist/mac-arm64/LMCanvas.app
osascript -e 'tell application "LMCanvas" to quit'; while pgrep -x LMCanvas >/dev/null; do sleep 1; done
rm -rf /Applications/LMCanvas.app && ditto dist/mac-arm64/LMCanvas.app /Applications/LMCanvas.app && open -a /Applications/LMCanvas.app
```

Before quitting, check that no chat is running (`ps` shows no `claude` child of LMCanvas).

- [ ] **Step 4: Verify in the real app, using a throwaway test chat**

1. Send a prompt, then a follow-up from its node, then another, giving three levels.
   - Expected: the root shows `<n>k`; the levels below show `+<own> · <combined>`; the bars fill; the badge panel shows the window and the breakdown.
2. On the deepest node, choose **Continue from summary** with a focus.
   - Expected: a Summary node appears with the summary text and a divider; its badge shows the smaller size; the original node is unchanged.
3. On another node, choose **Compact this node**.
   - Expected: a "Context compacted … (manual)" divider appears on its reply, and its badge drops.
4. Forced replay: temporarily change a test node's model to a non-Claude provider and back, so its child has to replay. Use a small `model-windows.json` window, set to 20,000 for the model, so the replay doesn't fit.
   - Expected: the reply carries "Earlier messages were summarized to fit: …" and succeeds.
   - Afterwards, restore `model-windows.json`.
5. Delete the test chat afterwards, and move its session files to the Trash.

Record each step's result for the user.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: context sizes, compaction and never-failing branches"
```
