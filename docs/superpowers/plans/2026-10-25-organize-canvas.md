# Organize Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An **Organize** action per canvas that has Claude Haiku pick the main line, deep dives and off-topic branches and title every node, lays the canvas out from that plan with no overlaps, shows the titles on the nodes, and can be undone.

**Architecture:** Pure, Electron-free logic in `src/shared/` (the plan model, fingerprint, request/reply validation, undo, and a deterministic layout); one planner channel in main that asks Haiku with no tools; store actions that fetch or reuse a plan, measure node heights from the DOM, apply positions and titles, and keep an undo snapshot; menu items, a progress pill, an error banner, and title display in the renderer.

**Tech Stack:** Electron 33, React 19, TypeScript, Zustand, @xyflow/react, `@anthropic-ai/claude-agent-sdk` `query()`, Bun tests (`*.test.mjs`, one file per `bun test` process).

**Spec:** `docs/superpowers/specs/2026-10-25-auto-organize-canvases-design.md`

## Global Constraints

- Planner: model `"haiku"`, `tools: []`, `settingSources: []`, timeout 90 s, channel `canvasOrganize:plan` registered `"shared"`, wired in the four places in `AGENTS.md`.
- Prompts and reply starts sent to the planner are cut to 200 characters; titles are cleaned and cut to 60 characters.
- Layout gaps: `ORGANIZE_GAP_X = 100` (columns start `NODE_WIDTH + 100 = 1200` px apart, as in the 10-17 hand layout) and `ORGANIZE_GAP_Y = 80`, in `src/renderer/src/lib/canvasConstants.ts`.
- Nothing is ever deleted, no message changes, `parentIds`/`childIds`/edges never change, sticky notes never move.
- Copy, verbatim:
  - menu items "Organize" and "Undo organize";
  - progress "Organizing…";
  - errors "Couldn't organize this canvas. Claude didn't answer.", "A reply started while organizing. Try again when it finishes.", and "Wait for the reply to finish, then organize."
- Run `bun run typecheck` and each touched test file in its own `bun test <file>` process before every commit.

## Review Focus

1. A canvas whose tree has a cycle or a node whose first parent is missing (hand-edited or imported files) must still organize without hanging, placing every chat node exactly once. Test in Task 2.
2. A canvas with several separate conversations (several roots) must lay out every tree with no overlap between trees. Test in Task 2.
3. Organizing twice and then undoing must return to the look from before the first organize, not the first organize's result. Test in Task 4.
4. A planner reply that is malformed (not JSON, unknown ids, `next` pointing at a non-child, 300-character titles) must fall back to defaults instead of failing or breaking the canvas. Test in Task 1.
5. A node created after organizing must stay where it is on undo, and an undo entry for a deleted node must be ignored. Test in Task 1.

---

### Task 1: The organize model

**Files:**
- Create: `src/shared/canvasOrganize.ts`
- Modify: `src/shared/types.ts` (`Canvas`, `CanvasSummary`), `src/main/storage/canvases.ts` (`migrateCanvas`, `listCanvases`)
- Test: `src/shared/canvasOrganize.test.mjs`, `src/main/storage/canvases.test.mjs`, `src/shared/canvasShare.test.mjs`

**Interfaces** (produces, all exported from `src/shared/canvasOrganize.ts` unless noted):
- Types:
  - `OrganizeKind = "main" | "deep-dive" | "off-topic"`
  - `OrganizeNodePlan = { title?: string; next?: NodeId; kind?: OrganizeKind }`
  - `OrganizePlan = Record<NodeId, OrganizeNodePlan>`
  - `OrganizeSnapshot = Record<NodeId, { x: number; y: number; title?: string }>`
  - `CanvasOrganized = { fingerprint: string; plan: OrganizePlan; undo: OrganizeSnapshot }`
  - `OrganizePlanRequest = { nodes: Array<{ id: string; parent?: string; children: string[]; prompt: string; reply: string; title?: string; previous?: { next?: string; kind?: OrganizeKind } }> }`. Ids here are aliases `n1`, `n2`, … .
  - `AliasPlan = Record<string, OrganizeNodePlan>`, keyed and pointing by alias.
- `chatNodes(nodes: CanvasNode[]): CanvasNode[]`: only `type === "custom"`.
- `organizeFingerprint(nodes: CanvasNode[]): string`: sorted chat node ids, each with its message count.
- `buildPlanRequest(nodes: CanvasNode[], previous?: OrganizePlan): { request: OrganizePlanRequest; aliasToId: Record<string, NodeId> }`. Aliases follow creation order (first message `createdAt`, then node order). Children are in creation order. `title` is the node's `data.title`. `previous` is translated to aliases.
- `validatePlanReply(raw: unknown, request: OrganizePlanRequest): AliasPlan`. It drops unknown aliases, a `next` that isn't one of that node's `children`, and unknown kinds, and cleans titles: quotes stripped, whitespace collapsed, cut to 60. Never throws.
- `planFromAliases(plan: AliasPlan, aliasToId: Record<string, NodeId>): OrganizePlan`
- `parseOrganized(raw: unknown): CanvasOrganized | undefined`: a shape check for loading.
- `restoreFromUndo(nodes: CanvasNode[], organized: CanvasOrganized): CanvasNode[]`. It returns new nodes, with the snapshot position and title applied to nodes that still exist.
- `snapshotFor(nodes: CanvasNode[], organized?: CanvasOrganized): OrganizeSnapshot`: the existing snapshot, plus entries for chat nodes it doesn't have yet.
- `types.ts`: `Canvas.organized?: CanvasOrganized`; `CanvasSummary.organized?: boolean`.

- [ ] **Step 1: Write the failing tests**

```js
// canvasOrganize.test.mjs
test("the fingerprint changes with a new node or a new reply, not with a move or a title")
test("a plan request uses aliases in creation order, cuts prompts and replies to 200, and carries titles and the previous plan")
test("a malformed planner reply falls back instead of failing")      // Review Focus 4
  // "not json" → {}; { nodes: [{ id: "n99" }] } → {}; next "n3" on a node whose children are ["n2"] → no next;
  // kind "sideways" → no kind; a 300-char title → 60 chars; quotes stripped
test("an alias plan maps back to real node ids")
test("undo restores positions and titles of nodes that still exist and leaves newer nodes alone")   // Review Focus 5
test("a second snapshot keeps the first one and only adds new nodes")
test("a malformed organized field is dropped on load")   // parseOrganized(null / { plan: 5 } / missing undo) → undefined
// canvases.test.mjs
test("keeps a valid organized field and reports it in the canvas list")
// canvasShare.test.mjs
test("export leaves out the organize plan")   // JSON.stringify(toShareFile(...)) has no "organized"
```

- [ ] **Step 2: Run** each file (`bun test <file>`). Expected: FAIL (module missing; field dropped).
- [ ] **Step 3: Implement** the module.
  - `migrateCanvas` adds `...(organized ? { organized } : {})` from `parseOrganized(raw.organized)`.
  - `listCanvases` adds `organized: Boolean(parseOrganized(parsed.organized))`.
- [ ] **Step 4: Run** the three files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(organize): the organize plan, fingerprint and undo model`

---

### Task 2: Deterministic layout

**Files:**
- Create: `src/shared/canvasLayout.ts`
- Test: `src/shared/canvasLayout.test.mjs`

**Interfaces:**
- Consumes: `OrganizePlan`, `chatNodes` (Task 1).
- Produces: `layoutCanvas(nodes: CanvasNode[], plan: OrganizePlan, sizeOf: (node: CanvasNode) => { width: number; height: number }, gap: { x: number; y: number }): Record<NodeId, { x: number; y: number }>`. Positions for chat nodes only.

The algorithm, since the signature and tests don't determine it:
1. **Parent.** A chat node's parent is `parentIds[0]` when that id is a chat node in the canvas; otherwise the node is a root.
2. **Children and roots.** Children and roots are taken in creation order.
3. **Continuation.** A node continues its line with `plan[id].next` when that is one of its children. Otherwise it continues with its oldest child whose `kind` is neither `"deep-dive"` nor `"off-topic"`. Every other child starts a branch line.
4. **Columns.**
   - Column pitch is the widest chat node plus `gap.x`.
   - Each column keeps a list of occupied `[top, bottom]` spans.
   - Origin: the oldest root's current position.
5. **Placing a line.**
   - A line occupies one column. Its nodes stack downward, `height + gap.y` apart, starting at y0.
   - Its full span (y0 to the last node's bottom) is reserved before placing.
   - A branch line starts at the y of the node it branched from. It takes the nearest column on its side whose span is free there: right for `"deep-dive"` and the default, left for `"off-topic"`.
   - Branches are placed after their whole parent line, top to bottom, siblings in creation order. Depth-first, recursively.
6. **Several roots.** Each later root's line takes the first column right of every column used so far.
7. **Cycles.** A visited set means each node is placed once. Chat nodes not reached from any root, such as cycle-only components, become extra roots.

- [ ] **Step 1: Write the failing tests** (nodes built with explicit `createdAt`; `sizeOf` returns 1100 × the given height)

```js
test("a single line stacks downward with the gap and no overlap")
test("a deep dive goes in the next column right, level with its branch point; off-topic goes left")
test("a branch whose column is taken at that height moves to the next free column")
test("plan.next picks which child continues; without it the oldest non-side child does")
test("an only child marked deep-dive starts a new column")
test("several roots sit side by side with no overlap between trees")              // Review Focus 2
test("a cycle or a missing first parent still places every chat node exactly once")   // Review Focus 1
test("sticky notes get no position, and the same input gives the same output")
test("a tall node pushes the nodes below it down")
// every test also asserts: no two returned rectangles intersect
```

- [ ] **Step 2: Run** `bun test src/shared/canvasLayout.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `layoutCanvas` as above.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(organize): lay a canvas out from an organize plan`

---

### Task 3: The planner

**Files:**
- Create: `src/main/canvasOrganize/generate.ts`
- Modify: `src/shared/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/lib/webBridge.ts`

**Interfaces:**
- Consumes: `OrganizePlanRequest`, `AliasPlan`, `validatePlanReply` (Task 1).
- Produces:
  - `planCanvasOrganize(request: OrganizePlanRequest, opts: { binPath?: string; signal?: AbortSignal }): Promise<AliasPlan | null>`. It's `null` when Claude fails or gives no JSON object.
  - `LmcApi.canvasOrganize.plan(request: OrganizePlanRequest): Promise<AliasPlan | null>`, on channel `canvasOrganize:plan`, `"shared"`. Its handler passes `signal: AbortSignal.timeout(90_000)` and the configured `binPath`, and returns `null` on any throw.

- [ ] **Step 1:** Implement `generate.ts` by copying the shape of `src/main/canvasName/generate.ts`.
  - `query()` options: model `"haiku"`, `tools: []`, `settingSources: []`, the system prompt "You output one JSON object only. No prose, no markdown fences."
  - The prompt says what the canvas is and gives the output contract and rules from the spec: titles 2–8 words in the conversation's language, with series prefixes; `next` only among `children`; `kind` for branch starts and for an only child that starts a new series; keep current titles and the previous choices unless clearly wrong, but treat a title that is just the prompt's opening words as poor.
  - It ends with `JSON.stringify(request)`.
  - Parse the first `{…}` span of the reply and pass it through `validatePlanReply(parsed, request)`.
- [ ] **Step 2: Wire** the channel in the four places.
- [ ] **Step 3: Run** `bun run typecheck` and `bun test src/renderer/src/lib/webBridge.test.mjs`. Expected: PASS.
- [ ] **Step 4: Real call check.** Run a scratch script against a throwaway copy of `XSX9Ap1MBW`: `buildPlanRequest` → `planCanvasOrganize` → `layoutCanvas` with height 900. Expected: a non-empty plan whose main line runs Era 1 → … → Era 7C, deep dives marked `"deep-dive"`, the "intelligent level" exchange `"off-topic"`, and no overlapping rectangles. Record what came back in the ledger.
- [ ] **Step 5: Commit** `feat(organize): ask Haiku, with no tools, for an organize plan`

---

### Task 4: Organize and undo in the store

**Files:**
- Create: `src/renderer/src/hooks/useOrganizeRequestStore.ts`
- Modify: `src/renderer/src/hooks/useCanvasStore.ts`, `src/renderer/src/lib/canvasConstants.ts`
- Test: `src/renderer/src/hooks/useCanvasStore.organize.test.mjs` (stub `window.api` the way `useCanvasStore.autoName.test.mjs` does)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - Store state `organized: CanvasOrganized | undefined`, `organizing: boolean`, `organizeError: string | null`. All are loaded from and saved with the canvas, through `loadCanvas` and `canvasFromState`, except the last two, which are transient.
  - `organize(measureHeight: (id: NodeId) => number): Promise<void>`
  - `undoOrganize(): void`
  - `useOrganizeRequestStore`, shaped like `useFocusRequestStore`: `{ request: { canvasId: string; requestedAt: number } | null; requestOrganize(canvasId): void; consume(canvasId, requestedAt): void }`
  - `ORGANIZE_GAP_X = 100`, `ORGANIZE_GAP_Y = 80`.

`organize` order of work:
1. Return unless the lock is held.
2. If a reply is running, set "Wait for the reply to finish, then organize." and stop.
3. Clear `organizeError`.
4. With an unchanged fingerprint and a saved plan, use it. Otherwise:
   - set `organizing`;
   - call `canvasOrganize.plan(buildPlanRequest(chat nodes, organized?.plan))`;
   - clear `organizing`;
   - `null` → "Couldn't organize this canvas. Claude didn't answer.";
   - the pane now shows another canvas → drop the result silently;
   - a reply now running → "A reply started while organizing. Try again when it finishes.";
   - otherwise map the result with `planFromAliases`.
5. Compute `layoutCanvas` on the current nodes. `sizeOf` uses `data.width ?? NODE_WIDTH` and `measureHeight`.
6. In one `set`: new positions, plan titles into `data.title`, and `organized = { fingerprint, plan, undo: snapshotFor(nodes before applying, organized) }`.
7. `markDirty`, `save`, then dispatch `lmc:canvases-changed`.

`undoOrganize`: when `organized` exists, call `restoreFromUndo(...)` (Task 1), set `organized: undefined`, then `markDirty`, `save` and dispatch.

- [ ] **Step 1: Write the failing tests**

```js
test("organizing an unchanged canvas reuses its saved plan without asking Claude")
test("organizing a changed canvas asks Claude once and saves the plan, the titles and an undo snapshot")
test("when Claude doesn't answer, nothing moves and the error says so")
test("a reply started while Claude was working stops organizing and nothing moves")
test("organizing twice and then undoing returns to the look from before the first organize")   // Review Focus 3
test("undo leaves a node created after organizing where it is, and clears the plan")
test("the planner is sent the current titles and the previous plan's choices")
```

- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement** the request store, the constants and the two store actions.
- [ ] **Step 4: Run** the test file, plus `useCanvasStore.save.test.mjs` and `useCanvasStore.autoName.test.mjs` (one process each). Expected: PASS.
- [ ] **Step 5: Commit** `feat(organize): organize and undo a canvas in the store`

---

### Task 5: Menu, progress, errors and titles on screen

**Files:**
- Modify: `src/renderer/src/components/CanvasManager/CanvasItem.tsx` (menu after Export…), `src/renderer/src/components/CanvasManager/CanvasManager.tsx` (handlers), `src/renderer/src/components/Canvas/CanvasPane.tsx` (request effect, pill, banner), `src/renderer/src/components/Canvas/CustomNode.tsx` (title line), `src/renderer/src/components/Canvas/Canvas.tsx` (`mockNodeSummaries`)

**Interfaces:**
- Consumes: `organize`, `undoOrganize`, `organized`, `organizing`, `organizeError`, `useOrganizeRequestStore` (Task 4); `CanvasSummary.organized` (Task 1).
- Produces: `CanvasItem` props `onOrganize: () => void` and `onUndoOrganize: () => void`.

- [ ] **Step 1: Menu.** In `CanvasItem`, add **Organize** (lucide `Workflow` icon) after Export…, shown in the browser too. Add **Undo organize** (lucide `Undo2`) under it when `canvas.organized`.
- [ ] **Step 2: Handlers** in `CanvasManager`:
  - **Organize:** `requestOrganize(id)`, then `navigateToCanvas(id)` if the canvas isn't the current one.
  - **Undo organize:**
    - open, with the lock held: `openStoreFor(id)?.getState().undoOrganize()`;
    - otherwise: read the canvas, write `{ ...canvas, nodes: restoreFromUndo(canvas.nodes, canvas.organized), organized: undefined }`;
    - then `refresh()`.
- [ ] **Step 3: `CanvasPane`.**
  - **The request:** an effect, like the focus-request one. When `loaded`, the lock is held and the request names this canvas, consume it, wait one `requestAnimationFrame`, then call `organize(makeDomHeightMeasurer(zoom))`. Read `zoom` from `useStore((s) => s.transform[2])`.
  - **"Organizing…" pill:** a `Loader2` spinner while `organizing`, in the position and style of the existing `saveError` pill.
  - **The error:** `organizeError` in the same amber pill, cleared after 8 s or on the next organize.
- [ ] **Step 4: Titles.**
  - `CustomNode`: when `organized?.plan[id]?.title` exists, render `data.title` as one truncated line above the user message, in the node's existing small muted label style.
  - `Canvas.tsx` `mockNodeSummaries`: the summary is that title when present, otherwise the prompt's first 10 words, as today.
- [ ] **Step 5: Run** `bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(organize): Organize and Undo organize in the canvas menu, with titles on the nodes`

---

### Task 6: Check it in the built app, then ship

- [ ] **Step 1:** Run every `*.test.mjs` file, one process each. Expected: all PASS.
- [ ] **Step 2:** Rebuild and install with the usual Mac procedure. Before quitting the app, check that no chat is running; afterwards, trash the build copy.
- [ ] **Step 3:** Run the final whole-branch review, apply the fix pass, then commit the spec and plan (`docs: organize canvas design and plan`) and push `local/model-labels`.
- [ ] **Step 4: Hand the by-hand checks to the user:**
  - Organize the LLM canvas: it settles into the shape in the spec, with titles on the nodes and as zoomed-out labels.
  - Organize again: nothing moves, instantly.
  - **Undo organize** restores the old look.
  - Organizing works from the browser version too.
