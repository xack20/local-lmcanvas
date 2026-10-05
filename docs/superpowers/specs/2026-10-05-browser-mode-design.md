# Browser mode (project 1 of 3): use LMCanvas from a browser over Tailscale

**Date:** 2026-10-05
**Status:** design approved in conversation, awaiting written-spec review
**Branch:** `local/model-labels` (local fork of max-lee-dev/local-lmcanvas, based on v1.0.4)

## Goal

Open the LMCanvas interface in a web browser on another computer (and later a
phone or tablet) and use it exactly like the desktop app, reaching the Mac
privately through Tailscale. The desktop app stays the owner of all data and
the only place Claude actually runs.

## Decisions already made

| Question | Decision |
|---|---|
| Where it's used from | Anywhere, but only through the user's own Tailscale network |
| Devices | Computers first; phone/tablet is project 3 |
| When it's available | Only while the desktop app is open (no background service) |
| Approach | A "second door" inside the desktop app (not a rewrite, not screen sharing) |
| Phasing | 1: browser mode for computers (this spec) → 2: live sync between windows → 3: phone/tablet layout |

## Scope

**In scope (project 1):** embedded web server, web adapter for the interface,
Tailscale Serve setup, security layers, device pairing, browser substitutes
for desktop-only features, one-place-at-a-time chat lock, reconnect with
replay, Settings UI for all of it.

**Out of scope:** live multi-window sync (project 2), touch and small-screen
layout (project 3), public internet exposure (Tailscale Funnel is never used),
running without the desktop app open.

## Architecture

### Main process (desktop app's background process)

1. **Shared call table** — `src/main/api/registry.ts`
   The 21 existing `ipcMain.handle` handlers move into one table:
   `channel → (client, ...args) => Promise<result>`. Electron IPC registers
   every entry with `ipcMain.handle`; the web server dispatches to the same
   entries. No handler logic is duplicated or forked.

2. **Client** — `src/main/api/client.ts`
   `type Client = { id: string; kind: "desktop" | "browser"; send(channel, payload): void; isGone(): boolean }`.
   Implemented by an Electron `WebContents` wrapper and by a WebSocket
   connection wrapper. Everything that currently takes `WebContents` or
   `event.sender` (`chat:event` streaming, `askUser:request` in
   `askUserBridge.ts`, `runner.ts` options) takes a `Client` instead, so
   output and Claude's questions go back to whichever client started a chat.

3. **Web server** — `src/main/web/server.ts`
   Node's built-in `http` server plus the `ws` package (the only new
   dependency). Listens on `127.0.0.1:4317` only, and only while Browser
   access is on.
   - `GET /` and static assets: the same built renderer files the desktop
     window loads (`out/renderer`).
   - `POST /api/:channel`: JSON `{ args: [...] }` → `{ ok: true, result }` or
     `{ ok: false, error }`. Body limit 25 MB (base64 image attachments).
   - `GET /ws`: one WebSocket per tab for live events and the reconnect handshake.
   - `GET /pair?token=…`: device pairing landing (see Security).
   - `GET /api/fs/dirs?path=…`: directory listing for the browser folder picker
     (directories only, never file contents).

4. **Chat lock** — `src/main/web/canvasLocks.ts`
   Tracks which client has each canvas open. Opening a canvas held by another
   client returns `locked` with the holder's kind; the interface offers
   "This chat is open on another device. Take over?". Taking over notifies the
   previous holder, which switches that canvas to read-only. Locks are
   released on close, on client disconnect, or when taken over. Desktop
   windows take part in the same lock.

5. **Replay buffer** — `src/main/web/chatReplay.ts`
   Every chat event sent to a browser client is also kept in a per-chat
   in-memory log. If the client disconnects mid-chat, the chat keeps running
   for up to **2 minutes**; a reconnecting tab sends the chat ids it was
   following and receives the missed events in order. After 2 minutes
   without a reconnect the chat is cancelled and its node is marked
   "stopped: connection lost". Logs are dropped when a chat finishes and has
   been delivered.

6. **Tailscale control** — `src/main/web/tailscale.ts`
   Uses the CLI inside the app bundle
   (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`).
   - On enable: check `status --json` (running, signed in, HTTPS cert
     available); check `serve status` and refuse if HTTPS 443 is already
     served by something else; then `serve --bg --https=443 http://127.0.0.1:4317`.
   - On disable or app quit: remove only the mapping this app created.
   - Never calls `funnel`.
   - Reports the resulting `https://<host>.<tailnet>.ts.net` address.

7. **Keep awake** — Electron `powerSaveBlocker` (`prevent-app-suspension`)
   while Browser access is on and the setting is enabled. Lid-closed sleep is
   a macOS rule and is not overridden; the Settings text says so.

### Interface (renderer)

1. **Web adapter** — `src/renderer/src/lib/webBridge.ts`
   If `window.api` is missing (no Electron preload), install a `window.api`
   with the identical shape from `src/preload/index.ts`: calls become
   `POST /api/:channel`; `chat.onEvent` and `askUser.onRequest` subscribe to
   the WebSocket. Installed before the app mounts in `main.tsx`.
2. **`isBrowser` flag** — exported from the adapter, used only at the
   desktop-only spots listed below.
3. **Connection banner** — "Lost connection to your Mac, reconnecting…"
   with automatic retry (backoff up to 10 s) and the replay handshake.
4. **Lock prompt** — read-only state plus the take-over dialog.
5. **Settings → Browser access** section:
   - On/off toggle (default off)
   - Status line: address, or the exact reason it can't start
   - "Keep Mac awake while browser access is on" toggle
   - Pair a device: QR code + copyable link
   - Paired devices list with name, last seen, and Remove

### Data

Unchanged: `~/.local-lmcanvas` files, read and written only by the desktop
app's main process. New file `~/.local-lmcanvas/web-devices.json` holds paired
device records (id, label, created, last seen, and a **hash** of the device
key — never the key itself). Browser-access settings are stored in the
existing `settings.json`.

## Security

Claude runs with permission prompts skipped (unless PLAN is on), so anyone
who gets through can run commands as the user. Every HTTP request and
WebSocket upgrade must pass **all** of these checks:

1. **Network** — server bound to `127.0.0.1`; remote devices can only arrive
   through Tailscale Serve's proxy.
2. **Host** — `Host` header must equal the Mac's `.ts.net` name (defeats DNS
   rebinding from pages open in a local browser).
3. **Tailscale identity** — `Tailscale-User-Login` (set by Tailscale Serve)
   must equal the Mac owner's Tailscale login, read from `status --json`.
   Requests from other tailnet users or shared-in devices are refused.
4. **Paired device** — a `lmc_device` cookie (`HttpOnly; Secure;
   SameSite=Strict`, 256-bit random key) whose hash is in `web-devices.json`.
   Pairing: Settings shows a QR/link carrying a one-time token valid for
   10 minutes; opening it sets the cookie and records the device. Pairing is
   done at the Mac; afterwards it works from anywhere. Removing a device
   revokes it immediately (including open WebSockets).
5. **Same-site** — state-changing requests and WebSocket upgrades require an
   `Origin` equal to the `.ts.net` origin.

Additional rules:
- Failed checks return a bare 403/401 with no detail, and are logged
  (reason only, never cookie or token values).
- Pairing tokens are single-use and compared in constant time.
- `fs/dirs` lists directory names only.
- Desktop windows keep using Electron IPC; they never go through the web server.

## Desktop-only features in the browser

| Desktop feature | Browser behaviour |
|---|---|
| `dialog:pickFolder` (native dialog) | In-app folder browser backed by `GET /api/fs/dirs`, starting at the home folder |
| `shell:openPath` (open on the Mac) | Hidden; file links render as copyable paths |
| Web links in replies | Open in a new tab |
| `providers:openLogin` (Terminal on the Mac) | Disabled with "Log in on the Mac" |
| `window:openCanvas` | Opens a new tab at `/?canvas=<id>` |
| Built-in web panel (`<webview>`) | Hidden |
| Finish sound | Unchanged |
| App menu / update check | Not shown |

## Error handling

- **Connection lost** — banner, retry with backoff, replay on reconnect,
  2-minute grace period for running chats (see Replay buffer).
- **Cannot enable** — Tailscale not installed, not running, not signed in, no
  HTTPS certificate, HTTPS 443 already served, or port 4317 busy. Settings
  shows which one; the toggle stays off.
- **Request too large** — over 25 MB → `413` and a "too large" message in
  the interface.
- **Handler error** — returned as `{ ok: false, error }` with the same
  message the desktop shows; no stack traces leave the Mac.
- **Desktop app quits** — server stops, Serve mapping removed, browser tabs
  show the connection banner.

## Testing

Automated (`bun test`, `.test.mjs` files beside the code, as in the rest of
this branch):
- Security check function: table of requests (host, identity, cookie, origin,
  path) that must be allowed or refused.
- Pairing: token expiry, single use, cookie hash lookup, revocation.
- Call table: routing, unknown channel, error mapping.
- Replay buffer: ordering, grace-period expiry, cleanup.
- Chat lock: acquire, conflict, take-over, release on disconnect.
- Tailscale control: parses `status --json` / `serve status` fixtures; refuses
  when 443 is taken; never emits a `funnel` command.

Integration:
- Start the server in-process on a random port with a fake call table; real
  HTTP and WebSocket requests prove the allowed path works and each check
  refuses what it should.

Regression:
- `bun run typecheck` passes; with Browser access off, the desktop app
  behaves as before (no server started, no Tailscale calls).

Manual, with the user:
- Pair the Windows or Linux machine over Tailscale, run a chat, PLAN mode,
  the folder picker, a take-over, and a dropped-Wi-Fi reconnect.

## Risks and open questions

- **Tailscale identity headers** must only be trusted on connections from
  Tailscale Serve. Because the server only listens on `127.0.0.1`, a local
  process could forge them. Local processes already run as the user, and
  the device cookie (check 4) still applies.
- **Upstream merges** — this touches `src/main/index.ts` and the preload
  surface, which upstream also changes. The planned update watcher should
  flag conflicts in these files.
- **r-sayar's fork tried a web-server conversion and later went back to
  Electron.** Before implementation, read their revert commit message and
  diff to learn why, and note any lesson in the plan.
