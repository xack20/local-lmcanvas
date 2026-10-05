# local-lmcanvas

A fully local, canvas-based branching AI conversation tool. The Electron app drives your installed Claude, Codex, or Cursor agent harness — no API keys to paste into the app, no database, and no LMCanvas telemetry.

Each conversation is a tree of message nodes on a canvas. Branch from any node to fork the conversation history, or highlight text in a response to branch from that phrase. Canvases and settings persist to `~/.local-lmcanvas/`; each provider's sessions stay in its CLI's own folder.

> **This is a fork.** [xack20/local-lmcanvas](https://github.com/xack20/local-lmcanvas) is based on [max-lee-dev/local-lmcanvas](https://github.com/max-lee-dev/local-lmcanvas) v1.0.4. It adds **browser access over Tailscale**, **context sizes and compaction** for Claude, a per-node Claude model picker, and several canvas and saving improvements. See [What's different in this fork](#whats-different-in-this-fork). All fork work lives on the `local/model-labels` branch.

## What's different in this fork

### Browser access over Tailscale

Use LMCanvas from your other computers in a web browser while the desktop app is open on your Mac. The Mac does all the work: chats, files and agents still run there. The browser shows the same app over your private [Tailscale](https://tailscale.com) network, never the public internet. It's off until you turn it on. [How to set it up](#browser-access).

### Context sizes and compaction

Long Claude conversations no longer run blind. [How it works](#context-window).

- **Sizes on every Claude node:** its own size and the total from the root down to it (`+30k · 42k`), measured by Claude Code, with a bar that turns amber and then red as the window fills.
- **Compaction you can see:** "Compacting conversation…" while Claude Code compacts, and a divider in the reply afterwards.
- **Compaction you control:** **Compact this node** in place, or **Continue from summary** in a new node, with an optional focus. Both can be stopped.
- **Long branches are fitted instead of failing:** a replayed branch is fitted to the model's window, and a session that overflows is compacted and retried once.

### Claude improvements

- **Runs your installed `claude` CLI.** It runs the Claude binary set in Settings: by default `claude`, looked up on your `PATH`, and `~/` paths work. It must be an executable file; shell aliases and functions don't count. If it isn't one, or the field is empty, it falls back to the Agent SDK's bundled CLI (Claude Code 2.1.141), which is too old for newer models such as Opus 5.5. Chats, canvas naming, group summaries, the model list, compaction and replay summaries all use it.
- **Any Claude Code model, per node.** The node model picker lists the models your installed Claude Code offers, asking it directly (via the Agent SDK's `supportedModels()`) without your Claude Code settings, so a `model` or `availableModels` set in `~/.claude/settings.json` isn't reflected. The list covers aliases such as Opus 5.5, Fable 5.1, Sonnet 5.5 and Haiku 4.5, plus pinned older versions.
  - **The list stays current.** While a window is open, LMCanvas asks Claude Code again at most every 10 minutes, so a model a Claude Code update adds usually appears within about 20 minutes, or sooner when you open the picker or refocus the window. A model Claude Code drops is marked "no longer offered".
  - **Settings model** (top entry) follows the model chosen in Settings → **advanced** → **claude**, which is now a dropdown of the same list. Out of the box that setting is upstream's `claude-fable-5`; choose **Claude Code default** there to let Claude Code pick.
  - Picking another entry sets that node's own model. New root nodes start with the node settings you changed last, model included; pick **Settings model** to go back.
  - Codex and Cursor no longer appear in the picker. Picking a model on a Codex or Cursor node switches it to Claude, and new nodes then start on Claude too, because they copy the settings you changed last.
  - If Claude Code can't be asked, the picker falls back to its aliases (Default, Opus, Fable, Sonnet, Haiku) and asks again the next time the list is needed, at least a minute later.
- **Correct model labels.** Badges show Claude Code's name for the model (e.g. "Opus 5.5"). Claude Code's own default is shown as the model it resolves to without your Claude Code settings. Other Claude ids are parsed (e.g. `claude-opus-5-5` → "Opus 5.5"), including legacy, dotted, date-suffixed and Bedrock/Vertex-style ids.
- **Thinking effort per node.** A gauge badge on each Claude node (and in the side-panel composer) picks Default or one of the levels the node's model supports, passed to Claude as `--effort`. For example, Opus 4.6 has no Extra High, and the badge is hidden for Haiku, which takes no effort level. Default passes nothing, so Claude Code's own default applies. An effort the model can't take is dropped whenever Claude Code's model list knows the model; if the list isn't available, every level except Haiku's is passed through.
  - New child nodes inherit their parent's node settings, including model and effort. A child of a node with no settings of its own starts with the settings you changed last.
  - Switching a node to a model that can't take its effort clears the effort.

### Canvas improvements

- **Richer node toolbar.** Nodes and the side-panel composer show model, effort, context, folder, branch, FAST and PLAN badges. Long folder and branch names shrink to fit, and "on" states are clearly coloured. In the side panel, the badges change the node shown there, and your reply inherits them.
- **Side panel on demand.** The node side panel no longer opens on every click. To open it, hover over or select a node you've sent a prompt from, then click the side-panel icon under it (tooltip "Open in side panel"). Deselecting closes the panel.
- **Full-width nodes.** New nodes, and existing nodes you never resized, are 1100 px wide. Drag a node's right edge to narrow it, down to 450 px.
- **Chats fit the window.** Opening a chat zooms so all nodes fit across the window, never above 100%. Short chats are centred; tall ones start at the top. Focusing a node caps the zoom so the node's full width fits the visible canvas.
- **Sidebar closes on pick.** Picking a chat or thread in the sidebar closes the sidebar.
- **Input-method fix.** Enter no longer submits while an input method (Chinese, Japanese, Korean, Bengali, …) is still composing. Ported from upstream PR #3.

### Chats and saving

- **A chat is edited in one place at a time.** This covers desktop windows, browser tabs and devices. Opening a chat that's open elsewhere shows it read-only with a **Take over here** button. If a reply was running there when you opened the chat, the prompt says so. Taking over stops any reply or compaction still running there, and the place you took it from turns read-only, losing changes it hadn't saved yet.
- **Replies and compactions keep saving after you switch canvases.** If you switch away while a reply or a compaction is running, its result is still saved when it finishes.
- **A failed save no longer blanks the canvas.** It shows a small "Couldn't save: <reason>. Retrying…" banner and retries, starting after 5 seconds and backing off to once a minute.

### Updates

- **Auto-update is off.** An upstream release would silently replace this patched build. **Check for Updates…** in the LMCanvas menu shows an "Updates are off" notification telling you to rebuild from your local checkout instead. See [Build and install this fork](#build-and-install-this-fork-macos).

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` binary in `$PATH`)
- [Bun](https://bun.sh) 1.1+ (this fork is tested with 1.4)
- [Node.js](https://nodejs.org) 20+ on your `PATH`: the dev and build tools run under Node
- macOS / Linux / Windows
- For browser access only: a Mac with the [Tailscale app](https://tailscale.com/download/mac) installed at `/Applications/Tailscale.app` and signed in, plus Tailscale signed in to the same account on the other computer.
- Optional: the Codex CLI, for the Codex provider (`codex` on your `PATH`, or its path in Settings → **advanced** → **codex** → **binary path**) and for `codex:smoke` (`codex` on your `PATH`, or set `CODEX_BIN`).

Verify Claude Code works:

```bash
claude -p "say hi" --output-format stream-json --verbose | head
```

## Run

```bash
bun install
bun run dev
```

Validate the app and the locally installed Codex harness:

```bash
bun run typecheck
bun run codex:smoke
bun run codex:protocol-check
```

`codex:smoke` initializes the app-server, reads its model catalog, and creates an
ephemeral thread; it does not make a model request. `codex:protocol-check`
compares LMCanvas's boundary with Codex's generated upstream schema, which it
downloads from GitHub. Set `CODEX_SOURCE_DIR` to a local `openai/codex` checkout
for an offline check.

The Electron window opens automatically. Upstream builds a distributable with:

```bash
bun run dist   # .dmg (arm64 and x64) on macOS, Linux packages on Linux, an .exe installer on Windows
```

On macOS that build is set up for upstream's signed and notarized releases, which need a Developer ID certificate and notarization credentials; without them the DMGs are unsigned. To install this fork on a Mac, see [Build and install this fork](#build-and-install-this-fork-macos).

## Tests

This fork adds unit tests (`*.test.mjs`, run with Bun). Run each file in its own `bun test` process; never pass several files to one `bun test` invocation. This loop also picks up new, uncommitted test files:

```bash
for f in $(git ls-files --cached --others --exclude-standard '*.test.mjs'); do bun test "$f" >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"; done
bun run typecheck
```

Why one file at a time:
- `settings.test.mjs` points `HOME` at a temporary folder before it loads the storage modules.
- Bun shares modules between test files in one run, so if another file loads them first, that test refuses to run.

Other notes:
- `src/shared/history.test.mjs` is upstream's plain assert script. Bun reports "0 tests" for it but still fails the run if an assertion breaks.
- Bun's test runner swaps the `ws` package for its own WebSocket implementation, which ignores some options (such as `maxPayload`). The tests use `bun:test` and can't run under Node. Check WebSocket limits against the running app instead, which uses the real `ws` package.

## Build and install this fork (macOS)

The fork isn't notarized. Build the app, sign it ad hoc, and install it over the existing copy. These commands are for Apple silicon. On an Intel Mac, use `--x64`; the app then lands in `dist/mac/` instead of `dist/mac-arm64/`.

```bash
rm -rf dist out && bun run build
bunx electron-builder --mac dir --arm64 --publish never -c.mac.notarize=false -c.mac.identity=null
codesign --force --deep --sign - --options runtime --entitlements build/entitlements.mac.plist dist/mac-arm64/LMCanvas.app
codesign --verify --deep --strict dist/mac-arm64/LMCanvas.app
# Make sure no chat or compaction is running, then quit. With browser access on,
# quitting waits for the Tailscale teardown, so wait for the process to exit.
osascript -e 'tell application "LMCanvas" to quit'; while pgrep -x LMCanvas >/dev/null; do sleep 1; done
rm -rf /Applications/LMCanvas.app && ditto dist/mac-arm64/LMCanvas.app /Applications/LMCanvas.app && open -a /Applications/LMCanvas.app
```

To pick up upstream changes:

```bash
git remote add upstream https://github.com/max-lee-dev/local-lmcanvas.git   # once
git fetch upstream && git merge upstream/main                                # on local/model-labels
```

Then rebuild. `upstream/main` is the release line this fork is based on.

## Browser access

### Turn it on

1. **Enable HTTPS certificates for your tailnet.** In the Tailscale admin console, open **DNS** and turn on **HTTPS Certificates**. You only need to do this once.
2. **Turn on access.** On the Mac, open LMCanvas **Settings → Browser access** and turn on **Browser access over Tailscale**. It shows `On at https://<your-mac>.<your-tailnet>.ts.net`.
3. **Create a pairing link.** The **Pair a device** box appears once access is running. Click **Create link**; there's a **Copy** button to copy it.
4. **Pair the other computer.** Open the link on that computer and click **Pair this browser** within 10 minutes of creating it. LMCanvas opens in that browser.
5. **Use it.** Later, open `https://<your-mac>.<your-tailnet>.ts.net` in the same browser. Each browser or browser profile is paired separately.

### While it's on

- **Only while the app is open.** Access lasts only while the desktop app is open.
  - Quitting stops it, and so does closing the last LMCanvas window, because that quits the app.
  - Relaunching brings access back by itself if it was on.
  - Turning it off stops it at once.
- **Stopping access stops browser chats.** Turning access off or quitting also stops any replies started from a browser.
- **Keep Mac awake** (on by default) stops the Mac from idling to sleep while access is on. Closing the lid still sleeps the Mac unless it's on power with an external display.
- **Devices.** Paired devices are listed in Settings with when they were last seen. **Remove** cuts a device off immediately; it needs a new pairing link to come back.
- **If it fails to start on relaunch** (for example, Tailscale isn't running yet), the switch stays on and shows the problem. Turn it off and on again to retry.

### How it stays private

- **Tailnet only.** LMCanvas publishes itself with `tailscale serve` (HTTPS 443 → `http://127.0.0.1:4317`). It never uses Tailscale Funnel.
  - It won't start if HTTPS on the Mac is shared publicly with Funnel, or is already used by another Serve setup.
  - When access stops, it turns off HTTPS 443 in Tailscale Serve, but only if that port still points at LMCanvas.
- **Every request is checked.** It must:
  - carry the Mac's `.ts.net` name as its Host. The server listens on `127.0.0.1` only, so it's reachable only through Tailscale Serve or from programs on the Mac itself;
  - come from the Tailscale account that owns the Mac;
  - come from a paired browser, identified by an `HttpOnly; Secure; SameSite=Strict` device cookie that lasts a year;
  - send an `Origin` of exactly `https://<your-mac>.<your-tailnet>.ts.net` on every non-GET request and on the live WebSocket connection.
- **Refused requests learn little.** An unpaired browser on your own account sees "This device isn't paired yet"; anything else gets a plain "Forbidden". Refusals are logged with the method, path and reason only. Pages can't be embedded in other sites.
- **Only hashes are stored.** The Mac stores hashes of device keys and pairing tokens, never the keys themselves.
- **Pairing links are guarded.**
  - Each link works once and expires after 10 minutes.
  - It needs a confirming click, so link previews can't use it up.
  - All open links die when access is turned off.
- **Desktop-only controls stay on the Mac.** Browser-access settings, pairing, device removal and native dialogs can't be used from a browser.
- **Only pair your own devices.** Apart from those desktop-only controls, a paired browser can do what the desktop app can. That includes running agents and commands in your folders, starting processes, compacting chats, and changing general settings such as the Claude binary path.

### What's different in a browser

- **Folder picker:** an in-app folder browser, limited to your Mac's home folder.
- **Opening a file:** copies its path instead.
- **New windows:** open as new browser tabs.
- **Provider sign-in:** has to happen on the Mac.
- **Built-in web panel:** the globe button is hidden.
- **Taking over a chat:** works as on the desktop; see [Chats and saving](#chats-and-saving).
- **Dropped connections:** a banner shows *Lost connection to your Mac. Reconnecting…*.
  - If the tab reconnects within about 2 minutes, the output it missed is replayed, up to 5,000 events or 8 MB.
  - Past that, the tab's running chats are stopped.
- **Closing or reloading a tab** stops the replies and compactions it started and frees its chats at once.
- **Saving:** failed saves retry automatically, and retry again when the connection comes back.
- **Supported devices:** computers only for now. Phone and tablet layouts, and live sync of chat lists across open tabs, are planned.

### Troubleshooting browser access

On the Mac, in Settings:

| Message | Fix |
| --- | --- |
| Tailscale isn't running | Open the Tailscale app on the Mac and sign in. LMCanvas only finds the app at `/Applications/Tailscale.app`; a Tailscale installed elsewhere, or CLI-only, shows this too. |
| Tailscale isn't signed in on this Mac | Sign in to Tailscale. |
| HTTPS certificates are off for your Tailscale network | Turn on HTTPS in the admin console (DNS page). |
| HTTPS on this Mac is already used by another Tailscale Serve setup | Remove the other `tailscale serve` config, or leave it and don't use browser access. |
| HTTPS on this Mac is shared publicly with Tailscale Funnel | Turn Funnel off for port 443. |
| Port 4317 on this Mac is already in use | Stop the other program using port 4317. Tools such as an OpenTelemetry collector use it by default. |
| Couldn't set up Tailscale Serve: … | The `tailscale serve` command failed; the reason follows the colon. |
| On, but not running yet. | Access is switched on but hasn't started. Turn it off and on again. |

In the browser:

| Message | Fix |
| --- | --- |
| This device isn't paired yet | Create a pairing link on the Mac and open it in this browser. |
| This pairing link has expired or was already used | Create a new link. |
| This browser is no longer paired. Open a new pairing link from the Mac. | The device was removed. Pair it again. |
| Forbidden | You reached the Mac some other way than its `.ts.net` address, or you're signed in to Tailscale with a different account. |
| This request is too large (limit 25 MB). | Something you tried to send, such as a canvas with large images, is over 25 MB. |

The design and its reasoning are in [docs/superpowers/specs/2026-10-05-browser-mode-design.md](./docs/superpowers/specs/2026-10-05-browser-mode-design.md). The build plan is in [docs/superpowers/plans/2026-10-05-browser-mode.md](./docs/superpowers/plans/2026-10-05-browser-mode.md).

## Context window

This covers Claude nodes only. Codex and Cursor nodes show no sizes, and none of the compaction or fitting below applies to them.

### Reading the sizes

The context badge sits in each Claude node's toolbar, after the model and effort badges. It shows a small pie that fills with the share of the window in use, then the size:

| Node | Badge | Meaning |
| --- | --- | --- |
| Root | `12k` | Everything the model holds after this node, including Claude Code's own setup (system prompt, tools, CLAUDE.md files). |
| Any other node | `+30k · 42k` | This node added 30k; the total from the root down to here is 42k. |
| Estimate | `~+3k · ~63k` | Not measured yet (see below). |

Sizes read like `950`, `12k` or `1.3M`. The pie and the text turn amber at 70% of the window and red at 90%, and so does the 2-pixel bar along the node's bottom edge. Hovering the badge shows `Context: +30k · 42k of 200k · click for details`.

Click the badge for details:

- **This node** and **Root → here** (the root shows only the first).
- **Window**, e.g. `200k · 21%`: what Claude Code reported for this node or the nearest measured node above it, or 200k until something on the path has been measured. The percentage isn't capped, so it can read over 100%.
- **Auto-compact**: `at 167k`, or `off · 167k` if auto-compaction is off in your Claude Code settings.
- **Breakdown**, e.g. `setup 18k · chat 3k · tools 1k`. Setup is Claude Code's fixed part, chat is the conversation, and tools is tool output.
- **Compactions**: how many compactions and fittings this node's session carries, e.g. `2 on this path`.
- Auto-compact and Breakdown appear once the node itself has been measured, and Compactions only when there is at least one.
- On the canvas, the compaction controls (see [Compacting yourself](#compacting-yourself)).

How the numbers work:

- **Measured by Claude Code.** At the end of each successful Claude run, and after each compaction, LMCanvas asks the session for its context usage. It waits up to 15 seconds (about 1 second normally, around 5 on a freshly started Claude Code). Each run starts by clearing the node's old size, so a run that fails or is stopped leaves an estimate.
- **Estimates** (`~`) are shown while a reply runs, for nodes made before this feature, and when a measurement didn't arrive. They count about 4 characters per token of the visible conversation (thinking is skipped, and long tool input and output are cut short), on top of the nearest measured node above, or a 20k setup allowance. The next successful run replaces them with exact numbers. A new conversation you haven't sent shows `~20k`, just that allowance; a new branch shows `~+0` on top of its parent's size.
- **Own size** is measured from the parent's measured size when the node ran (or its current size, if it wasn't measured then). A merge node is measured from its largest parent. A node whose own reply contains a compaction or fitting divider (including a Summary node) owns everything it holds, so it reads like `+29k · 29k`.
- **In the side panel,** the composer shows the same badge for the node you're replying to, with the details but without the compaction controls.

### When Claude Code compacts

Claude Code compacts a session by itself when it nears the window, unless you turned auto-compaction off. While it does, the reply's "Generating response…" reads "Compacting conversation…". Afterwards a divider stays in the reply, such as `Context compacted: 940k → 62k (auto)`. When Claude Code doesn't report sizes, it reads just `Context compacted (auto)`.

### Compacting yourself

Two actions, in the panel of a node's context badge on the canvas and in its right-click menu:

- **Compact this node** runs Claude Code's `/compact` on the node's own session, in place.
  - The node's reply gets a divider such as `Context compacted: 412k → 38k (manual)`, and its badge drops to the new size, or shows an estimate if Claude Code doesn't report one.
  - Child nodes that already replied keep resuming their own sessions, and measured children keep their sizes. New children, and children that haven't replied yet, start from the compacted session.
- **Continue from summary** compacts a copy of the node's session and puts the result in a new child node. The original node and its branch's conversations stay as they were; as with ⌘+B, a child already in the new node's spot is pushed aside.
  - The new node is titled **Summary** in the side panel and the timeline. On the canvas its prompt reads "Continue from summary", and its reply holds the divider and Claude's summary of the branch. It lands to the right of the original and is selected.
  - Add a child under it to carry on from the summary.
  - If Claude Code didn't hand over the summary text, the reply reads "Claude compacted this branch, but its summary text isn't available."

Details:

- **Focus.** The badge panel has a **Focus** field (up to 500 characters), sent as `/compact <focus>` to steer the summary, e.g. "keep the API decisions". The right-click menu compacts without a focus.
- **When it's available.** The node needs a Claude session, which it has after its first Claude reply. Without one, the panel's buttons are greyed out and the right-click menu leaves the two items out. While the node is replying or compacting, both are greyed out. A chat that's read-only here is covered by its take-over notice.
- **While it runs,** the node shows "Compacting conversation…" with a spinner. Hover over the spinner and click it to stop. Stopping before Claude Code has compacted changes nothing. After that, Stop can't undo it: **Compact this node** keeps the compaction, and **Continue from summary** still adds the Summary node, either with an estimated size. The node's prompt can't be sent or edited meanwhile, and switching to another canvas doesn't lose the result.
- **If it fails,** the node shows "Couldn't compact: <reason>" in red, with a × to dismiss it, and nothing changes. For example, Claude Code answers "Not enough messages to compact." for a very short session.
- **What runs.** Compaction is a real Claude call with the node's model, in the node's folder, limited to 10 minutes. LMCanvas refuses any tool request while it compacts. A Summary node's cost counts in the model badge's totals; an in-place compaction's cost isn't included there yet.
- **From a browser,** a paired browser that has the chat open can compact too.

### Long branches

A Claude node normally continues a Claude Code session: its own, or a copy of its parent's. When it has none, the branch is replayed to Claude Code as text instead. That happens under a parent that ran on Codex or Cursor, when the parent has no session, and on a merge node's first prompt (the first parent's branch is replayed, and every parent, the first included, adds its last exchange, with replies cut to 200 characters). LMCanvas works to keep both paths from failing on length:

- **Replays are fitted first.** A replay is estimated at about 4 characters per token, plus 20k for setup, and must fit in 80% of the model's window. The window comes from `~/.local-lmcanvas/model-windows.json`, which LMCanvas fills from its measurements. It is 200k for a model it hasn't measured yet, or can't identify, such as Claude Code's default model on the bundled CLI.
  - If it doesn't fit, the newest messages are kept word for word (up to half the budget), and the older ones are summarized by separate Claude calls with no tools (one per chunk for very long branches). The reply shows a divider such as `Earlier messages were summarized to fit: 250k → 120k`, using estimated sizes.
  - If summarizing fails, the oldest messages are left out instead: `Earlier messages were left out to fit`.
  - If Claude Code still says the prompt is too long (code and non-Latin text run denser than 4 characters per token), LMCanvas drops the summary and leaves out the oldest messages instead, retrying up to three times with half, a quarter and an eighth of the budget.
- **A resumed session that overflows** (for example, when auto-compaction is off in your Claude Code settings) is compacted once and the reply retried. A node's own session is compacted in place; a session copied from the parent is compacted as a new copy, so the parent stays as it was. The divider reads `Context compacted: … (auto)`.
- **Stop works throughout**, including while summarizing and compacting.
- **If nothing fits,** the reply ends with an error; see [Troubleshooting](#troubleshooting).

### Good to know

- **The bundled CLI works too.** Sizes and compaction also work when LMCanvas falls back to the Agent SDK's bundled Claude Code.
- **Edit `model-windows.json` only while LMCanvas is closed.** The app reads it at launch and overwrites it whenever it measures a new or changed window.
- **A run stays open for up to 15 seconds after its reply** (usually about a second) while its size is measured. Meanwhile, opening the chat elsewhere says a reply is still running.
- **The side panel shows "Generating response…"** while a node compacts during a reply; the "Compacting conversation…" label appears on the canvas node.

The original design and its reasoning are in [docs/superpowers/specs/2026-10-05-context-window-design.md](./docs/superpowers/specs/2026-10-05-context-window-design.md), and the build plan is in [docs/superpowers/plans/2026-10-05-context-window.md](./docs/superpowers/plans/2026-10-05-context-window.md). Where they differ from this README, the README matches the code.

## Release

**Don't run the release flow in this fork.** It's upstream's process, kept here for reference:
- it bumps the version, commits, tags, pushes to `origin` and creates a GitHub release;
- `package.json`'s publish settings still point the built app's update feed at the upstream repository;
- it needs an Apple Developer ID and notarization credentials.

Install the fork from a local build instead. See [Build and install this fork](#build-and-install-this-fork-macos).

Upstream's maintainers start a signed and notarized macOS release in the background:

```bash
bun run release:start patch
bun run release:status
bun run release:logs
```

Store notarization credentials in the macOS Keychain once, then add only the
profile name to `.env.release`:

```bash
xcrun notarytool store-credentials "lmcanvas-notary" --apple-id "you@example.com" --team-id "TEAMID"
APPLE_KEYCHAIN_PROFILE=lmcanvas-notary
```

`store-credentials` prompts securely for the app-specific password. Avoid
putting `APPLE_APP_SPECIFIC_PASSWORD` in `.env.release`; the legacy env-based
flow remains supported only as a fallback.

The one-shot macOS background job keeps running if the launching terminal closes,
does not restart after completion, and prevents idle sleep while it runs. Release
state and logs live under `~/.local/state/local-lmcanvas/release/`. The repository
must be clean before a release starts. `minor`, `major`, and `--no-bump` are also
supported.

## Architecture

```
src/
├── main/              Electron main process (Node)
│   ├── index.ts       handler registration, BrowserWindow setup, chat runs (replay fitting,
│   │                  overflow retry), browser-access wiring
│   ├── api/           one call table for IPC and the web server (desktop-only unless marked shared),
│   │                  clients (desktop window or browser tab), active chats and compactions
│   ├── claude/        Claude Agent SDK integration:
│   │                  runner.ts (a chat run; measures the context at the end), configuredBin.ts (finds
│   │                  your claude CLI), models.ts (Claude Code's model list), contextUsage.ts,
│   │                  systemEvents.ts (compaction events), compaction.ts (/compact in place or on a copy),
│   │                  modelWindows.ts, replayFit.ts + replaySummary.ts (fitting a replay),
│   │                  overflowRetry.ts
│   ├── agents/        provider adapters and persistent Codex app-server transport
│   ├── web/           browser access: service.ts (Tailscale checks, port, keep-awake, on/off),
│   │                  loopback server, security gate, Tailscale Serve control, paired devices,
│   │                  browser clients (reconnect + replay), canvas locks
│   ├── autoUpdate.ts  updates switched off for this fork
│   └── storage/       canvases and settings.json under ~/.local-lmcanvas/
├── preload/           contextBridge: exposes window.api to renderer
├── renderer/          React UI (xyflow canvas, zustand store)
│   └── src/
│       ├── components/Canvas/ node cards and badges, incl. ContextBadge, ContextBar, CompactActions
│       ├── lib/webBridge.ts   window.api over HTTPS + WebSocket when running in a browser
│       ├── lib/compactNode.ts the compaction actions and the Summary node
│       └── components/web/    browser-only UI: connection banner, notices, folder picker
└── shared/            types + graph logic used by both sides, incl. contextSize.ts (size math and
                       labels), claudeModels.ts (model and effort rules), canvasLock.ts
```

In the desktop app, renderer → main calls go over IPC (`window.api.canvases.list()`, etc.). In a browser, most `window.api` calls become HTTPS requests plus one WebSocket, handled by the same call table. Native-only calls are replaced in the browser; see [What's different in a browser](#whats-different-in-a-browser). New channels are desktop-only unless registered as shared.

## Storage

```
~/.local-lmcanvas/
├── canvases/
│   └── <id>.json        one file per canvas
├── settings.json        among other things: default provider, each provider's binary path and model, the
│                        node settings you changed last, recent folders and branches, browser-access
│                        on/off and keep-awake, and the system prompt (no field in Settings; edit it here)
├── model-windows.json   context window per Claude model, as measured (sizes replays to fit; read at launch)
└── web-devices.json     paired browsers: name, dates, and a hash of each device key
```

Files are human-readable JSON. Appearance, canvas preferences and keybindings are kept in local storage instead, so each paired browser keeps its own.

## Keyboard shortcuts

| key | action |
| --- | --- |
| `Enter` | submit the prompt in the focused input (`Shift+Enter` for a new line; `Esc` cancels editing a sent prompt) |
| `Enter` with text highlighted in a response | branch from that text |
| `⌘+B` / `Ctrl+B` | add a blank child node to the right of the selected node |
| `Backspace` / `Delete` | delete the selected node(s), after confirming |
| `⌘+F` / `Ctrl+F` | search |
| `⌘+K` / `Ctrl+K` | command palette |
| `⌘+S` (`Ctrl+S` elsewhere) | split-pane picker (rebind it in Settings → Keybindings) |
| right-click the empty canvas | **Add new node** or **Add temporary node** |
| right-click a node | **Add child node**, **Add temporary child node**, **Delete node**; on a Claude node with a session also **Compact this node** and **Continue from summary** |

## Troubleshooting

**Claude shows "Install" in Settings, or onboarding says "spawn claude ENOENT"** — LMCanvas can't find your `claude`. Open Settings (gear icon, top right) → **advanced** → **claude** → **binary path**, enter the full path to the executable (e.g. `/Users/you/.local/bin/claude`), then click **save**. Ignore "claude binary path (legacy)". Until then, chats run on the older bundled CLI.

**A new model fails to run** — this fork runs your installed `claude`. Update Claude Code (`claude update`), or set its full path in Settings. If that path isn't an executable file, LMCanvas falls back to the older bundled CLI.

**Sizes keep showing `~`** — the node's latest Claude run is still going, failed or was stopped (each run clears the old size), it hasn't run since this feature, or Claude Code didn't report the size within 15 seconds. The next successful run or compaction measures it.

**"Couldn't compact: Not enough messages to compact."** — Claude Code won't compact a very short session. Nothing changed; there's nothing to gain yet.

**"This conversation is too long for the model, even with its earlier messages left out."** — a replayed branch still didn't fit after three smaller tries. The new prompt is always sent whole, so it is usually the prompt itself, with any text you quoted into it, that is too big. Shorten it.

**"This conversation is too long for the model, and compacting it failed: …"** — the node's session overflowed and Claude Code couldn't compact it; the reason follows the colon. If the reason is "Not enough messages to compact.", the prompt itself (with any text quoted into it) is too big: shorten it. Otherwise branch from an earlier node or start a new conversation. On a node's first prompt the failed compaction was already of a copy of its parent's session, so **Continue from summary** on the parent usually fails the same way. If the retry after compacting overflows again, Claude Code's own "too long" error is shown.

**"This chat is open in the desktop app." / "This chat is open in another browser tab or device." / "This chat was opened somewhere else."** — the chat is being edited somewhere else, so it's read-only here. Use **Take over here**.

**Blank window** — check the DevTools console (opens automatically in dev). For prod, `bun run dev` once to see errors.

For browser access, see [Troubleshooting browser access](#troubleshooting-browser-access).

## Contributing

PRs welcome — including AI/vibe-coded ones. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, conventions, and how to file issues. AI agents should also read [AGENTS.md](./AGENTS.md).

General LMCanvas changes belong upstream at [max-lee-dev/local-lmcanvas](https://github.com/max-lee-dev/local-lmcanvas). Everything under [What's different in this fork](#whats-different-in-this-fork) exists only here, so changes to it belong here.

## Vision

Local-first, canvas-native, bring-your-own-CLI. See [VISION.md](./VISION.md) for the longer take and [CHANGELOG.md](./CHANGELOG.md) for what's shipped upstream.

## Security

Report vulnerabilities in upstream code privately via [GitHub Security Advisories](https://github.com/max-lee-dev/local-lmcanvas/security/advisories/new). See [SECURITY.md](./SECURITY.md). For code that exists only in this fork (everything under [What's different in this fork](#whats-different-in-this-fork)), contact the fork owner, [@xack20](https://github.com/xack20), on GitHub.

SECURITY.md describes upstream, which doesn't listen on any port. With browser access on, this fork listens on `127.0.0.1:4317` and publishes it to your tailnet with `tailscale serve`; see [How it stays private](#how-it-stays-private).

## License

[MIT](./LICENSE) © 2026 Max Lee
