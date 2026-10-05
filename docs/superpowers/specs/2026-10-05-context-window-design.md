# Context window: sizes, compaction and never failing (design)

Date: 2026-10-05 · Branch: `local/model-labels` · Provider scope: Claude only

## Intent

The user works in long, branching Claude conversations on the LMCanvas canvas. Claude Code compacts a session on its own when it nears the model's window (200k or 1M), but LMCanvas doesn't show any of this today. The user can't see how full a branch is, can't compact deliberately, and a long branch can fail.

Success means:

1. **Show it.**
   - Every node shows its own context size.
   - Every non-root node also shows the combined size from the root down to it. The root shows only its own size, which is also everything the model holds at that point.
   - Compaction is visible when it happens.
2. **Control it.** The user can compact a node in place, or continue from a summary in a new node.
3. **Never fail.** A long branch never dies with "prompt is too long".
4. **Smart branching.** "Continue from summary" uses the tree: the full-detail branch stays available.

Example of the agreed display (normal case, no compaction):

```
root      ◔ 12k            own size only
level 2   ◔ +30k · 42k     own 30k · root→here 42k
level 3   ◔ +18k · 60k     own 18k · root→here 60k
```

## Facts this design rests on

- LMCanvas runs the real Claude Code session for each node through the Agent SDK. A follow-up resumes the node's session, and a branch forks it (`resume` / `forkSession` in `src/main/claude/runner.ts`). Chats load the user and project settings, so Claude Code's own auto-compaction stays enabled.
- The runner reads only text, thinking, tool events and the final `result`. It drops system messages: `status: "compacting"` and `compact_boundary` (trigger, `pre_tokens`, `post_tokens`).
- When a node can't resume a Claude session, `chat:start` replays the branch as one text prompt (`buildPromptWithHistory`). That path has no compaction and can fail on a long branch.
- SDK 0.2.141 offers:
  - `Query.getContextUsage()`, returning `totalTokens`, `maxTokens` (the window), `percentage`, `autoCompactThreshold`, `isAutoCompactEnabled` and a per-category breakdown;
  - `PreCompact` / `PostCompact` hooks, with `compact_summary` in the PostCompact input;
  - per-model `contextWindow` in the result's `modelUsage`.
- The final `result` usage sums every API call in an agentic turn, so it overstates the context. That's why sizes come from `getContextUsage()`, not from saved message usage.

## 1. Measuring and storing sizes

- **Measuring:** at the end of every Claude run, before the session closes, the runner calls `getContextUsage()` on the live session, with a 2-second limit. It sends a `context` chat event with:
  - `tokens`;
  - `window`;
  - `autoCompactAt` (threshold) and whether auto-compact is enabled;
  - a short breakdown: setup (system prompt, tools, memory files), conversation, tool results.
- **Storing:** the node keeps `data.context = { tokens, window, autoCompactAt?, autoCompactEnabled, breakdown?, exact, measuredAt }` in the canvas file. `tokens` is the node's **combined size (root→here)**: exactly what the model holds after that node.
- **Own size** is derived, never stored:
  - root: `own = combined`. It includes Claude Code's fixed setup, typically 15–25k, and the hover says so.
  - other nodes: `own = combined − parent.combined`, floored at 0.
  - several parents (merge): `own = combined − max(parent.combined)`.
- **Branches:** a child forks its parent's session, so its combined size builds on its parent's. Siblings never count each other.
- **Estimates** (`exact: false`, shown with a leading `~`) cover nodes created before this feature, nodes that ran on another provider, and runs where `getContextUsage()` failed or timed out:
  - the path's message text at about 4 characters per token;
  - plus a setup allowance (the last measured setup size, else 20k).

  The next Claude run on that node replaces the estimate with an exact value.

## 2. Live events and display

- **New chat events:**
  - `compacting` (Claude Code is summarizing now);
  - `compacted { trigger: "auto" | "manual" | "replay", before, after }`;
  - `context` (the section 1 snapshot).
- **While a run compacts:** the generating indicator reads "Compacting conversation…".
- **Divider in the reply:** a compaction adds a divider, e.g. "── Context compacted: 940k → 62k (auto) ──". It's stored as a new content block `{ type: "compaction", trigger, before, after }` so it survives restarts.
- **Badge in the node toolbar** (and in the side-panel composer):
  - a pie icon filled to `combined / window`;
  - root: `12k`; other nodes: `+30k · 42k`; estimates: `~`.
- **Bar:** a 2-pixel bar along the node's bottom edge shows `combined / window`. The badge and the bar turn amber at 70% and red at 90%.
- **Badge panel (on click):**
  - own size, root→here, window, percentage;
  - the auto-compact point and whether it's on;
  - the breakdown;
  - the number of compactions on this path;
  - for the root, the setup note;
  - the actions from section 3.
- **Browser access:** browser tabs get all of this through the existing chat-event stream; `webBridge` needs no event-specific code.

## 3. Compacting on demand

**Where:** both actions appear in the badge panel and the node's right-click menu. Each has an optional **Focus** text, which is sent as `/compact <focus>`.

**When available:** only if the node is idle, has a Claude session, and its canvas lock is held here.

**Compact this node (in place)**
- Resumes the node's own session (no fork) with `/compact [focus]`.
- Re-measures the node, so `data.context` drops.
- Appends a manual compaction divider to the node's reply.
- Branches created afterwards start from the summary. Existing children are unaffected, because they forked earlier.

**Continue from summary (new node)**
- Forks the node's session and compacts the fork.
- Creates a child **Summary node** whose:
  - user message is the label "Continue from summary";
  - assistant message is Claude's summary text, captured with the `PostCompact` hook's `compact_summary`;
  - header reads "Summary of this branch · 412k → 38k";
  - `providerSession` is the compacted fork, and its `context` is measured.
- The user continues by branching from the Summary node. The original stays untouched.

**Both**
- **New channel:** `chat:compact` with `{ canvasId, nodeId, mode: "inPlace" | "summaryNode", focus? }`. It's scoped `"shared"`, so browser tabs can use it, and it's refused unless the caller holds the canvas lock.
- **Cost:** compaction is a real Claude call, and its usage is recorded on the node.
- **Failure:** the node shows "Couldn't compact: <reason>", and the session and canvas are unchanged.

## 4. Never failing

**Replay auto-fit:** this applies only when a node can't resume a Claude session.
- **Estimate first:** history text + setup allowance + reply headroom (20% of the window).
- **Window:** the last measured window for the model (`modelWindows`), else a safe 200k.
- **If the estimate exceeds the window:**
  1. Keep verbatim the most recent messages that fit within half the budget.
  2. Summarize the older messages with a separate Claude call, in chunks if they're larger than the window, then combine.
  3. Send "Summary of the earlier conversation" + the recent messages + the new prompt.
  4. Add a `compaction` divider with trigger `replay` ("Earlier messages were summarized to fit: 1.3M → 180k").
- The node then has a real Claude session that contains the summary, so its children resume it and never replay again.

**If summarizing fails:** drop the oldest messages until the prompt fits. The note reads "Earlier messages were left out to fit", and the run proceeds.

**If a resumed session overflows** (possible when auto-compact is off in the user's Claude Code settings): when a run fails with a prompt-too-long error, compact that session in place once, retry automatically, and add a `compaction` divider.

## 5. Structure, testing and scope

**New units (each with tests)**
- `src/shared/contextSize.ts`: own size from parent and combined sizes (incl. merge and root), labels (`12k`, `+30k · 42k`, `~`), and the amber/red thresholds. Pure.
- `src/main/claude/contextUsage.ts`: reads `getContextUsage()` with a timeout and normalizes it into the stored snapshot.
- `src/main/claude/compaction.ts`: runs `/compact` in place or on a fork, captures `compact_summary`, and returns `{ sessionId, before, after, summary }`. The SDK `query` is injectable.
- `src/main/claude/replayFit.ts`: the replay planner (estimate, recent/older split, chunk plan). Pure, with the summarizer injected.
- `src/main/claude/modelWindows.ts`: remembers the window per model, persisted under `~/.local-lmcanvas/`.
- Renderer:
  - `ContextBadge.tsx` (badge + panel + actions);
  - the node bottom bar;
  - the compaction divider block renderer.

**Changes to existing code**
- `runner.ts`: map the system `status` and `compact_boundary` messages to runner events, and measure at the end.
- `shared/types.ts` and `shared/ipc.ts`:
  - `CanvasNode.data.context`;
  - the `compaction` content block;
  - the `compacting` / `compacted` / `context` chat events;
  - `LmcApi.chat.compact`.
- `main/index.ts`: replay auto-fit, the prompt-too-long retry, the `chat:compact` channel, and the window learning.
- `preload`, `webBridge`: `chat.compact`.
- `useCanvasStore` / `useNodeChat`: apply the new events, and create the Summary node.

**Testing**
- Test-first unit tests for every pure unit.
- Runner event mapping and the compaction runner, tested with a fake SDK session.
- Store tests for the new events and the Summary node.
- A final real-app check:
  - a long chat shows its sizes;
  - "Compact this node" and "Continue from summary" both work;
  - a forced oversized replay succeeds with the auto-fit note.

**Task 1 is a spike** against the installed Claude Code 2.1.289. It verifies:
1. auto-compaction emits `compact_boundary` in SDK sessions;
2. `/compact [focus]` sent as a prompt works for both resume and fork;
3. `getContextUsage()` works at the end of a run and returns the window;
4. `PostCompact` exposes `compact_summary`.

It uses only throwaway sessions. If any behaviour differs, stop and report before building on it.

**Out of scope**
- Codex and Cursor context;
- changing Claude Code's auto-compact threshold;
- editing summaries by hand;
- phone layouts.
