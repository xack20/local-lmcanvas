# local-lmcanvas

A fully local, canvas-based branching AI conversation tool. The Electron app drives your installed Claude, Codex, or Cursor agent harness — no API keys to paste into the app, no database, and no LMCanvas telemetry.

Each conversation is a tree of message nodes on a canvas. Branch from any node to fork the conversation history, or highlight text in a response to branch from that phrase. Everything persists to `~/.local-lmcanvas/`.

> **This is a fork.** [xack20/local-lmcanvas](https://github.com/xack20/local-lmcanvas) is based on [max-lee-dev/local-lmcanvas](https://github.com/max-lee-dev/local-lmcanvas) v1.0.4. It adds **browser access over Tailscale** and several Claude and canvas improvements. See [What's different in this fork](#whats-different-in-this-fork). All fork work lives on the `local/model-labels` branch.

## What's different in this fork

### Browser access over Tailscale

Use LMCanvas from your other computers in a web browser while the desktop app is open on your Mac. The Mac does all the work: chats, files and agents still run there. The browser shows the same app over your private [Tailscale](https://tailscale.com) network, never the public internet. It's off until you turn it on. [How to set it up](#browser-access).

### Claude improvements

- **Runs your installed `claude` CLI.** It runs the Claude binary set in Settings: by default `claude`, looked up on your `PATH`, and `~/` paths work. If that isn't an executable file, it falls back to the Agent SDK's bundled CLI (Claude Code 2.1.141), which is too old for newer models such as Opus 5.5. Chats, canvas naming and group summaries all use it.
- **Any Claude Code model, per node.** The node model picker lists the models your installed Claude Code offers. It asks Claude Code directly (via the Agent SDK's `supportedModels()`), and keeps the list current while LMCanvas runs: models a Claude Code update adds appear on their own within minutes (right away when you open the picker), and a model Claude Code drops is marked "no longer offered". The list covers aliases such as Opus 5.5, Fable 5.1, Sonnet 5.5 and Haiku 4.5, plus pinned older versions.
  - **Settings model** (top entry) follows the model chosen in Settings → Advanced → Claude, which is now a dropdown of the same list. Picking another entry sets that node's own model, and new child nodes inherit it. New root nodes start with the node settings you changed last, model included; pick **Settings model** to go back.
  - Codex and Cursor no longer appear in the picker.
  - If Claude Code can't be asked, the picker falls back to its aliases (Default, Opus, Fable, Sonnet, Haiku).
- **Correct model labels.** Badges show Claude Code's name for the model (e.g. "Opus 5.5"). Claude Code's own default is shown as the model it currently resolves to. Other Claude ids are parsed (e.g. `claude-opus-5-5` → "Opus 5.5"), including legacy, dotted, date-suffixed and Bedrock/Vertex-style ids.
- **Thinking effort per node.** A gauge badge on each Claude node (and in the side-panel composer) picks Default or one of the levels the node's model supports, passed to Claude as `--effort`. For example, Opus 4.6 has no Extra High, and the badge is hidden for Haiku, which takes no effort level. Default passes nothing, so Claude Code's own default applies. An effort the model can't take is never sent.
  - New child nodes inherit their parent's settings, including model and effort.
  - Switching a node to a model that can't take its effort clears the effort.

### Canvas improvements

- **Richer node toolbar.** Nodes and the side-panel composer show model, effort, folder, branch, FAST and PLAN badges. Long folder and branch names shrink to fit, and "on" states are clearly coloured.
- **Side panel on demand.** The node side panel no longer opens on every click. To open it, hover over or select a node you've sent a prompt from, then click the side-panel icon under it (tooltip "Open in side panel"). Deselecting closes the panel.
- **Full-width nodes.** New nodes, and existing nodes you never resized, are 1100 px wide. Drag a node's right edge to narrow it, down to 450 px.
- **Chats fit the window.** Opening a chat zooms so all nodes fit across the window, never above 100%. Short chats are centred; tall ones start at the top. Focusing a node caps the zoom so the node's full width fits the visible canvas.
- **Sidebar closes on pick.** Picking a chat or thread in the sidebar closes the sidebar.
- **Input-method fix.** Enter no longer submits while an input method (Chinese, Japanese, Korean, Bengali, …) is still composing. Ported from upstream PR #3.

### Chats and saving

- **A chat is edited in one place at a time.** This covers desktop windows, browser tabs and devices. Opening a chat that's open elsewhere shows it read-only with a **Take over here** button.
- **A reply keeps saving after you switch canvases.** If you switch away mid-reply, the full reply is still saved when it finishes.
- **A failed save no longer blanks the canvas.** It shows a small "Couldn't save" banner and retries.

### Updates

- **Auto-update is off.** An upstream release would silently replace this patched build. **Check for Updates…** in the LMCanvas menu shows an "Updates are off" notification telling you to rebuild from your local checkout instead. See [Build and install this fork](#build-and-install-this-fork-macos).

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` binary in `$PATH`)
- [Bun](https://bun.sh) 1.1+
- macOS / Linux / Windows
- For browser access only: a Mac with the [Tailscale app](https://tailscale.com/download/mac) installed at `/Applications/Tailscale.app` and signed in, plus Tailscale signed in to the same account on the other computer.

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
compares LMCanvas's boundary with Codex's generated upstream schema. Set
`CODEX_SOURCE_DIR` to a local `openai/codex` checkout for an offline check.

The Electron window opens automatically. Build a distributable with:

```bash
bun run dist   # .dmg on macOS, .AppImage on Linux, .exe on Windows
```

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
# Make sure no chat is running, then quit. With browser access on, quitting
# waits for the Tailscale teardown, so wait for the process to exit.
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
4. **Pair the other computer.** Open the link once on that computer within 10 minutes, then click **Pair this browser**. LMCanvas opens in that browser.
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
  - When access stops, it removes only its own Serve mapping.
- **Every request is checked.** It must:
  - carry the Mac's `.ts.net` name as its Host. The server listens on `127.0.0.1` only, so it's reachable only through Tailscale Serve or from programs on the Mac itself;
  - come from the Tailscale account that owns the Mac;
  - come from a paired browser, identified by an `HttpOnly; Secure; SameSite=Strict` device cookie that lasts a year;
  - send an `Origin` of exactly `https://<your-mac>.<your-tailnet>.ts.net` on every non-GET request and on the live WebSocket connection.
- **Refused requests learn nothing.** They get a bare 401 or 403 and are logged by reason only. Pages can't be embedded in other sites.
- **Only hashes are stored.** The Mac stores hashes of device keys and pairing tokens, never the keys themselves.
- **Pairing links are guarded.**
  - Each link works once and expires after 10 minutes.
  - It needs a confirming click, so link previews can't use it up.
  - All open links die when access is turned off.
- **Desktop-only controls stay on the Mac.** Browser-access settings, pairing, device removal and native dialogs can't be used from a browser.
- **Only pair your own devices.** Apart from those desktop-only controls, a paired browser can do what the desktop app can. That includes running agents and commands in your folders, starting processes, and changing general settings such as the Claude binary path.

### What's different in a browser

- **Folder picker:** an in-app folder browser, limited to your Mac's home folder.
- **Opening a file:** copies its path instead.
- **New windows:** open as new browser tabs.
- **Provider sign-in:** has to happen on the Mac.
- **Built-in web panel:** the globe button is hidden.
- **Taking over a chat:** if a reply is still running on the other side when you take over, the prompt says so, and taking over stops that reply.
- **Dropped connections:** a banner shows *Lost connection to your Mac. Reconnecting…*.
  - If the tab reconnects within about 2 minutes, the output it missed is replayed, up to 5,000 events or 8 MB.
  - Past that, the tab's running chats are stopped.
- **Closing or reloading a tab** stops the replies it started and frees its chats at once.
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

## Release

Maintainers can start a signed and notarized macOS release in the background:

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

**Don't run the release flow in this fork.** It's upstream's process:
- it bumps the version, commits, tags, pushes to `origin` and creates a GitHub release;
- `package.json` still publishes to the upstream repository;
- it needs an Apple Developer ID and notarization credentials.

Install the fork from a local build instead. See [Build and install this fork](#build-and-install-this-fork-macos).

## Architecture

```
src/
├── main/              Electron main process (Node)
│   ├── index.ts       handler registration, BrowserWindow setup, browser-access wiring
│   ├── api/           one call table for IPC and the web server (desktop-only unless marked shared),
│   │                  clients (desktop window or browser tab), active chats
│   ├── claude/        Claude Agent SDK session/fork integration; configuredBin.ts finds your claude CLI
│   ├── agents/        provider adapters and persistent Codex app-server transport
│   ├── web/           browser access: service.ts (Tailscale checks, port, keep-awake, on/off),
│   │                  loopback server, security gate, Tailscale Serve control, paired devices,
│   │                  browser clients (reconnect + replay), canvas locks
│   └── storage/       reads/writes ~/.local-lmcanvas/
├── preload/           contextBridge: exposes window.api to renderer
├── renderer/          React UI (xyflow canvas, zustand store)
│   └── src/
│       ├── lib/webBridge.ts   window.api over HTTPS + WebSocket when running in a browser
│       └── components/web/    browser-only UI: connection banner, notices, folder picker
└── shared/            types + graph logic used by both sides
```

In the desktop app, renderer → main calls go over IPC (`window.api.canvases.list()`, etc.). In a browser, most `window.api` calls become HTTPS requests plus one WebSocket, handled by the same call table. Native-only calls are replaced in the browser; see [What's different in a browser](#whats-different-in-a-browser). New channels are desktop-only unless registered as shared.

## Storage

```
~/.local-lmcanvas/
├── canvases/
│   └── <id>.json        one file per canvas
├── settings.json        system prompt, claude binary path, model, browser-access on/off and keep-awake
└── web-devices.json     paired browsers: name, dates, and a hash of each device key
```

Files are human-readable JSON.

## Keyboard shortcuts

| key | action |
| --- | --- |
| `Enter` | submit the prompt in the focused input (`Shift+Enter` for a new line, `Esc` to cancel) |
| `Enter` with text highlighted in a response | branch from that text |
| `⌘+B` / `Ctrl+B` | add a blank child node to the right of the selected node |
| `Backspace` / `Delete` | delete the selected node(s), after confirming |
| `⌘+F` / `Ctrl+F` | search |
| `⌘+K` / `Ctrl+K` | command palette |
| `⌘+S` (`Ctrl+S` elsewhere) | split-pane picker (rebind it in Settings → Keybindings) |
| right-click the empty canvas → **Add new node** | create a new root node |

## Troubleshooting

**"claude binary not found"** — set the full path in Settings (gear icon), e.g. `/Users/you/.local/bin/claude`.

**A new model fails to run** — this fork runs your installed `claude`. Update Claude Code (`claude update`), or set its full path in Settings. If that path isn't an executable file, LMCanvas falls back to the older bundled CLI.

**Blank window** — check the DevTools console (opens automatically in dev). For prod, `bun run dev` once to see errors.

For browser access, see [Troubleshooting browser access](#troubleshooting-browser-access).

## Contributing

PRs welcome — including AI/vibe-coded ones. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, conventions, and how to file issues. AI agents should also read [AGENTS.md](./AGENTS.md).

General LMCanvas changes belong upstream at [max-lee-dev/local-lmcanvas](https://github.com/max-lee-dev/local-lmcanvas). Browser access exists only in this fork.

## Vision

Local-first, canvas-native, bring-your-own-CLI. See [VISION.md](./VISION.md) for the longer take and [CHANGELOG.md](./CHANGELOG.md) for what's shipped upstream.

## Security

Report vulnerabilities in upstream code privately via [GitHub Security Advisories](https://github.com/max-lee-dev/local-lmcanvas/security/advisories/new). See [SECURITY.md](./SECURITY.md). For code that exists only in this fork (browser access), contact the fork owner, [@xack20](https://github.com/xack20), on GitHub.

## License

[MIT](./LICENSE) © 2026 Max Lee
