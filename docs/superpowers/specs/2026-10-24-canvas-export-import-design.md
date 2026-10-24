# Canvas export and import: share a canvas with a friend as a file

**Date:** 2026-10-24
**Status:** reviewed by a fresh builder; awaiting the user's approval
**Branch:** `local/model-labels`

## Why

The user wants to hand a whole canvas (for example a long Java lesson with all
its branches) to friends who also run LMCanvas. Today the only way is to copy
the canvas JSON by hand, which carries private material (tool output, folder
paths, session IDs) and breaks when the friend continues: their Claude can't
resume the user's sessions.

## Decisions already made (by the user)

| Question | Decision |
|---|---|
| How the file travels | The user sends it by hand (chat app, email, USB). No server, no link |
| What the friend does | Opens it in their own local LMCanvas and can keep chatting from any node |
| Where the friend's continuation goes | Stays on the friend's machine only. Nothing syncs back |
| What goes in the file | Only the questions and answers, none of Claude's behind-the-scenes work |
| How much is shared | The whole canvas only, never a single branch |
| How the friend brings it in | The Import button in the canvas list; no double-click to open |

## Goals

- Export any canvas to one file from the canvas list.
- Import such a file as a new canvas that looks the same: same name, nodes,
  branches, layout, titles, sticky notes, replies and next-step buttons.
- The friend can continue from any node with their own Claude/Codex login.
- Nothing private beyond the visible questions and answers leaves the Mac.

## Non-goals

- Exporting one branch or a selection of nodes.
- Syncing, merging or updating an earlier import. Importing the same file
  twice makes two separate canvases.
- Export/import from the browser version (`src/main/web/`). Desktop app only
  for now *(Claude's call; the browser version can get a download/upload path
  later)*.
- Editing or redacting reply text. Replies go in exactly as shown on screen.
- Opening a `.lmcanvas` file by double-clicking it (file associations, the
  macOS `open-file` event, Windows single-instance handling). The Import
  button is the only way in *(the user's decision)*.

## Anti-goals (would make this a failure even if it works)

- The file contains tool calls or results, thinking, folder paths, session
  IDs, or usage/cost data.
- An imported canvas can make the friend's Claude act (run tools, open files)
  without the friend deciding to.
- A malformed or hostile file crashes the app, overwrites an existing canvas,
  or writes outside `~/.local-lmcanvas/canvases/`.

## What the user sees

- **Export:** each canvas's menu in the canvas list (next to Rename, Delete,
  Open in new window) gets **Export…**. It opens a Save dialog with the file
  named after the canvas, e.g. `Java threads and OS architecture.lmcanvas`,
  defaulting to the Downloads folder *(Claude's call)*.
- **Import:** the canvas list header gets an **Import** button next to the
  existing **+** (new canvas). It opens an Open dialog filtered to
  `.lmcanvas`. On success the new canvas appears at the top of the list and
  opens *(Claude's call)*.
- **Errors** are shown in plain words and change nothing: "This isn't an
  LMCanvas file", "This file was made by a newer LMCanvas", "This file is too
  large".

## The file

- Extension `.lmcanvas`; contents are UTF-8 JSON *(Claude's call)*:

```json
{
  "format": "lmcanvas",
  "version": 1,
  "exportedAt": 1761320000000,
  "canvas": { "name": "...", "nodes": [...], "edges": [...] }
}
```

- An unknown `format`, or a `version` above the one the app supports, is
  refused on import.

### What is kept and what is dropped

Canvas (`Canvas` in `src/shared/types.ts`):

| Field | In the file |
|---|---|
| `name` | kept |
| `nodes`, `edges` | kept, filtered as below |
| `id` | dropped; import makes a new one |
| `cwd`, `provider`, `nameSource`, `createdAt`, `updatedAt` | dropped |

Node (`CanvasNode`):

| Field | In the file |
|---|---|
| `id`, `type`, `position` | kept |
| `data.title`, `data.stickyText`, `data.width` | kept |
| `data.chat.messages` | kept, filtered as below |
| `data.chat.parentIds`, `data.chat.childIds` | kept |
| `data.chat.addedContext` | kept (it is text the user added to the prompt) |
| `data.chat.providerSession` | dropped |
| `data.chat.isTemporary` | dropped (an imported node never auto-deletes) |
| `data.nodeSettings` (provider, model, effort, cwd, branch label, plan/chat-only) | dropped; the friend's defaults apply |
| `data.context` (context size) | dropped |

Message (`Message`):

| Field | In the file |
|---|---|
| `id`, `role`, `createdAt` | kept |
| `blocks` | only `text` and `image` blocks are kept; `tool_use` (with its result), `thinking` and `compaction` blocks are dropped, except the two tools below |
| `suggestions` (next-step buttons) | kept |
| `provider` (which app answered, used for labels) | kept |
| `status` | kept; a `streaming` message is written as `error` with error "interrupted", as canvas load already does |
| `error` | replaced by the fixed line "This reply failed." *(Claude's call: runner errors are raw exception text and stderr, which can hold folder paths and account details)* |
| `usage`, `errorCode`, `errorProvider`, `modelFallback` | dropped |

**Two tools are answers, not behind-the-scenes work, so they become text
blocks** *(Claude's call)*. They are turned into a `text` block in the same
place and their `tool_use` block is dropped:
- `ExitPlanMode`: its input's plan text, under a `**Plan**` line. In plan
  mode the plan exists only there.
- `mcp__lmc__ask_user_question` (`src/main/claude/askUserMcp.ts`): each
  question and the option the user picked (from the tool result), as
  `**Question:** …` / `**Answer:** …` lines. Later replies refer to these
  choices.

Images the user attached to prompts stay in the file (they are part of the
question), so a canvas with many screenshots makes a large file. They are
stored byte-for-byte today (`src/renderer/src/lib/imageAttachments.ts`), so a
phone photo still carries its metadata, including GPS location. **Export
strips image metadata** by removing the metadata sections from the bytes,
with no re-encoding *(Claude's call)*: JPEG `APP1` (EXIF/XMP), `APP13`
(IPTC) and comment segments; PNG `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME`
chunks; WebP `EXIF` and `XMP ` chunks. GIFs are written as they are, since
they carry no location data. An image whose bytes can't be parsed is left out
and replaced by the line "(image left out)", so a broken image never leaks
its metadata or fails the export.

## Continuing on the friend's side

No node carries a `providerSession` after import, so when the friend sends a
prompt from an imported node, `chat:start` in `src/main/index.ts` replays the
branch as a `[User]`/`[Assistant]` transcript (the existing path used after a
provider switch; see `src/main/claude/history.ts`, `replayFit.ts`). Replies
the friend gets from then on carry the friend's own sessions as normal. The
replay sees only questions and answers, because that is all the file has.

**One gap in today's replay must be closed** *(Claude's call)*. Text the user
quotes when branching from a selection (`data.chat.addedContext`) and the merge
context built for a node with several parents are added in front of the prompt
only when it is sent (`promptForModel` in
`src/renderer/src/hooks/useNodeChat.ts`). They are never stored in the
message, and `buildPromptWithHistory` (`src/main/claude/history.ts`) builds the
transcript from message blocks alone. So a replay of a branch built that way
asks "what does this mean?" with no "this". Fix it once in the shared replay:
each node's `addedContext` goes into the transcript before that node's prompt,
as the quoted lines the model saw originally, and a node with several parents
gets its merge context (`buildMergeContext`) there too. Replay size estimates
(`replayFit.ts`) count both, since they measure the same messages. This also fixes the same gap for provider-switch
replays, which have always had it. Earlier images replay as `[image]`, as they
do after a provider switch today; that stays.

## An imported file is untrusted input

The friend's chats run Claude with every tool allowed and no permission
prompts (`src/main/claude/runner.ts`). So anything in an imported canvas that
can start a chat or open a file without the friend's say-so is a real risk.

1. **Validate everything on import, in the main process.** Size cap (50 MB
   *(Claude's call)*), JSON parse, `format`/`version` check, then rebuild the
   canvas from known fields only, as `migrateCanvas`/`migrateMessage` in
   `src/main/storage/canvases.ts` and `src/shared/history.ts` already do,
   plus: only `text`/`image` blocks; image `mediaType` from `ImageMediaType`;
   every string field must be a string; node `type` must be a
   `CanvasNodeType`; edges whose `source` or `target` isn't a node in the file
   are dropped; parent/child ids that don't name a node in the file are
   dropped. The canvas gets a fresh id from `nanoid(10)` and is written with
   the existing `writeCanvas`, so the file path is always
   `canvasFilePath(newId)`. **Every node gets a fresh id too**, remapped in
   `parentIds`, `childIds` and edges *(Claude's call)*: `chat:cancelForNode`
   stops runs by node id across all canvases, so two imports of one file, or
   importing your own export, must not share node ids.
   The imported canvas gets `nameSource: "auto"` *(Claude's call)*: it keeps
   the sender's name, a first-words placeholder gets a real name on open, and
   the friend's copy follows its focus as it grows, until the friend renames
   it.
2. **Mark imported messages.** Every message that came from a file gets
   `imported: true` (a new optional `Message` field, kept by
   `migrateMessage`). Messages the friend creates later don't have it.
3. **Next-step buttons on imported replies fill the prompt box but don't
   send.** Today a click branches and auto-submits
   (`CustomNode.tsx`, `onSuggestionClick` → `branch({ autoSubmit: true })`).
   For an imported reply it branches with the prompt filled in and waits, so
   the friend reads the prompt before it reaches their Claude.
4. **Local-file links in imported replies don't open.** Today a link that
   isn't `http(s)`/`mailto` is opened with `shell.openPath`
   (`TextBlockView.tsx`, `onLinkClick`). In an imported reply such a link does
   nothing *(Claude's call; showing the path as a tooltip is fine)*. Web links
   still open in the browser.
5. **Known, accepted risk:** when the friend continues, the imported
   transcript goes to their Claude as conversation history, and a hostile
   transcript could try to steer it. This is inherent to continuing someone
   else's chat. The friend should import only from people they trust. No extra
   UI for this *(Claude's call)*.

## Exporting a canvas that is open

The open pane's store may hold changes not yet on disk, and it overwrites the
file on its next save. Export therefore saves the open canvas first, through
its store from `usePaneRegistry` (as `CanvasManager.handleRename` now does),
and then exports from disk.

## Where it's built *(Claude's calls)*

- `src/shared/canvasShare.ts`: two pure functions.
  `toShareFile(canvas: Canvas): ShareFile` applies the keep/drop tables.
  `fromShareFile(raw: unknown): { ok: true; canvas: Omit<Canvas, "id"> } | { ok: false; reason: ... }`
  validates and rebuilds, and sets `imported: true` on every message.
- `src/main/index.ts`: two `desktop-only` handlers. `canvases:export(id)`
  reads the canvas, shows the Save dialog and writes the file.
  `canvases:import()` shows the Open dialog, checks the size, reads the file,
  calls `fromShareFile` and writes the new canvas. Both return a small result
  the renderer can turn into a message (`saved`, `canceled`, or an error
  reason).
- Wired through `src/shared/ipc.ts` and `src/preload/index.ts`, following the
  four-place rule in `AGENTS.md`. The browser bridge
  (`src/renderer/src/lib/webBridge.ts`) gets stubs that report "not available
  in the browser".
- UI: `CanvasItem.tsx` (menu item), `CanvasManager.tsx` (Import button and
  the save-open-canvas-first step), `CustomNode.tsx` (fill-not-send) and
  `TextBlockView.tsx` (no local-file links for imported messages).

## Testing

- Unit tests for `canvasShare.ts`: every dropped field is gone, every kept
  field survives, a round trip export → import gives the same visible canvas,
  and each refusal (wrong format, newer version, malformed nodes/edges/blocks,
  dangling edges) behaves as described.
- The two imported-reply behaviours (next-step click doesn't auto-submit; a
  local-file link doesn't open) are one-line conditions in React components,
  and the repo has no component test setup, so they are checked by hand in
  the built app *(Claude's call)*.
- By hand in the built app: export a real canvas, import it, check it looks
  the same, continue from a deep node and confirm the reply knows the earlier
  conversation (replay), and check the exported file holds no `tool_use`,
  `thinking`, `/Users/` folder settings, or session ids.

## Left to the builder

- The exact `ShareFile` TypeScript types and refusal reason names.
- Message wording and where error messages appear (an existing pattern in the
  canvas list is preferred over new UI).
- Whether import places the canvas at the top of the list by `updatedAt` or
  `createdAt`, as long as it is easy to find right after importing.
