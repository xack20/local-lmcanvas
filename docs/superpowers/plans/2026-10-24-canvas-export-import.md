# Canvas Export and Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a whole canvas to a `.lmcanvas` file holding only its questions and answers, and import such a file as a new, continuable canvas on another LMCanvas.

**Architecture:** Pure, Electron-free logic in `src/shared/` (image metadata stripping, the share-file format both ways, replay history), file I/O in `src/main/storage/`, two desktop-only IPC channels with native dialogs in `src/main/index.ts`, and small renderer changes (menu item, Import button, two imported-reply safety conditions).

**Tech Stack:** Electron 33, React 19, TypeScript, Zustand, Bun tests (`*.test.mjs`, one file per `bun test` process), `nanoid`.

**Spec:** `docs/superpowers/specs/2026-10-24-canvas-export-import-design.md`

## Global Constraints

- File: extension `lmcanvas`, UTF-8 JSON `{ "format": "lmcanvas", "version": 1, "exportedAt": <ms>, "canvas": { "name", "nodes", "edges" } }`.
- Import size cap: 50 MB (`50 * 1024 * 1024` bytes).
- Refusal copy, verbatim: "This isn't an LMCanvas file." / "This file was made by a newer LMCanvas. Update LMCanvas to open it." / "This file is too large to import (the limit is 50 MB)."
- Error text in exported replies is replaced by "This reply failed."; a `streaming` reply is exported as `status: "error"`, `error: "interrupted"`.
- An image that can't be parsed is replaced by a text block "(image left out)".
- New channels are `desktop-only` and follow the four-place rule in `AGENTS.md`.
- Run `bun run typecheck` and each touched test file in its own `bun test <file>` process before every commit.

## Review Focus

1. A canvas named with `/`, `\` or `:` (e.g. "TCP/IP basics") must still get a valid default file name, not a path into a subfolder. Test in Task 2.
2. An imported file whose name is blank must still show up in the canvas list (blank names are hidden by `listCanvases`). Test in Task 2.
3. Importing the same file twice must give two separate canvases with different canvas ids and node ids. Test in Task 4.
4. A hand-edited or corrupted file (dangling edges, duplicate node ids, unknown block types, non-string text) imports what is valid and drops the rest without crashing. Test in Task 2.
5. Image bytes that aren't a valid PNG, JPEG or WebP must not fail the export or leak metadata. Test in Task 1.

---

### Task 1: Strip image metadata

**Files:**
- Create: `src/shared/imageMetadata.ts`
- Test: `src/shared/imageMetadata.test.mjs`

**Interfaces:**
- Produces: `stripImageMetadata(block: ImageBlock): ImageBlock | null`. It returns a new block with the same `mediaType` and cleaned `base64`; `null` when the bytes can't be parsed as the stated type. GIFs are returned unchanged.

- [ ] **Step 1: Write the failing tests** (build tiny images byte by byte in the test; no fixtures)

```js
test("a JPEG loses its EXIF, XMP, IPTC and comment segments but keeps JFIF and the image data", ...)
  // SOI, APP0 "JFIF", APP1 "Exif\0\0GPS…", APP13 "Photoshop…", COM "hi", SOS + bytes, EOI
  // expect: decoded output has no "Exif", "Photoshop", "hi"; still starts FFD8 FFE0 and contains the SOS bytes
test("a PNG loses eXIf, tEXt, zTXt, iTXt and tIME chunks and keeps IHDR, IDAT and IEND", ...)
test("a WebP loses its EXIF and XMP chunks, its RIFF size shrinks to match, and the VP8X EXIF/XMP flags are cleared", ...)
test("a GIF is returned unchanged", ...)
test("bytes that don't parse as the stated type give null", ...)
  // mediaType "image/jpeg" with base64 of "not an image"; mediaType "image/png" with a truncated chunk
```

- [ ] **Step 2: Run** `bun test src/shared/imageMetadata.test.mjs`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `stripImageMetadata`** in `src/shared/imageMetadata.ts`, working on `Uint8Array`s decoded with `atob` and re-encoded with `btoa` (chunked `String.fromCharCode`). `src/shared` is type-checked for the web too, so don't use `Buffer`.
  - JPEG: walk the marker segments from `FFD8` up to `FFDA` (SOS), drop `FFE1`, `FFED` and `FFFE` segments, copy everything from SOS to the end unchanged.
  - PNG: check the 8-byte signature, walk the `length | type | data | crc` chunks, and drop `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME`.
  - WebP: check `RIFF....WEBP`, walk the chunks (padded to an even size), drop `EXIF` and `XMP `, clear bits `0x08` and `0x04` of the `VP8X` flags byte, and rewrite the RIFF size.
  - Any out-of-bounds read returns `null`.

- [ ] **Step 4: Run** the test file. Expected: PASS.

- [ ] **Step 5: Commit** `feat(share): strip location and other metadata from images`

---

### Task 2: The share file, both ways

**Files:**
- Create: `src/shared/canvasShare.ts`
- Modify: `src/shared/types.ts` (`Message`), `src/shared/history.ts` (`migrateMessage`)
- Test: `src/shared/canvasShare.test.mjs`, `src/shared/migrateMessage.test.mjs`

**Interfaces:**
- Consumes: `stripImageMetadata` (Task 1), `migrateMessage` (`src/shared/history.ts`).
- Produces, all from `src/shared/canvasShare.ts`:
  - `SHARE_EXTENSION = "lmcanvas"`, `SHARE_MAX_BYTES = 50 * 1024 * 1024`
  - `type ShareRefusal = "not-lmcanvas" | "newer-version" | "too-large"`
  - `SHARE_REFUSAL_TEXT: Record<ShareRefusal, string>` (the Global Constraints copy)
  - `type ShareFile = { format: "lmcanvas"; version: number; exportedAt: number; canvas: { name: string; nodes: CanvasNode[]; edges: CanvasEdge[] } }`
  - `toShareFile(canvas: Canvas, exportedAt: number): ShareFile`
  - `fromShareFile(raw: unknown, newId: () => string): { ok: true; canvas: Pick<Canvas, "name" | "nameSource" | "nodes" | "edges"> } | { ok: false; reason: ShareRefusal }`
  - `shareFileName(canvasName: string): string`
- `Message` gains `imported?: boolean`, documented as: came from an imported `.lmcanvas` file, so its next-step buttons fill the prompt box instead of sending and its local-file links don't open. `migrateMessage` keeps it only when it is `true`.

- [ ] **Step 1: Write the failing tests**

`src/shared/migrateMessage.test.mjs`: add `test("an imported reply stays marked as imported after a load")`.

`src/shared/canvasShare.test.mjs`, using one fixture canvas with: `cwd`, `provider`, `nameSource`; a node with `nodeSettings` (incl. `cwd`), `context`, `providerSession`, `isTemporary`, `addedContext`, `title`, `width`; a sticky-note node; a reply with text + `thinking` + `tool_use` (Bash) + `compaction` blocks, `usage`, `errorCode`, `modelFallback`, `suggestions`, `provider`; a reply with `status: "error"`, `error: "spawn /Users/x/claude ENOENT"`; a reply with `status: "streaming"`; an `ExitPlanMode` tool with input `{ plan: "1. Do A" }`; a `mcp__lmc__ask_user_question` tool whose result content is `JSON.stringify({ answers: { "Where are you starting from?": "New to ML" } })`; a user message with a PNG image block.

```js
test("export keeps the questions, answers, layout, titles, sticky notes and next steps")
test("export drops tool calls, thinking, compaction, folder paths, sessions, settings, context sizes and usage")
  // JSON.stringify(file) contains none of: "tool_use", "thinking", "compaction", "providerSession", "nodeSettings", "/Users/x", "usage", "errorCode", "modelFallback", "isTemporary", "cwd"
test("export turns a plan and a multiple-choice answer into text")
  // text blocks "**Plan**\n\n1. Do A" and "**Question:** Where are you starting from?\n**Answer:** New to ML"
test("export replaces error text and marks a streaming reply interrupted")
test("import of an exported file shows the same canvas, with new node ids, imported replies and an auto name")
  // round trip: same name, same count of nodes/edges/messages, same text; every node id differs from the original;
  // parentIds/childIds/edge source+target point at the new ids; every message has imported: true; nameSource "auto"
test("import refuses something that isn't an LMCanvas file, and a newer version")
  // fromShareFile("x"), fromShareFile({ format: "other" }) → not-lmcanvas; { format: "lmcanvas", version: 2, … } → newer-version
test("import keeps what is valid in a damaged file and drops the rest")   // Review Focus 4
  // duplicate node id → second dropped; edge to a missing node → dropped; tool_use and { type: "text", text: 5 } blocks → dropped;
  // a node with type "group" or a non-numeric position → dropped
test("an imported canvas with a blank name is called Imported canvas")    // Review Focus 2
test("a default file name never contains a path separator")               // Review Focus 1
  // shareFileName("TCP/IP: basics") === "TCP-IP- basics.lmcanvas"; shareFileName("") === "Canvas.lmcanvas"
```

- [ ] **Step 2: Run** both test files. Expected: FAIL (module missing; `imported` dropped).

- [ ] **Step 3: Implement**
  - `types.ts` and `history.ts`: the `imported` field.
  - `toShareFile`: apply the spec's keep/drop tables. `ExitPlanMode` becomes `**Plan**\n\n{plan}`. Each ask-user question becomes `**Question:** {question}\n**Answer:** {answer}`, with the answer read from the tool result's JSON `answers[question]`; an array is joined with ", ", and a missing or cancelled answer is "(not answered)". Questions are joined with a blank line. Image blocks go through `stripImageMetadata`, and a `null` becomes the text block "(image left out)".
  - `fromShareFile`:
    1. Refusals first: not an object, or `format !== "lmcanvas"`, is `not-lmcanvas`; a `version` that isn't an integer ≥ 1 is `not-lmcanvas`; a version > 1 is `newer-version`.
    2. Nodes: keep the first node per id; require `id` string, `type` of `"custom"` or `"stickyNote"`, and finite `position.x`/`.y`. Copy only `title`, `stickyText`, `width`, `messages`, `parentIds`, `childIds`, `addedContext`, each with its type checked.
    3. Messages: run each through `migrateMessage`, then keep only `text` blocks with a string `text` and `image` blocks with an allowed `mediaType` and a string `base64`. Drop `usage`, `errorCode`, `errorProvider` and `modelFallback`, and set `imported: true`.
    4. Edges: drop any edge whose ends aren't kept nodes.
    5. Ids: remap every node id and edge id through `newId()`.
    6. Name: a blank `name` becomes `"Imported canvas"`, and `nameSource` is `"auto"`.
  - `shareFileName`: replace `/ \ : * ? " < > |` with `-`, trim, fall back to `Canvas`, and add `.lmcanvas`.

- [ ] **Step 4: Run** both test files. Expected: PASS.

- [ ] **Step 5: Commit** `feat(share): the .lmcanvas file format, exported and imported`

---

### Task 3: Replay carries quoted and merge context

**Files:**
- Modify: `src/shared/history.ts`, `src/renderer/src/hooks/useCanvasStore.ts:1091` (`getHistoryForNode`), `src/renderer/src/hooks/useNodeChat.ts:331-338` (`promptForModel`)
- Test: `src/shared/replayHistory.test.mjs`

**Interfaces:**
- Produces, from `src/shared/history.ts`:
  - `quoteForPrompt(addedContext: string): string`: the existing `> ` line quoting. `useNodeChat` uses it instead of its inline copy, so the replay matches what the model saw.
  - `getReplayHistoryForNode(nodeId: NodeId, nodesById: Record<NodeId, CanvasNode>): Message[]`: the same chain as `getMessageHistoryForNode`, except that each node's first user message gets one leading text block. That block holds `${buildMergeContext(parents)}\n\n---` when the node has more than one parent, then a blank line, then `quoteForPrompt(addedContext)` when the node has `addedContext`. Nothing is stored; new message objects are returned.
- The store's `getHistoryForNode` returns `getReplayHistoryForNode(...)`. `NodePanel`'s display keeps `getMessageHistoryForNode`.

- [ ] **Step 1: Write the failing tests**

```js
test("a branch made from a selection replays with the quoted text before its prompt")
  // child node with addedContext "Thread.start()" → its user message's first block text === "> Thread.start()"
test("a merge node replays with its parents' context before its prompt")
  // node with parentIds [a, b] → first block starts with buildMergeContext([a, b]) and ends with "\n\n---"
test("nodes without either replay unchanged, and the stored messages are not changed")
```

- [ ] **Step 2: Run** `bun test src/shared/replayHistory.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the two functions and switch the store and `useNodeChat` over to them.
- [ ] **Step 4: Run** the test file, plus `src/renderer/src/hooks/useCanvasStore.context.test.mjs` and `src/main/claude/*.test.mjs` (one file per process). Expected: all PASS.
- [ ] **Step 5: Commit** `fix(replay): include quoted selections and merge context when a branch is replayed`

---

### Task 4: Files on disk and the two channels

**Files:**
- Create: `src/main/storage/canvasShareFiles.ts`
- Modify: `src/shared/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/lib/webBridge.ts`
- Test: `src/main/storage/canvasShareFiles.test.mjs` (redirect `HOME` first, exactly like `canvases.test.mjs`)

**Interfaces:**
- Consumes: `toShareFile`, `fromShareFile`, `SHARE_MAX_BYTES`, `ShareRefusal` (Task 2); `readCanvas`, `writeCanvas`, `atomicWriteFile`.
- Produces:
  - `exportCanvasToFile(id: string, filePath: string, now?: number): Promise<boolean>`, which is `false` when the canvas doesn't exist.
  - `importCanvasFromFile(filePath: string, maxBytes = SHARE_MAX_BYTES): Promise<{ status: "imported"; canvasId: string } | { status: "refused"; reason: ShareRefusal }>`. It writes a new canvas whose id is `nanoid(10)`, with nodes and edges remapped by `() => nanoid(10)` and `createdAt = updatedAt = Date.now()`.
  - In `ipc.ts`:
    - `CanvasExportResult = { status: "saved" } | { status: "canceled" } | { status: "failed"; message: string }`
    - `CanvasImportResult = { status: "imported"; canvasId: string } | { status: "canceled" } | { status: "refused"; reason: ShareRefusal }`
    - `LmcApi.canvases.exportToFile(id: string): Promise<CanvasExportResult>`
    - `LmcApi.canvases.importFromFile(): Promise<CanvasImportResult>`
  - Channels `canvases:exportToFile` and `canvases:importFromFile`, both `desktop-only`.

- [ ] **Step 1: Write the failing tests**

```js
test("an exported canvas imports as a new canvas that reads back the same")
test("importing the same file twice makes two canvases with different canvas and node ids")   // Review Focus 3
test("a file over the size limit is refused without being read")      // maxBytes = 10
test("a file that isn't JSON is refused as not an LMCanvas file and nothing is written")    // canvases dir unchanged
```

- [ ] **Step 2: Run** `bun test src/main/storage/canvasShareFiles.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `canvasShareFiles.ts`. Check the size with `stat` before `readFile`. A `JSON.parse` failure is `not-lmcanvas`. Write the export with `atomicWriteFile(filePath, JSON.stringify(file, null, 2))`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Wire the channels** in the four places.
  - `canvases:exportToFile` reads the canvas for its name, then shows `dialog.showSaveDialog` with `defaultPath: join(app.getPath("downloads"), shareFileName(name))` and filter `{ name: "LMCanvas canvas", extensions: ["lmcanvas"] }`. On a thrown error it shows `dialog.showMessageBox({ type: "warning", message: "Couldn't export this canvas.", detail: err.message })` and returns `failed`.
  - `canvases:importFromFile` shows `dialog.showOpenDialog({ properties: ["openFile"], filters: [same] })`. On `refused` it shows `dialog.showMessageBox({ type: "warning", message: SHARE_REFUSAL_TEXT[reason] })`.
  - In `webBridge.ts`, both methods return `{ status: "canceled" }`, because the buttons are hidden in the browser (Task 5).
- [ ] **Step 6: Run** `bun run typecheck` and `bun test src/renderer/src/lib/webBridge.test.mjs`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(share): export and import canvas files from the desktop app`

---

### Task 5: Buttons, and safety for imported replies

**Files:**
- Modify: `src/renderer/src/components/CanvasManager/CanvasItem.tsx` (menu, around `:281-300`), `src/renderer/src/components/CanvasManager/CanvasManager.tsx` (`handleRename` area `:116`, header `:192-212`), `src/renderer/src/components/Canvas/CustomNode.tsx:345` (`onSuggestionClick`), `src/renderer/src/components/Canvas/NodeResponse.tsx:159` (`TextBlockView` props), `src/renderer/src/components/Canvas/blocks/TextBlockView.tsx` (`onLinkClick`)

**Interfaces:**
- Consumes: `window.api.canvases.exportToFile` / `importFromFile` (Task 4); `Message.imported` (Task 2); `isBrowser` from `@/lib/webBridge`; `usePaneRegistry`.
- Produces: `CanvasItem` prop `onExport: () => void`; `TextBlockView` prop `opensLocalLinks?: boolean` (default `true`).

- [ ] **Step 1: Export menu item.** Add **Export…** (lucide `Download` icon) between Rename and Delete in `CanvasItem`; it calls `onExport`. Hide it when `isBrowser`.
- [ ] **Step 2: `handleExport(id)` in `CanvasManager`.** If the canvas is open with the lock held, `await` its store's `save()` first, exactly as the guard in `handleRename` does. Then call `exportToFile(id)`.
- [ ] **Step 3: Import button.** Add an icon button (lucide `FileUp`, `title` and `aria-label` "Import a canvas file") to the right of **New canvas** in the header, hidden when `isBrowser`. On `imported` it does what `handleCreate` does after creating: close the panel, `refresh()`, `navigateToCanvas(canvasId)`.
- [ ] **Step 4: Imported replies.**
  - In `CustomNode.tsx`, pass `autoSubmit: !assistantMessage.imported`.
  - In `NodeResponse.tsx`, pass `opensLocalLinks={!message.imported}` to the reply's `TextBlockView`.
  - In `TextBlockView.tsx`, `onLinkClick` returns before `shell.openPath` when `!opensLocalLinks`. Web links still open.
- [ ] **Step 5: Run** `bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(share): export and import buttons; imported replies can't send or open files on their own`

---

### Task 6: Check it in the built app, then ship

- [ ] **Step 1:** Run every `*.test.mjs` file, one process each. Expected: all PASS.
- [ ] **Step 2:** Rebuild and install with the usual Mac procedure. Before quitting the app, check that no chat is running; afterwards, trash the build copy.
- [ ] **Step 3: Export** the "Java threads and OS architecture" canvas.
  - Expected: a Save dialog in Downloads named `Java threads and OS architecture.lmcanvas`.
  - The file contains none of `"tool_use"`, `"thinking"`, `"providerSession"`, `"nodeSettings"`, `"usage"`, or a `"cwd"` key.
- [ ] **Step 4: Import** the file.
  - Expected: a new canvas opens with the same nodes, branches, text and next-step buttons.
  - Importing the same file again gives a second canvas.
  - Picking a `.txt` file renamed to `.lmcanvas` shows "This isn't an LMCanvas file." and adds nothing.
- [ ] **Step 5: Imported replies.**
  - Expected: clicking a next-step button on an imported reply creates a child with the prompt filled in and **not sent**.
  - A local-file link in an imported reply does nothing.
  - A web link opens in the browser.
- [ ] **Step 6: Continue** from the deepest imported node with a question about the earlier conversation.
  - Expected: the reply shows it knows that conversation (replay worked).
  - The next-step buttons on the new reply send as normal.
- [ ] **Step 7:** Delete the two test imports. Commit the spec and plan (`docs: export/import design and plan`), then push `local/model-labels`.
