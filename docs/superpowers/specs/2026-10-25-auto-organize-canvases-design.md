# Organize canvas: lay out and title one canvas with AI, on demand, with undo

**Date:** 2026-10-25
**Status:** approved and built (2026-10-25)
**Branch:** `local/model-labels`

## Why

Older canvases with many branches are hard to find your way around. On
2026-10-17 the user's 29-node "LLMs & transformers" canvas (`XSX9Ap1MBW`) was
organized by hand, and the user wants to get that result for any canvas
whenever they ask for it. The hand-made shape, which this design reproduces:

- the main lesson runs straight down one column (Era 1 → Era 7C → wrap-up →
  the follow-on series);
- each deep dive sits in a column to the right, level with the node it
  branched from ("Q/K/V with real numbers" beside Era 4.1);
- an off-topic exchange sits to the left, away from the lesson;
- every node has a short, clear title ("Era 4.2 · The full transformer block").

## Decisions already made (by the user)

| Question | Decision |
|---|---|
| When it happens | Only when the user asks, one canvas at a time. Otherwise every canvas stays exactly as it is. No setting |
| Where it's asked for | An **Organize** item in the canvas's ⋯ menu in the canvas list, next to **Export…** |
| What it rearranges | Everything, including nodes the user dragged into place |
| Titles | AI also gives every node a short, clear title, shown on the canvas nodes themselves |
| Undo | Yes: one step back to how the canvas was before organizing |
| Deleting | Never: nothing is deleted, and no conversation changes |

## Goals

- **Organize** turns a canvas into the shape above, with clear titles and no
  overlapping nodes.
- **Undo organize** puts every node's position and title back as they were.
- Organizing an unchanged canvas again gives the same result, instantly.

## Non-goals

- Organizing automatically (on open, on a schedule, or while working).
- Undo beyond the last organize, or undo of anything other than organizing.
  The app has no general undo.
- Deleting, merging or hiding nodes, or changing any message.
- Changing parent → child links. AI only decides which branch is the main
  line, what kind each side branch is, and the titles.

## Anti-goals

- Nodes overlapping after organizing.
- A failed or slow AI call leaving a canvas half-arranged or with blank
  titles. On any failure the canvas stays as it was, and the user is told.
- An imported canvas's text getting the user's Claude to do anything: the AI
  call runs with no tools, like the canvas namer.
- Undo restoring something other than what organizing changed: it must not
  touch nodes created after the organize, or any message.

## What the user sees

- **Organize** in the ⋯ menu, between **Export…** and **Delete**. It works in
  the desktop app and the browser version alike *(Claude's call: unlike
  Export it needs no native dialog)*.
- Choosing it on a canvas that isn't open opens it first. Layout needs the
  real node heights, which only exist on screen.
- While organizing, the canvas shows a small **Organizing…** indicator,
  using the existing `GeneratingIndicator` style *(Claude's call)*. The item
  is unavailable while a reply is running in that canvas, since growing
  replies change node heights mid-layout.
- On success, every node moves into place and gets its new title in one step,
  and the canvas is saved.
- On failure, nothing moves, and a short message says "Couldn't organize this
  canvas." with the reason, in the existing `compactError` banner style
  *(Claude's call)*.
- After a successful organize, the menu shows **Undo organize** under
  **Organize** until it is used.

### Titles on the canvas

Today `data.title` isn't drawn on the canvas. `CustomNode` doesn't render
it, and the zoomed-out labels (`mockNodeSummaries` in `Canvas.tsx`) show a
prompt's first 10 words. Titles only appear in the side panel header, the
Timeline panel and the sidebar thread list. Organize titles are for finding
your way on the canvas, so *(user's decision)*:
- **On each node**, a one-line title at the top, above the prompt, in the
  node's existing small-label style.
- **Zoomed out**, a node's label is its organize title instead of the
  prompt's first 10 words.

Both appear **only for nodes that have a title from the current organize
plan** *(Claude's call)*. Every node's `data.title` is filled in from its
first prompt automatically, so drawing `data.title` everywhere would add a
header to every node of every canvas that just repeats the prompt. A canvas
that was never organized, or whose organize was undone, looks exactly as it
does today.

## How organizing works

1. The app checks whether the canvas has changed since it was last organized
   (see *Remembering a plan*).
   - **Unchanged, with a saved plan:** the layout is recomputed from that
     plan straight away, with no AI call.
   - **Changed, or never organized:** the app asks Claude for a plan (Haiku,
     about 15–30 s).
2. One animation frame after the canvas is on screen, node heights are read
   with the existing `makeDomHeightMeasurer`
   (`src/renderer/src/lib/collisionResolution.ts`), with
   `FALLBACK_NODE_HEIGHT` for anything not measured.
3. The undo snapshot is taken (see *Remembering a plan, and undo*), then the
   layout and titles are applied together and the canvas is saved.

**If the canvas changes while Claude is working** *(Claude's call)*: the
canvas stays usable during the wait. When the plan arrives:
- If the canvas is no longer open in this pane, the result is dropped, and
  nothing is saved or moved.
- If a reply is running in it, organizing stops with "A reply started while
  organizing. Try again when it finishes." Growing nodes would make the
  layout wrong.
- Otherwise the plan is applied to the canvas as it is now. Nodes added during
  the wait get the defaults (see *Validation*), and nodes deleted during the
  wait are skipped.

A canvas with fewer than 2 chat nodes has nothing to arrange. **Organize**
then just gives the node a title, if the plan has one *(Claude's call)*.

## The AI's job: a plan, not positions

`src/main/canvasOrganize/generate.ts`, following
`src/main/canvasName/generate.ts`: `query()` with model `"haiku"`,
`tools: []`, `settingSources: []`, a 90 s timeout. A new channel
`canvasOrganize:plan`, registered `"shared"` so the browser version can use
it, is wired in the four places listed in `AGENTS.md`.

**Input**, built in the renderer: one entry per chat node, with a short alias
(`n1`, `n2`, …) instead of the real id. Each entry has its parent's alias,
its children's aliases in creation order, its first prompt cut to 200
characters, and the start of its reply cut to 200 characters. Prompts are
the user's own text, and reply starts show what each branch became. Sticky
notes are left out.

**Stability** *(Claude's call)*. Each entry also carries the node's current
title. When a previous plan exists, it carries that plan's `next` and `kind`
for the node. The prompt says to keep a current title and the previous
choices unless they are clearly wrong for the canvas as it is now. This works
the way the canvas namer's `currentName` does. Organizing again after a few
new replies then titles and places the new nodes without reshuffling old
branches or renaming good titles. Auto-filled titles (a prompt's first 60
characters) read as poor titles, so they still get replaced.

**Output**, JSON only:

```json
{ "nodes": [ { "id": "n4", "title": "Era 4.1 · Self-attention", "next": "n5", "kind": "main" } ] }
```

- `title`: 2–8 words, at most 60 characters, in the conversation's
  language. A series gets a shared prefix ("Era 3 · …", "Deep dive · …")
  when the conversation is one.
- `next`: for a node with several children, which child continues *this
  node's own line*. Left out when there are one or no children.
- `kind`: for the first node of a branch that doesn't continue its parent's
  line, `"deep-dive"` (goes right) or `"off-topic"` (goes left). Roots are
  `"main"`. An **only child** may also get `"deep-dive"` or `"off-topic"`,
  which starts a new column even though nothing else branches there
  *(Claude's call)*. In the 10-17 hand layout, "Interpretability 1" is the
  only child of "Multimodal 3" yet starts its own column. Without this, a new
  series could never leave the line it grew from.

**Validation in main** *(Claude's call)*:
- Unknown aliases are ignored.
- A `next` that isn't one of the node's children is ignored.
- Titles are cleaned like canvas names (quotes stripped, cut at 60).
- Anything missing falls back to a default: a line continues with the
  **oldest** child, other branches are `"deep-dive"`, and a node with no
  title keeps its current one.
- The renderer maps aliases back to real ids before storing anything.

## The layout: deterministic, from the plan

A pure function in `src/shared/canvasLayout.ts`, unit-testable without React
or Electron:

```ts
layoutCanvas(nodes, plan, sizeOf): Record<NodeId, { x: number; y: number }>
```

- **Lines.** From a root, a line follows `next` (or the only child)
  downward. Each line is one column, and its nodes stack top to bottom with
  `ORGANIZE_GAP_Y` between them, using each node's measured height.
- **Branches.** Every child that doesn't continue its parent's line starts a
  new line. A `"deep-dive"` line goes to the right of the line it came from,
  an `"off-topic"` line to the left. Its first node is level with the node it
  branched from, or lower if that space is taken.
- **No overlap.** Columns are the node width (`data.width` or `NODE_WIDTH`)
  plus `ORGANIZE_GAP_X` apart. A new line takes the nearest column on its
  side whose vertical span is free.
- **Order.** Sibling branches are placed in creation order (each node's first
  message `createdAt`), so the result is stable.
- **Several roots** (separate conversations in one canvas): each tree is laid
  out on its own, and the trees sit side by side, oldest first, starting
  where the oldest root already is.
- **Merge nodes** (several parents) belong to their first parent
  (`parentIds[0]`), the conversation parent the rest of the app uses.
- **Sticky notes** don't move *(Claude's call)*. They belong to no tree, and
  the user placed them on purpose.

`ORGANIZE_GAP_X` and `ORGANIZE_GAP_Y` go in
`src/renderer/src/lib/canvasConstants.ts`, chosen to match the 10-17 hand
layout's spacing (about 1200 px between column starts).

## Remembering a plan, and undo

The canvas file gets one optional field *(Claude's call)*:

```ts
organized?: {
  fingerprint: string;
  plan: OrganizePlan;                    // validated, with real node ids
  undo: Record<NodeId, { x: number; y: number; title?: string }>;
}
```

- `fingerprint`: the sorted chat node ids plus each node's message count.
  Any new node, deleted node or new reply changes it. Moving nodes doesn't.
- `undo`: each node's position and title from before the user first
  organized, kept until **Undo organize** is used *(Claude's call)*:
  - The first organize takes the snapshot.
  - A later organize keeps it, and only adds entries for nodes created since,
    with their positions and titles from just before that organize.
  - So **Undo organize** always means "back to how it looked before I started
    organizing", however many times the user organized. Organizing an
    unchanged canvas twice can't wipe out the way back.
- **Undo organize** restores the snapshot for nodes that still exist, and
  leaves nodes created after the last organize alone. It then clears
  `organized` entirely, which also removes the titles from the canvas, so
  the next **Organize** asks the AI afresh.
- `migrateCanvas` (`src/main/storage/canvases.ts`) must keep this field, with
  its shape checked. It rebuilds canvases from known fields, and has already
  dropped `suggestions` and `nameSource` this way once.
- Export (`toShareFile`) drops it. A friend organizes their own copy.

## Testing

- `canvasLayout` unit tests:
  - a single line stacks with no overlap;
  - deep dives go right and off-topic goes left, level with their branch
    point;
  - a crowded column pushes the next branch into a free column;
  - several roots sit side by side;
  - sticky notes don't move;
  - the same input always gives the same output;
  - tall measured nodes push the ones below down.
- Plan validation tests: unknown ids, a bad `next`, and missing titles or
  kinds all fall back to the defaults above.
- Fingerprint tests: adding a node or a reply changes it; moving a node
  doesn't.
- Store tests:
  - organizing an unchanged canvas reuses the saved plan without calling
    the planner;
  - a changed canvas calls the planner once and saves the plan and the undo
    snapshot;
  - a failed planner changes nothing;
  - undo restores positions and titles, skips newer nodes, and clears
    `organized`;
  - organizing twice and then undoing gets back to the look from before the
    first organize;
  - a reply started during the wait stops organizing, and nothing moves;
  - the planner gets current titles and the previous plan's choices.
- Title display: a node shows a header and a zoomed-out label only when the
  current plan titles it; after undo, neither shows.
- `migrateCanvas` keeps `organized` and drops a malformed one; export drops
  it.
- By hand:
  - organize the LLM canvas, check it settles into the shape above, and that
    the titles show on the nodes and as zoomed-out labels;
  - organize again: nothing moves, instantly;
  - **Undo organize** restores the old look;
  - organizing works from the browser version too.

## Left to the builder

- The exact prompt wording, within the output contract above.
- The gap values, as long as nodes never overlap.
- Whether nodes animate into place or jump.
