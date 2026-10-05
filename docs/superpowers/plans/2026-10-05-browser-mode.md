# Browser Mode (Project 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the LMCanvas interface run in a web browser on another computer, reaching the Mac privately over Tailscale, while the desktop app stays the only place data lives and Claude runs.

**Architecture:** The desktop app's main process gains a "second door": the existing 21 IPC handlers move into one shared call table that both Electron IPC and a new loopback-only HTTP + WebSocket server dispatch to. A `Client` abstraction (desktop window or browser tab) carries live events back to whoever started a chat. In the renderer, a web adapter installs a `window.api` with the identical `LmcApi` shape when there is no Electron preload. Tailscale Serve publishes the server at the Mac's `https://<host>.ts.net` address, and five layered checks guard every request.

**Tech Stack:** Electron 33 / Node 20, TypeScript 5.6 strict, React 19 + Zustand, `ws` (only new dependency), Tailscale CLI, Bun 1.4 (`bun test`, `bun run typecheck`).

**Spec:** `docs/superpowers/specs/2026-10-05-browser-mode-design.md`

## Global Constraints

- TypeScript strict; no `any`; no `@ts-ignore` / `@ts-expect-error`; minimal comments (repo `AGENTS.md`).
- Tests are `.test.mjs` files beside the code, run with `bun test <file>`; `.mjs` keeps `bun:test` out of `bun run typecheck`.
- `bun run typecheck` must pass at the end of every task.
- With Browser access off, the desktop app behaves as before: no server started, no Tailscale calls.
- Server listens on `127.0.0.1:4317` only. HTTPS is provided by Tailscale Serve on port 443. Never run `tailscale funnel`.
- Only new runtime dependency: `ws` (dev: `@types/ws`).
- Request body limit: 25 MB (`25 * 1024 * 1024`). Pairing token: valid 10 minutes, single use. Device key: 32 random bytes. Cookie: `lmc_device`, `HttpOnly; Secure; SameSite=Strict; Path=/`.
- Reconnect grace for running chats: 120 seconds. Browser reconnect backoff: 1 s doubling to a 10 s maximum.
- Desktop-only channels: `dialog:pickFolder`, `shell:openPath`, `providers:openLogin`, `window:openCanvas`, and every `web:*` channel.
- Commit messages: `<type>: <description>` with a body; no attribution lines.
- Work on branch `local/model-labels` in `~/projects/local-lmcanvas`.

## Deviations from the spec (decided while planning)

- **QR code deferred to project 3 (phone/tablet).** A QR code needs a second dependency, and the spec allows only `ws`. Project 1 shows the pairing link with a Copy button.
- **"File links render as copyable paths"** is implemented as: clicking a file link in a browser copies its path and shows "Path copied: …". No change to the link components is needed.
- **Lesson from r-sayar's fork** (it went to a web server, then kept both hosts): (1) shared run logic must live in one place so the hosts can't drift (our shared call table, Task 2); (2) a closed window left its Claude runs going and pending questions unsettled forever, so client loss must abort chats and settle questions (Task 3). Our desktop app has the same bug today; Task 3 fixes it for both.

## Review Focus

1. **A tab closed mid-chat that never comes back.** After 120 s the chat is aborted and its pending question settled, leaving no orphaned `claude` process. Pinned by Task 8 (expiry fires `onGone`) and Task 3 (`abortForClient`).
2. **Two tabs on the same paired computer open the same chat.** The lock is per tab, so the second tab gets the take-over prompt. Pinned in Task 9.
3. **Settings saved from a stale window** (desktop or browser) must not switch Browser access on or off. Pinned in Task 4.
4. **Malformed or oversized request bodies** get 400 / 413, and the server keeps serving. Pinned in Task 10.
5. **A browser calling a desktop-only channel** (`web:createPairingLink`, `shell:openPath`, …) gets 403 and the handler never runs. Pinned in Task 2 and Task 10.

---

### Task 1: Client abstraction and ask-user routing by client

**Files:**
- Modify: `tsconfig.json` (root)
- Create: `src/main/api/client.ts`, `src/main/api/client.test.mjs`
- Create: `src/main/claude/askUserBridge.test.mjs`
- Modify: `src/main/claude/askUserBridge.ts` (full rewrite)
- Modify: `src/main/claude/askUserMcp.ts:2,45,58`, `src/main/claude/runner.ts:100,153,207`, `src/main/agents/types.ts:1,75-77`, `src/main/agents/codex.ts:522,693,880`, `src/main/index.ts` (imports, chat:start `sender`, chat:cancel)

**Interfaces:**
- Produces: `type ClientKind = "desktop" | "browser"`; `interface Client { readonly id: string; readonly kind: ClientKind; send(channel: string, payload: unknown): void; isGone(): boolean; onGone(listener: () => void): () => void }`; `desktopClient(wc): Client` (same `Client` object per WebContents); `requestAnswer(questions, client: Client, nodeId, signal?, timeoutMs?)`; `cancelAllForClient(client: Client): void`; `completeRequest(payload)` (unchanged).

- [ ] **Step 1: Let Bun resolve the `@shared`, `@main` and `@/` path aliases**

Bun reads `paths` only from the root `tsconfig.json`, but they currently live in `tsconfig.node.json` / `tsconfig.web.json`. Replace the root `tsconfig.json` with:

```json
{
  "files": [],
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"],
      "@main/*": ["src/main/*"],
      "@/*": ["src/renderer/src/*"]
    }
  },
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

Run: `bun -e 'import("./src/main/storage/settings.ts").then((m) => console.log(typeof m.readSettings))'`
Expected: `function` (before this step it failed with `Cannot find module '@shared/types'`).

- [ ] **Step 2: Write the failing Client test**

Create `src/main/api/client.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { desktopClient } from "./client.ts";

function fakeWebContents(id = 1) {
  const wc = new EventEmitter();
  wc.id = id;
  wc.destroyed = false;
  wc.sent = [];
  wc.send = (channel, payload) => wc.sent.push([channel, payload]);
  wc.isDestroyed = () => wc.destroyed;
  wc.destroy = () => {
    wc.destroyed = true;
    wc.emit("destroyed");
  };
  return wc;
}

describe("desktopClient", () => {
  test("returns the same client for the same window", () => {
    const wc = fakeWebContents(4);
    expect(desktopClient(wc)).toBe(desktopClient(wc));
    expect(desktopClient(wc).id).toBe("desktop-4");
    expect(desktopClient(wc).kind).toBe("desktop");
  });

  test("forwards send until the window is destroyed", () => {
    const wc = fakeWebContents();
    const client = desktopClient(wc);
    client.send("chat:event", { a: 1 });
    wc.destroy();
    client.send("chat:event", { a: 2 });
    expect(wc.sent).toEqual([["chat:event", { a: 1 }]]);
    expect(client.isGone()).toBe(true);
  });

  test("onGone fires on destroy, and unsubscribing stops it", () => {
    const wc = fakeWebContents();
    const client = desktopClient(wc);
    let fired = 0;
    let removedFired = 0;
    client.onGone(() => fired++);
    const unsubscribe = client.onGone(() => removedFired++);
    unsubscribe();
    wc.destroy();
    expect(fired).toBe(1);
    expect(removedFired).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test src/main/api/client.test.mjs`
Expected: FAIL with `Cannot find module './client.ts'`.

- [ ] **Step 4: Implement `src/main/api/client.ts`**

```ts
import type { WebContents } from "electron";

export type ClientKind = "desktop" | "browser";

export interface Client {
  readonly id: string;
  readonly kind: ClientKind;
  send(channel: string, payload: unknown): void;
  isGone(): boolean;
  onGone(listener: () => void): () => void;
}

type WebContentsLike = Pick<WebContents, "id" | "send" | "isDestroyed" | "once" | "off">;

const desktopClients = new WeakMap<WebContentsLike, Client>();

export function desktopClient(wc: WebContentsLike): Client {
  const existing = desktopClients.get(wc);
  if (existing) return existing;
  const client: Client = {
    id: `desktop-${wc.id}`,
    kind: "desktop",
    send: (channel, payload) => {
      if (!wc.isDestroyed()) wc.send(channel, payload);
    },
    isGone: () => wc.isDestroyed(),
    onGone: (listener) => {
      wc.once("destroyed", listener);
      return () => {
        if (!wc.isDestroyed()) wc.off("destroyed", listener);
      };
    },
  };
  desktopClients.set(wc, client);
  return client;
}
```

- [ ] **Step 5: Run the Client test to verify it passes**

Run: `bun test src/main/api/client.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing ask-user bridge test**

Create `src/main/claude/askUserBridge.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { cancelAllForClient, completeRequest, requestAnswer } from "./askUserBridge.ts";

function fakeClient(id = "c1") {
  const listeners = new Set();
  const client = {
    id,
    kind: "browser",
    sent: [],
    gone: false,
    send(channel, payload) {
      client.sent.push({ channel, payload });
    },
    isGone: () => client.gone,
    onGone(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    die() {
      client.gone = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
  return client;
}

const QUESTIONS = [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }];

describe("askUserBridge", () => {
  test("sends the request to the client and resolves with its answer", async () => {
    const client = fakeClient();
    const answer = requestAnswer(QUESTIONS, client, "node-1");
    const { channel, payload } = client.sent[0];
    expect(channel).toBe("askUser:request");
    expect(payload.nodeId).toBe("node-1");
    completeRequest({ id: payload.id, answers: ["A"] });
    expect(await answer).toEqual({ id: payload.id, answers: ["A"] });
    expect(client.listenerCount()).toBe(0);
  });

  test("resolves as cancelled when the client goes away", async () => {
    const client = fakeClient();
    const answer = requestAnswer(QUESTIONS, client, "node-1");
    const { id } = client.sent[0].payload;
    client.die();
    expect(await answer).toEqual({ id, cancelled: true });
  });

  test("cancelAllForClient settles only that client's requests", async () => {
    const mine = fakeClient("mine");
    const other = fakeClient("other");
    const mineAnswer = requestAnswer(QUESTIONS, mine, "n1");
    const otherAnswer = requestAnswer(QUESTIONS, other, "n2");
    cancelAllForClient(mine);
    expect((await mineAnswer).cancelled).toBe(true);
    const otherId = other.sent[0].payload.id;
    completeRequest({ id: otherId, answers: ["B"] });
    expect(await otherAnswer).toEqual({ id: otherId, answers: ["B"] });
  });

  test("rejects at once when the client is already gone", async () => {
    const client = fakeClient();
    client.gone = true;
    await expect(requestAnswer(QUESTIONS, client, "n1")).rejects.toThrow("Target window is gone");
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bun test src/main/claude/askUserBridge.test.mjs`
Expected: FAIL. The current bridge calls `webContents.isDestroyed`/`once` and has no `cancelAllForClient` export.

- [ ] **Step 8: Rewrite `src/main/claude/askUserBridge.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { AskUserQuestion, AskUserResponsePayload } from "@shared/ipc";
import type { Client } from "../api/client";

type Pending = {
  resolve: (response: AskUserResponsePayload) => void;
  reject: (err: unknown) => void;
  client: Client;
  signal?: AbortSignal;
  abortHandler?: () => void;
  stopWatchingGone?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();

/**
 * Send an ask-user request to the client (window or browser tab) that started
 * the chat and wait for its answers. `nodeId` lets the interface render the
 * prompt inline on the node that initiated the chat.
 */
export function requestAnswer(
  questions: AskUserQuestion[],
  client: Client,
  nodeId: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<AskUserResponsePayload> {
  if (client.isGone()) return Promise.reject(new Error("Target window is gone"));
  if (signal?.aborted) return Promise.reject(new Error("Aborted"));

  const id = randomUUID();
  return new Promise<AskUserResponsePayload>((resolve, reject) => {
    const entry: Pending = { resolve, reject, client, signal };
    if (signal) {
      const onAbort = () => {
        cleanup(id);
        reject(new Error("Aborted"));
      };
      entry.abortHandler = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
    entry.stopWatchingGone = client.onGone(() => {
      cleanup(id);
      resolve({ id, cancelled: true });
    });
    if (timeoutMs && timeoutMs > 0) {
      entry.timeout = setTimeout(() => {
        cleanup(id);
        resolve({ id, cancelled: true });
      }, timeoutMs);
    }
    pending.set(id, entry);
    client.send("askUser:request", { id, nodeId, questions });
  });
}

function cleanup(id: string): Pending | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  pending.delete(id);
  if (entry.signal && entry.abortHandler) {
    entry.signal.removeEventListener("abort", entry.abortHandler);
  }
  entry.stopWatchingGone?.();
  if (entry.timeout) clearTimeout(entry.timeout);
  return entry;
}

export function completeRequest(payload: AskUserResponsePayload): void {
  const entry = cleanup(payload.id);
  if (!entry) return;
  entry.resolve(payload);
}

/** Cancel all in-flight requests originating from a specific client. */
export function cancelAllForClient(client: Client): void {
  for (const [id, entry] of pending) {
    if (entry.client !== client) continue;
    cleanup(id);
    entry.resolve({ id, cancelled: true });
  }
}
```

- [ ] **Step 9: Update the callers from `WebContents` to `Client`**

`src/main/claude/askUserMcp.ts`:
- line 2: `import type { WebContents } from "electron";` → `import type { Client } from "../api/client";`
- line 45: `webContents: WebContents,` → `client: Client,`
- line 58: `requestAnswer(args.questions, webContents, nodeId, abortSignal)` → `requestAnswer(args.questions, client, nodeId, abortSignal)`

`src/main/claude/runner.ts`:
- line 100: `import type { WebContents } from "electron";` → `import type { Client } from "../api/client";`
- line 153 (in `RunClaudeOpts`): `webContents: WebContents;` → `client: Client;`
- line 207: `buildAskUserServer(opts.webContents, opts.nodeId, controller.signal)` → `buildAskUserServer(opts.client, opts.nodeId, controller.signal)`

`src/main/agents/types.ts`:
- line 1: `import type { WebContents } from "electron";` → `import type { Client } from "../api/client";`
- lines 75-77 become:

```ts
  // client/nodeId are claude-specific (askUser MCP), but kept required so
  // the API handler can pass a single opts object to any provider runner.
  client: Client;
```

`src/main/agents/codex.ts` lines 522, 693 and 880: `opts.webContents,` → `opts.client,`

`src/main/index.ts`:
- Add the import: `import { desktopClient } from "./api/client";`
- In the `askUserBridge` import, replace `cancelAllForWebContents` with `cancelAllForClient` and keep the other names as they are.
- In the `chat:start` handler, replace

```ts
    const sender = e.sender;

    const send = (ev: ChatEvent) => {
      if (sender.isDestroyed()) return;
      sender.send("chat:event", ev);
    };
```

with

```ts
    const client = desktopClient(e.sender);
    const send = (ev: ChatEvent) => client.send("chat:event", ev);
```

- In the `runAgent(...)` options (line ~382): `webContents: sender,` → `client,`
- In `chat:cancel` (line ~435): `cancelAllForWebContents(e.sender);` → `cancelAllForClient(desktopClient(e.sender));`

- [ ] **Step 10: Verify**

Run: `bun test src/main/api/client.test.mjs src/main/claude/askUserBridge.test.mjs && bun run typecheck`
Expected: 7 tests pass; typecheck has no errors.

- [ ] **Step 11: Commit**

```bash
git add tsconfig.json src/main/api/client.ts src/main/api/client.test.mjs src/main/claude/askUserBridge.ts src/main/claude/askUserBridge.test.mjs src/main/claude/askUserMcp.ts src/main/claude/runner.ts src/main/agents/types.ts src/main/agents/codex.ts src/main/index.ts
git commit -m "refactor: route live events through a Client instead of WebContents" -m "A Client is anything that can receive chat output and ask-user prompts: today a desktop window, later a browser tab. Root tsconfig gains path aliases so Bun can test main-process modules."
```

---

### Task 2: Shared call table bound to Electron IPC

**Files:**
- Create: `src/main/api/registry.ts`, `src/main/api/registry.test.mjs`
- Modify: `src/main/index.ts` (`registerIpc` body, `whenReady`)

**Interfaces:**
- Consumes: `Client` (Task 1).
- Produces: `type ApiHandler = (client: Client, ...args: never[]) => unknown`; `type ApiScope = "shared" | "desktop-only"`; `class ApiError extends Error { code: "unknown-channel" | "forbidden" }`; `type ApiRegistry = { handle(channel, handler, scope?): void; invoke(channel, client, args: readonly unknown[]): Promise<unknown>; channels(): string[] }`; `createApiRegistry(): ApiRegistry`; `bindRegistryToIpc(registry, ipc: Pick<IpcMain, "handle">, toClient: (sender: WebContents) => Client): void`; module-level `api` registry in `index.ts`.

- [ ] **Step 1: Write the failing registry test**

Create `src/main/api/registry.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { ApiError, bindRegistryToIpc, createApiRegistry } from "./registry.ts";

const desktop = { id: "d", kind: "desktop" };
const browser = { id: "b", kind: "browser" };

describe("createApiRegistry", () => {
  test("routes a call to its handler with the client and args", async () => {
    const api = createApiRegistry();
    api.handle("echo", async (client, a, b) => ({ kind: client.kind, a, b }));
    expect(await api.invoke("echo", browser, [1, "x"])).toEqual({ kind: "browser", a: 1, b: "x" });
  });

  test("rejects unknown channels with code unknown-channel", async () => {
    const api = createApiRegistry();
    const call = api.invoke("nope", desktop, []);
    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(api.invoke("nope", desktop, [])).rejects.toMatchObject({ code: "unknown-channel" });
  });

  test("refuses desktop-only channels for browser clients without running them", async () => {
    const api = createApiRegistry();
    let ran = 0;
    api.handle("web:createPairingLink", async () => ++ran, "desktop-only");
    await expect(api.invoke("web:createPairingLink", browser, [])).rejects.toMatchObject({ code: "forbidden" });
    expect(ran).toBe(0);
    expect(await api.invoke("web:createPairingLink", desktop, [])).toBe(1);
  });

  test("passes handler errors through unchanged", async () => {
    const api = createApiRegistry();
    api.handle("boom", async () => {
      throw new Error("nope");
    });
    await expect(api.invoke("boom", desktop, [])).rejects.toThrow("nope");
  });

  test("refuses a duplicate channel", () => {
    const api = createApiRegistry();
    api.handle("x", async () => 1);
    expect(() => api.handle("x", async () => 2)).toThrow("Duplicate API channel: x");
  });
});

describe("bindRegistryToIpc", () => {
  test("registers every channel and maps the IPC sender to a client", async () => {
    const api = createApiRegistry();
    api.handle("a", async (client, n) => `${client.id}:${n}`);
    const handlers = new Map();
    bindRegistryToIpc(api, { handle: (channel, fn) => handlers.set(channel, fn) }, (sender) => ({
      id: `desktop-${sender.id}`,
      kind: "desktop",
    }));
    expect([...handlers.keys()]).toEqual(["a"]);
    expect(await handlers.get("a")({ sender: { id: 3 } }, 7)).toBe("desktop-3:7");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/api/registry.test.mjs`
Expected: FAIL with `Cannot find module './registry.ts'`.

- [ ] **Step 3: Implement `src/main/api/registry.ts`**

```ts
import type { IpcMain, WebContents } from "electron";
import type { Client } from "./client";

export type ApiHandler = (client: Client, ...args: never[]) => unknown;
export type ApiScope = "shared" | "desktop-only";
export type ApiErrorCode = "unknown-channel" | "forbidden";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiRegistry = {
  handle(channel: string, handler: ApiHandler, scope?: ApiScope): void;
  invoke(channel: string, client: Client, args: readonly unknown[]): Promise<unknown>;
  channels(): string[];
};

type CallableHandler = (client: Client, ...args: readonly unknown[]) => unknown;

export function createApiRegistry(): ApiRegistry {
  const entries = new Map<string, { handler: ApiHandler; scope: ApiScope }>();
  return {
    handle(channel, handler, scope = "shared") {
      if (entries.has(channel)) throw new Error(`Duplicate API channel: ${channel}`);
      entries.set(channel, { handler, scope });
    },
    async invoke(channel, client, args) {
      const entry = entries.get(channel);
      if (!entry) throw new ApiError("unknown-channel", `Unknown channel: ${channel}`);
      if (entry.scope === "desktop-only" && client.kind !== "desktop") {
        throw new ApiError("forbidden", `Only available in the desktop app: ${channel}`);
      }
      return (entry.handler as CallableHandler)(client, ...args);
    },
    channels: () => [...entries.keys()],
  };
}

export function bindRegistryToIpc(
  registry: ApiRegistry,
  ipc: Pick<IpcMain, "handle">,
  toClient: (sender: WebContents) => Client,
): void {
  for (const channel of registry.channels()) {
    ipc.handle(channel, (event, ...args: unknown[]) =>
      registry.invoke(channel, toClient(event.sender), args),
    );
  }
}
```

- [ ] **Step 4: Run the registry test to verify it passes**

Run: `bun test src/main/api/registry.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Move every IPC handler in `src/main/index.ts` onto the registry**

1. Add the import `import { bindRegistryToIpc, createApiRegistry } from "./api/registry";` and, right after the `activeChats` declarations (line ~100), add:

```ts
const api = createApiRegistry();
```

2. Inside `registerIpc()`, change every `ipcMain.handle(` to `api.handle(`, and every first handler parameter `_e` to `_client`. This applies to all 21 channels: canvases:list/create/read/write/delete, settings:read/write, dialog:pickFolder, shell:openPath, processes:start/stop, files:list, slash:list, chat:start, chat:cancel, chat:cancelForNode, askUser:respond, providers:authStatus/openLogin/codexRuntime, window:openCanvas, groupSummary:generate and canvasName:generate. Handlers with no parameters (`async () => listCanvases()`) stay as they are.

3. Add the `"desktop-only"` scope as the third argument on these four registrations. Their bodies don't change. The call shape is:

```ts
  api.handle(
    "dialog:pickFolder",
    async (_client, defaultPath?: string) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        defaultPath,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    },
    "desktop-only",
  );

  api.handle("shell:openPath", async (_client, path: string) => {
    await shell.openPath(path);
  }, "desktop-only");
```

Do the same for `providers:openLogin` and `window:openCanvas`.

4. `chat:start` becomes `api.handle("chat:start", async (client, args: ChatStartArgs) => {` and the line `const client = desktopClient(e.sender);` added in Task 1 is deleted, because `client` is now the parameter.

5. `chat:cancel` becomes:

```ts
  api.handle("chat:cancel", async (client, chatId: string) => {
    activeChats.get(chatId)?.controller.abort();
    activeChats.delete(chatId);
    cancelAllForClient(client);
  });
```

6. In `app.whenReady()`, directly after `registerIpc();`, add:

```ts
  bindRegistryToIpc(api, ipcMain, (sender) => desktopClient(sender));
```

- [ ] **Step 6: Verify the desktop app still type-checks and builds**

Run: `bun test src/main/api/registry.test.mjs && bun run typecheck && bun run build`
Expected: tests pass, typecheck clean, `✓ built`.

- [ ] **Step 7: Commit**

```bash
git add src/main/api/registry.ts src/main/api/registry.test.mjs src/main/index.ts
git commit -m "refactor: register IPC handlers in one shared call table" -m "Electron IPC binds to the table; the upcoming web server will dispatch to the same entries, so there is one implementation per channel. Native dialogs, opening files, terminal login and new windows are marked desktop-only."
```

---

### Task 3: Chats belong to a client; stop them when the client is gone

**Files:**
- Create: `src/main/api/activeChats.ts`, `src/main/api/activeChats.test.mjs`
- Modify: `src/main/index.ts:99-100,267,428,433-434,439-443` and the `bindRegistryToIpc` mapper

**Interfaces:**
- Consumes: `Client` (Task 1), `cancelAllForClient` (Task 1), `api`/`bindRegistryToIpc` (Task 2).
- Produces: `type ActiveChat = { controller: AbortController; nodeId: string; client: Client }`; `createActiveChats(): { add(chatId, chat); finish(chatId); abort(chatId); abortForNode(nodeId); abortForClient(client); has(chatId): boolean }`; `watchClient(client: Client): Client` in `index.ts`, which Tasks 9 and 11 extend.

- [ ] **Step 1: Write the failing test**

Create `src/main/api/activeChats.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { createActiveChats } from "./activeChats.ts";

const clientA = { id: "a", kind: "browser" };
const clientB = { id: "b", kind: "desktop" };

function chat(nodeId, client) {
  return { controller: new AbortController(), nodeId, client };
}

describe("createActiveChats", () => {
  test("abortForClient stops only that client's chats", () => {
    const chats = createActiveChats();
    const mine = chat("n1", clientA);
    const theirs = chat("n2", clientB);
    chats.add("c1", mine);
    chats.add("c2", theirs);
    chats.abortForClient(clientA);
    expect(mine.controller.signal.aborted).toBe(true);
    expect(theirs.controller.signal.aborted).toBe(false);
    expect(chats.has("c1")).toBe(false);
    expect(chats.has("c2")).toBe(true);
  });

  test("abortForNode stops every chat on that node", () => {
    const chats = createActiveChats();
    const first = chat("n1", clientA);
    const second = chat("n1", clientB);
    chats.add("c1", first);
    chats.add("c2", second);
    chats.abortForNode("n1");
    expect(first.controller.signal.aborted && second.controller.signal.aborted).toBe(true);
    expect(chats.has("c1") || chats.has("c2")).toBe(false);
  });

  test("abort stops one chat; finish forgets without aborting", () => {
    const chats = createActiveChats();
    const done = chat("n1", clientA);
    const stopped = chat("n2", clientA);
    chats.add("done", done);
    chats.add("stopped", stopped);
    chats.finish("done");
    chats.abort("stopped");
    expect(done.controller.signal.aborted).toBe(false);
    expect(stopped.controller.signal.aborted).toBe(true);
    expect(chats.has("done") || chats.has("stopped")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/api/activeChats.test.mjs`
Expected: FAIL with `Cannot find module './activeChats.ts'`.

- [ ] **Step 3: Implement `src/main/api/activeChats.ts`**

```ts
import type { Client } from "./client";

export type ActiveChat = { controller: AbortController; nodeId: string; client: Client };

export type ActiveChats = {
  add(chatId: string, chat: ActiveChat): void;
  finish(chatId: string): void;
  abort(chatId: string): void;
  abortForNode(nodeId: string): void;
  abortForClient(client: Client): void;
  has(chatId: string): boolean;
};

export function createActiveChats(): ActiveChats {
  const chats = new Map<string, ActiveChat>();

  const abortWhere = (matches: (chat: ActiveChat) => boolean): void => {
    for (const [chatId, chat] of [...chats]) {
      if (!matches(chat)) continue;
      chat.controller.abort();
      chats.delete(chatId);
    }
  };

  return {
    add: (chatId, chat) => {
      chats.set(chatId, chat);
    },
    finish: (chatId) => {
      chats.delete(chatId);
    },
    abort: (chatId) => {
      chats.get(chatId)?.controller.abort();
      chats.delete(chatId);
    },
    abortForNode: (nodeId) => abortWhere((chat) => chat.nodeId === nodeId),
    abortForClient: (client) => abortWhere((chat) => chat.client === client),
    has: (chatId) => chats.has(chatId),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/main/api/activeChats.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Use it in `src/main/index.ts` and watch clients**

1. Add the imports `import { createActiveChats } from "./api/activeChats";` and `import type { Client } from "./api/client";`.
2. Replace lines 99-100 (`type ActiveChat = …` and `const activeChats = new Map<…>();`) with:

```ts
const activeChats = createActiveChats();
const watchedClients = new WeakSet<Client>();

function watchClient(client: Client): Client {
  if (watchedClients.has(client)) return client;
  watchedClients.add(client);
  client.onGone(() => {
    activeChats.abortForClient(client);
    cancelAllForClient(client);
  });
  return client;
}
```

3. In `chat:start`: `activeChats.set(chatId, { controller, nodeId });` → `activeChats.add(chatId, { controller, nodeId, client });` and `activeChats.delete(chatId);` (line ~428) → `activeChats.finish(chatId);`
4. `chat:cancel` body becomes:

```ts
    activeChats.abort(chatId);
    cancelAllForClient(client);
```

5. `chat:cancelForNode` body becomes `activeChats.abortForNode(nodeId);`
6. The bind call becomes `bindRegistryToIpc(api, ipcMain, (sender) => watchClient(desktopClient(sender)));`

- [ ] **Step 6: Verify**

Run: `bun test src/main/api/activeChats.test.mjs && bun run typecheck`
Expected: pass, clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/api/activeChats.ts src/main/api/activeChats.test.mjs src/main/index.ts
git commit -m "fix: stop a client's chats and questions when it goes away" -m "Closing a window used to leave its Claude runs generating with nowhere to deliver output, and pending ask-user prompts never settled. Chats now record the client that started them and are aborted when it is gone."
```

---

### Task 4: Browser-access settings that stale windows can't overwrite

**Files:**
- Modify: `src/shared/types.ts` (add `BrowserAccessSettings`, `AppSettings.browserAccess`)
- Modify: `src/main/storage/settings.ts` (sanitize, `writeSettings`, new `writeBrowserAccess`)
- Create: `src/main/storage/settings.test.mjs`

**Interfaces:**
- Produces: `type BrowserAccessSettings = { enabled: boolean; keepAwake: boolean }`; `AppSettings.browserAccess?: BrowserAccessSettings`; `writeBrowserAccess(patch: Partial<BrowserAccessSettings>): Promise<AppSettings>`. `writeSettings` keeps the stored `browserAccess`.

- [ ] **Step 1: Write the failing test**

Create `src/main/storage/settings.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
// Run this file on its own: it redirects HOME before importing the storage modules.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
let home;
let settings;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "lmc-settings-"));
  process.env.HOME = home;
  const paths = await import("./paths.ts");
  if (!paths.SETTINGS_FILE.startsWith(home)) {
    throw new Error("paths.ts was loaded before HOME was redirected; run this test file on its own");
  }
  settings = await import("./settings.ts");
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("browser access settings", () => {
  test("default to off with keep-awake on", async () => {
    expect((await settings.readSettings()).browserAccess).toEqual({ enabled: false, keepAwake: true });
  });

  test("writeBrowserAccess changes only the given field", async () => {
    await settings.writeBrowserAccess({ enabled: true });
    expect((await settings.readSettings()).browserAccess).toEqual({ enabled: true, keepAwake: true });
    await settings.writeBrowserAccess({ keepAwake: false });
    expect((await settings.readSettings()).browserAccess).toEqual({ enabled: true, keepAwake: false });
  });

  test("a stale settings write cannot switch browser access on or off", async () => {
    await settings.writeBrowserAccess({ enabled: false, keepAwake: true });
    const stale = await settings.readSettings();
    await settings.writeBrowserAccess({ enabled: true });
    await settings.writeSettings({ ...stale, systemPrompt: "edited elsewhere" });
    const after = await settings.readSettings();
    expect(after.systemPrompt).toBe("edited elsewhere");
    expect(after.browserAccess.enabled).toBe(true);
    await settings.writeSettings({ ...after, browserAccess: { enabled: false, keepAwake: false } });
    expect((await settings.readSettings()).browserAccess).toEqual({ enabled: true, keepAwake: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/storage/settings.test.mjs`
Expected: FAIL. `browserAccess` is `undefined` and `writeBrowserAccess` is not a function.

- [ ] **Step 3: Add the type to `src/shared/types.ts`**

Directly above `export type AppSettings = {`, add:

```ts
export type BrowserAccessSettings = {
  enabled: boolean;
  keepAwake: boolean;
};
```

Inside `AppSettings`, after `lastNodeSettings?: NodeSettings;`, add:

```ts
  /** Browser access over Tailscale; changed only through the web:* channels. */
  browserAccess?: BrowserAccessSettings;
```

- [ ] **Step 4: Update `src/main/storage/settings.ts`**

1. Add `BrowserAccessSettings` to the existing `import type { … } from "@shared/types";` list.
2. Below `const DEFAULTS …`, add:

```ts
function sanitizeBrowserAccess(raw: unknown): BrowserAccessSettings {
  const value =
    typeof raw === "object" && raw !== null
      ? (raw as Partial<Record<keyof BrowserAccessSettings, unknown>>)
      : {};
  return { enabled: value.enabled === true, keepAwake: value.keepAwake !== false };
}
```

3. In `mergeWithDefaults`'s returned object, after `recentBranches: …,`, add `browserAccess: sanitizeBrowserAccess(s.browserAccess),`.
4. Replace `writeSettings` with:

```ts
export async function writeSettings(settings: AppSettings): Promise<AppSettings> {
  const stored = await readSettings();
  return persist({ ...settings, browserAccess: stored.browserAccess });
}

export async function writeBrowserAccess(
  patch: Partial<BrowserAccessSettings>,
): Promise<AppSettings> {
  const stored = await readSettings();
  return persist({
    ...stored,
    browserAccess: { ...sanitizeBrowserAccess(stored.browserAccess), ...patch },
  });
}

async function persist(settings: AppSettings): Promise<AppSettings> {
  await ensureDirs();
  const merged = mergeWithDefaults(settings);
  await atomicWriteFile(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}
```

- [ ] **Step 5: Verify**

Run: `bun test src/main/storage/settings.test.mjs && bun run typecheck`
Expected: 3 tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/storage/settings.ts src/main/storage/settings.test.mjs
git commit -m "feat: store browser-access settings separately from general settings" -m "settings:write always keeps the stored browserAccess, so a window holding an old copy of settings can never switch browser access on or off. Only writeBrowserAccess changes it."
```

---

### Task 5: Paired devices and pairing tokens

**Files:**
- Create: `src/main/web/devices.ts`, `src/main/web/devices.test.mjs`

**Interfaces:**
- Produces: `PAIRING_TOKEN_TTL_MS = 600_000`; `type PairedDevice = { id; label; keyHash; createdAt; lastSeenAt }`; `type DeviceStore = { createPairingToken(now): { token; expiresAt }; redeemPairingToken(token, label, now): Promise<{ deviceKey; device } | null>; findByKey(deviceKey): PairedDevice | undefined; touch(deviceId, now): Promise<void>; remove(deviceId): Promise<boolean>; list(): PairedDevice[] }`; `loadDeviceStore(filePath): Promise<DeviceStore>`; `deviceLabel(userAgent: string | undefined): string`.

- [ ] **Step 1: Write the failing test**

Create `src/main/web/devices.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAIRING_TOKEN_TTL_MS, deviceLabel, loadDeviceStore } from "./devices.ts";

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lmc-devices-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fileFor = (name) => join(dir, `${name}.json`);

describe("loadDeviceStore", () => {
  test("pairs a device once and recognises its key; only a hash is stored", async () => {
    const file = fileFor("pair");
    const store = await loadDeviceStore(file);
    const { token } = store.createPairingToken(1000);
    const paired = await store.redeemPairingToken(token, "Chrome on Windows", 2000);
    expect(paired.device.label).toBe("Chrome on Windows");
    expect(store.findByKey(paired.deviceKey).id).toBe(paired.device.id);
    expect(store.findByKey("not-a-key")).toBeUndefined();
    const saved = readFileSync(file, "utf-8");
    expect(saved).not.toContain(paired.deviceKey);
    expect(saved).toContain(paired.device.keyHash);
    expect(await store.redeemPairingToken(token, "again", 3000)).toBeNull();
  });

  test("refuses expired and unknown tokens", async () => {
    const store = await loadDeviceStore(fileFor("expired"));
    const { token, expiresAt } = store.createPairingToken(0);
    expect(expiresAt).toBe(PAIRING_TOKEN_TTL_MS);
    expect(await store.redeemPairingToken(token, "late", PAIRING_TOKEN_TTL_MS + 1)).toBeNull();
    expect(await store.redeemPairingToken("made-up", "x", 1)).toBeNull();
  });

  test("removing a device revokes its key and persists", async () => {
    const file = fileFor("remove");
    const store = await loadDeviceStore(file);
    const { token } = store.createPairingToken(0);
    const { deviceKey, device } = await store.redeemPairingToken(token, "x", 1);
    expect(await store.remove(device.id)).toBe(true);
    expect(await store.remove(device.id)).toBe(false);
    expect(store.findByKey(deviceKey)).toBeUndefined();
    expect((await loadDeviceStore(file)).list()).toEqual([]);
  });

  test("reloads paired devices from disk", async () => {
    const file = fileFor("reload");
    const first = await loadDeviceStore(file);
    const { token } = first.createPairingToken(0);
    const { deviceKey } = await first.redeemPairingToken(token, "Firefox on Linux", 1);
    const second = await loadDeviceStore(file);
    expect(second.findByKey(deviceKey).label).toBe("Firefox on Linux");
  });

  test("touch records last-seen at most once a minute", async () => {
    const store = await loadDeviceStore(fileFor("touch"));
    const { token } = store.createPairingToken(0);
    const { device } = await store.redeemPairingToken(token, "x", 1_000);
    await store.touch(device.id, 30_000);
    expect(store.list()[0].lastSeenAt).toBe(1_000);
    await store.touch(device.id, 70_000);
    expect(store.list()[0].lastSeenAt).toBe(70_000);
  });

  test("a damaged file loads as no devices", async () => {
    const file = fileFor("damaged");
    writeFileSync(file, "{not json");
    expect((await loadDeviceStore(file)).list()).toEqual([]);
  });
});

describe("deviceLabel", () => {
  test.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36", "Chrome on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    [undefined, "Unknown device"],
  ])("labels %s as %s", (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/web/devices.test.mjs`
Expected: FAIL with `Cannot find module './devices.ts'`.

- [ ] **Step 3: Implement `src/main/web/devices.ts`**

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../storage/paths";

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
const LAST_SEEN_PERSIST_INTERVAL_MS = 60 * 1000;
const SECRET_BYTES = 32;

export type PairedDevice = {
  id: string;
  label: string;
  keyHash: string;
  createdAt: number;
  lastSeenAt: number;
};

export type DeviceStore = {
  createPairingToken(now: number): { token: string; expiresAt: number };
  redeemPairingToken(
    token: string,
    label: string,
    now: number,
  ): Promise<{ deviceKey: string; device: PairedDevice } | null>;
  findByKey(deviceKey: string): PairedDevice | undefined;
  touch(deviceId: string, now: number): Promise<void>;
  remove(deviceId: string): Promise<boolean>;
  list(): PairedDevice[];
};

const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isPairedDevice(value: unknown): value is PairedDevice {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.keyHash === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.lastSeenAt === "number"
  );
}

async function readDevices(filePath: string): Promise<PairedDevice[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter(isPairedDevice) : [];
  } catch {
    return [];
  }
}

export async function loadDeviceStore(filePath: string): Promise<DeviceStore> {
  let devices = await readDevices(filePath);
  const tokens = new Map<string, number>();
  const persist = (): Promise<void> => atomicWriteFile(filePath, JSON.stringify(devices, null, 2));

  return {
    createPairingToken(now) {
      const token = randomBytes(SECRET_BYTES).toString("hex");
      const expiresAt = now + PAIRING_TOKEN_TTL_MS;
      tokens.set(hashSecret(token), expiresAt);
      return { token, expiresAt };
    },
    async redeemPairingToken(token, label, now) {
      const tokenHash = hashSecret(token);
      const expiresAt = tokens.get(tokenHash);
      tokens.delete(tokenHash);
      if (expiresAt === undefined || now > expiresAt) return null;
      const deviceKey = randomBytes(SECRET_BYTES).toString("base64url");
      const device: PairedDevice = {
        id: randomBytes(8).toString("hex"),
        label,
        keyHash: hashSecret(deviceKey),
        createdAt: now,
        lastSeenAt: now,
      };
      devices = [...devices, device];
      await persist();
      return { deviceKey, device };
    },
    findByKey(deviceKey) {
      const keyHash = hashSecret(deviceKey);
      return devices.find((device) => sameHash(device.keyHash, keyHash));
    },
    async touch(deviceId, now) {
      const device = devices.find((d) => d.id === deviceId);
      if (!device || now - device.lastSeenAt < LAST_SEEN_PERSIST_INTERVAL_MS) return;
      devices = devices.map((d) => (d.id === deviceId ? { ...d, lastSeenAt: now } : d));
      await persist();
    },
    async remove(deviceId) {
      const remaining = devices.filter((d) => d.id !== deviceId);
      if (remaining.length === devices.length) return false;
      devices = remaining;
      await persist();
      return true;
    },
    list: () => devices.map((device) => ({ ...device })),
  };
}

const OS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Macintosh|Mac OS X/, "Mac"],
  [/Linux/, "Linux"],
];

const BROWSER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//, "Edge"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const os = OS_PATTERNS.find(([pattern]) => pattern.test(ua))?.[1];
  const browser = BROWSER_PATTERNS.find(([pattern]) => pattern.test(ua))?.[1];
  if (!os) return "Unknown device";
  return browser ? `${browser} on ${os}` : os;
}
```

- [ ] **Step 4: Verify**

Run: `bun test src/main/web/devices.test.mjs && bun run typecheck`
Expected: 12 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/web/devices.ts src/main/web/devices.test.mjs
git commit -m "feat: paired-device store for browser access" -m "Single-use pairing tokens valid 10 minutes; device keys are 32 random bytes and only their SHA-256 hash is written to disk."
```

---

### Task 6: Request security gate

**Files:**
- Create: `src/main/web/security.ts`, `src/main/web/security.test.mjs`

**Interfaces:**
- Produces: `type GateRequest = { method; path; host?; origin?; tailscaleLogin?; deviceKey?; isUpgrade: boolean }`; `type GateContext = { expectedHost: string; ownerLogin: string; isPairedDevice(deviceKey: string): boolean }`; `type GateResult = { ok: true } | { ok: false; status: 401 | 403; reason: string }`; `checkRequest(req, ctx): GateResult`; `readCookie(header: string | undefined, name: string): string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `src/main/web/security.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { checkRequest, readCookie } from "./security.ts";

const CTX = {
  expectedHost: "my-mac.tail1234.ts.net",
  ownerLogin: "me@example.com",
  isPairedDevice: (key) => key === "good-key",
};

const ok = {
  method: "GET",
  path: "/",
  host: "my-mac.tail1234.ts.net",
  origin: undefined,
  tailscaleLogin: "me@example.com",
  deviceKey: "good-key",
  isUpgrade: false,
};
const post = { ...ok, method: "POST", path: "/api/canvases:list", origin: "https://my-mac.tail1234.ts.net" };

describe("checkRequest", () => {
  test.each([
    ["a paired GET", ok, { ok: true }],
    ["a paired same-origin POST", post, { ok: true }],
    ["a paired same-origin WebSocket", { ...post, method: "GET", path: "/ws", isUpgrade: true }, { ok: true }],
    ["the pairing link without a cookie", { ...ok, path: "/pair", deviceKey: undefined }, { ok: true }],
    ["a wrong Host (DNS rebinding)", { ...ok, host: "evil.example" }, { ok: false, status: 403, reason: "bad-host" }],
    ["a missing Host", { ...ok, host: undefined }, { ok: false, status: 403, reason: "bad-host" }],
    ["another Tailscale user", { ...ok, tailscaleLogin: "friend@example.com" }, { ok: false, status: 403, reason: "not-owner" }],
    ["no Tailscale identity (not via Serve)", { ...ok, tailscaleLogin: undefined }, { ok: false, status: 403, reason: "not-owner" }],
    ["an unpaired device", { ...ok, deviceKey: undefined }, { ok: false, status: 401, reason: "not-paired" }],
    ["a revoked device key", { ...ok, deviceKey: "old-key" }, { ok: false, status: 401, reason: "not-paired" }],
    ["a POST from another site", { ...post, origin: "https://evil.example" }, { ok: false, status: 403, reason: "bad-origin" }],
    ["a POST with no Origin", { ...post, origin: undefined }, { ok: false, status: 403, reason: "bad-origin" }],
    ["a WebSocket from another site", { ...ok, path: "/ws", isUpgrade: true, origin: "https://evil.example" }, { ok: false, status: 403, reason: "bad-origin" }],
    ["a POST to the pairing path", { ...post, path: "/pair", deviceKey: undefined }, { ok: false, status: 401, reason: "not-paired" }],
  ])("%s", (_label, req, expected) => {
    expect(checkRequest(req, CTX)).toEqual(expected);
  });

  test("host comparison ignores case", () => {
    expect(checkRequest({ ...ok, host: "MY-MAC.tail1234.ts.net" }, CTX)).toEqual({ ok: true });
  });
});

describe("readCookie", () => {
  test("finds a cookie among others and decodes it", () => {
    expect(readCookie("a=1; lmc_device=abc%3D; b=2", "lmc_device")).toBe("abc=");
  });
  test("returns undefined when absent", () => {
    expect(readCookie("a=1", "lmc_device")).toBeUndefined();
    expect(readCookie(undefined, "lmc_device")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/web/security.test.mjs`
Expected: FAIL with `Cannot find module './security.ts'`.

- [ ] **Step 3: Implement `src/main/web/security.ts`**

```ts
export type GateRequest = {
  method: string;
  path: string;
  host: string | undefined;
  origin: string | undefined;
  tailscaleLogin: string | undefined;
  deviceKey: string | undefined;
  isUpgrade: boolean;
};

export type GateContext = {
  expectedHost: string;
  ownerLogin: string;
  isPairedDevice: (deviceKey: string) => boolean;
};

export type GateResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

const PAIR_PATH = "/pair";

export function checkRequest(req: GateRequest, ctx: GateContext): GateResult {
  if (!req.host || req.host.toLowerCase() !== ctx.expectedHost.toLowerCase()) {
    return { ok: false, status: 403, reason: "bad-host" };
  }
  if (!req.tailscaleLogin || req.tailscaleLogin !== ctx.ownerLogin) {
    return { ok: false, status: 403, reason: "not-owner" };
  }
  const changesState = req.isUpgrade || req.method !== "GET";
  if (changesState && req.origin !== `https://${ctx.expectedHost.toLowerCase()}`) {
    return { ok: false, status: 403, reason: "bad-origin" };
  }
  if (req.method === "GET" && !req.isUpgrade && req.path === PAIR_PATH) return { ok: true };
  if (!req.deviceKey || !ctx.isPairedDevice(req.deviceKey)) {
    return { ok: false, status: 401, reason: "not-paired" };
  }
  return { ok: true };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}
```

- [ ] **Step 4: Verify**

Run: `bun test src/main/web/security.test.mjs && bun run typecheck`
Expected: 17 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/web/security.ts src/main/web/security.test.mjs
git commit -m "feat: security gate for browser-access requests" -m "Every request must name the Mac's .ts.net host, carry the owner's Tailscale identity, come from a paired device, and (for anything that changes state) be same-origin."
```

---

### Task 7: Tailscale control

**Files:**
- Create: `src/main/web/tailscale.ts`, `src/main/web/tailscale.test.mjs`

**Interfaces:**
- Produces: `TAILSCALE_CLI`; `type TailscaleInfo = { running; host: string | null; ownerLogin: string | null; httpsAvailable }`; `type ServeState = { httpsInUse: boolean; proxiesTo: string | null }`; `parseStatus(raw: unknown): TailscaleInfo`; `parseServeStatus(raw: unknown, host: string): ServeState`; `serveTarget(port): string`; `serveEnableArgs(port): string[]`; `serveDisableArgs(): string[]`; `type Exec = (args: readonly string[]) => Promise<string>`; `type TailscaleControl = { info(); serveState(host); enableServe(port); disableServe() }`; `createTailscale(exec?: Exec): TailscaleControl`.

- [ ] **Step 1: Write the failing test**

Create `src/main/web/tailscale.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import {
  createTailscale,
  parseServeStatus,
  parseStatus,
  serveDisableArgs,
  serveEnableArgs,
  serveTarget,
} from "./tailscale.ts";

const HOST = "my-mac.tail1234.ts.net";
const STATUS = {
  BackendState: "Running",
  Self: { DNSName: `${HOST}.`, UserID: 42, HostName: "My Mac" },
  User: { 42: { ID: 42, LoginName: "me@example.com", DisplayName: "Me" } },
  CertDomains: [HOST],
};
const OURS = {
  TCP: { 443: { HTTPS: true } },
  Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: serveTarget(4317) } } } },
};

describe("parseStatus", () => {
  test("reads host, owner and HTTPS availability", () => {
    expect(parseStatus(STATUS)).toEqual({
      running: true,
      host: HOST,
      ownerLogin: "me@example.com",
      httpsAvailable: true,
    });
  });
  test("reports a stopped backend and missing certificates", () => {
    const info = parseStatus({ ...STATUS, BackendState: "Stopped", CertDomains: [] });
    expect(info.running).toBe(false);
    expect(info.httpsAvailable).toBe(false);
  });
  test("survives garbage", () => {
    expect(parseStatus(null)).toEqual({ running: false, host: null, ownerLogin: null, httpsAvailable: false });
  });
});

describe("parseServeStatus", () => {
  test("empty config means HTTPS is free", () => {
    expect(parseServeStatus({}, HOST)).toEqual({ httpsInUse: false, proxiesTo: null });
  });
  test("recognises our own mapping", () => {
    expect(parseServeStatus(OURS, HOST)).toEqual({ httpsInUse: true, proxiesTo: "http://127.0.0.1:4317" });
  });
  test("someone else's HTTPS site counts as in use", () => {
    const other = { TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Path: "/srv" } } } } };
    expect(parseServeStatus(other, HOST)).toEqual({ httpsInUse: true, proxiesTo: null });
  });
});

describe("createTailscale", () => {
  test("uses exactly the serve commands and never funnel", async () => {
    const calls = [];
    const exec = async (args) => {
      calls.push(args);
      if (args[0] === "status") return JSON.stringify(STATUS);
      if (args[0] === "serve" && args[1] === "status") return JSON.stringify(OURS);
      return "";
    };
    const tailscale = createTailscale(exec);
    expect((await tailscale.info()).host).toBe(HOST);
    expect((await tailscale.serveState(HOST)).proxiesTo).toBe("http://127.0.0.1:4317");
    await tailscale.enableServe(4317);
    await tailscale.disableServe();
    expect(calls).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
      ["serve", "--bg", "--https=443", "http://127.0.0.1:4317"],
      ["serve", "--https=443", "off"],
    ]);
    expect(calls.flat()).not.toContain("funnel");
  });

  test("argument builders", () => {
    expect(serveEnableArgs(4317)).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:4317"]);
    expect(serveDisableArgs()).toEqual(["serve", "--https=443", "off"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/web/tailscale.test.mjs`
Expected: FAIL with `Cannot find module './tailscale.ts'`.

- [ ] **Step 3: Implement `src/main/web/tailscale.ts`**

```ts
import { execFile } from "node:child_process";

export const TAILSCALE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const EXEC_TIMEOUT_MS = 15_000;

export type TailscaleInfo = {
  running: boolean;
  host: string | null;
  ownerLogin: string | null;
  httpsAvailable: boolean;
};

export type ServeState = { httpsInUse: boolean; proxiesTo: string | null };
export type Exec = (args: readonly string[]) => Promise<string>;

export type TailscaleControl = {
  info(): Promise<TailscaleInfo>;
  serveState(host: string): Promise<ServeState>;
  enableServe(port: number): Promise<void>;
  disableServe(): Promise<void>;
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function parseStatus(raw: unknown): TailscaleInfo {
  const status = asObject(raw);
  const self = asObject(status?.Self);
  const dnsName =
    typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  const owner = asObject(asObject(status?.User)?.[String(self?.UserID)]);
  const rawCerts = status?.CertDomains;
  const certDomains: unknown[] = Array.isArray(rawCerts) ? rawCerts : [];
  return {
    running: status?.BackendState === "Running",
    host: dnsName || null,
    ownerLogin: typeof owner?.LoginName === "string" ? owner.LoginName : null,
    httpsAvailable:
      dnsName !== "" &&
      certDomains.some((domain) => typeof domain === "string" && domain.toLowerCase() === dnsName),
  };
}

export function parseServeStatus(raw: unknown, host: string): ServeState {
  const config = asObject(raw);
  const httpsInUse = asObject(config?.TCP)?.["443"] !== undefined;
  const site = asObject(asObject(config?.Web)?.[`${host}:443`]);
  const root = asObject(asObject(site?.Handlers)?.["/"]);
  return { httpsInUse, proxiesTo: typeof root?.Proxy === "string" ? root.Proxy : null };
}

export const serveTarget = (port: number): string => `http://127.0.0.1:${port}`;
export const serveEnableArgs = (port: number): string[] => [
  "serve",
  "--bg",
  "--https=443",
  serveTarget(port),
];
export const serveDisableArgs = (): string[] => ["serve", "--https=443", "off"];

export const execTailscale: Exec = (args) =>
  new Promise((resolve, reject) => {
    execFile(TAILSCALE_CLI, [...args], { timeout: EXEC_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

export function createTailscale(exec: Exec = execTailscale): TailscaleControl {
  const run = async (args: readonly string[]): Promise<string> => {
    if (args.includes("funnel")) throw new Error("Refusing to run tailscale funnel");
    return exec(args);
  };
  return {
    async info() {
      return parseStatus(JSON.parse(await run(["status", "--json"])));
    },
    async serveState(host) {
      return parseServeStatus(JSON.parse(await run(["serve", "status", "--json"])), host);
    },
    async enableServe(port) {
      await run(serveEnableArgs(port));
    },
    async disableServe() {
      await run(serveDisableArgs());
    },
  };
}
```

- [ ] **Step 4: Verify**

Run: `bun test src/main/web/tailscale.test.mjs && bun run typecheck`
Expected: 8 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/web/tailscale.ts src/main/web/tailscale.test.mjs
git commit -m "feat: Tailscale Serve control for browser access" -m "Reads the Mac's .ts.net host, owner login and HTTPS availability from status --json, detects existing Serve config, and only ever runs serve (never funnel)."
```

---

### Task 8: Browser clients with a reconnect grace period

**Files:**
- Create: `src/main/web/browserClients.ts`, `src/main/web/browserClients.test.mjs`

**Interfaces:**
- Consumes: `Client` (Task 1).
- Produces: `type SocketLike = { send(data: string): void; close(): void }`; `type Scheduler = { setTimeout(fn, ms): unknown; clearTimeout(handle: unknown): void }`; `type BrowserClientRegistry = { ensure(clientId, deviceId): Client; attach(clientId, deviceId, socket): { client: Client; resumed: boolean }; detach(clientId, socket): void; expireDevice(deviceId): void; expireAll(): void; get(clientId): Client | undefined }`; `createBrowserClientRegistry({ graceMs, scheduler?, onCreated? })`. A browser client's `send` writes `{"type":"event","channel","payload"}` JSON to the socket, or queues it while detached.

- [ ] **Step 1: Write the failing test**

Create `src/main/web/browserClients.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { createBrowserClientRegistry } from "./browserClients.ts";

function manualScheduler() {
  let next = 1;
  const timers = new Map();
  return {
    setTimeout(fn) {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fireAll() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    pending: () => timers.size,
  };
}

function fakeSocket() {
  const socket = { messages: [], closed: false, send: (m) => socket.messages.push(JSON.parse(m)), close: () => { socket.closed = true; } };
  return socket;
}

const setup = () => {
  const scheduler = manualScheduler();
  const created = [];
  const registry = createBrowserClientRegistry({ graceMs: 120_000, scheduler, onCreated: (c) => created.push(c) });
  return { scheduler, created, registry };
};

describe("createBrowserClientRegistry", () => {
  test("a new tab gets a fresh client whose events reach the socket", () => {
    const { registry, created } = setup();
    const socket = fakeSocket();
    const { client, resumed } = registry.attach("tab1", "dev1", socket);
    expect(resumed).toBe(false);
    expect(client.kind).toBe("browser");
    client.send("chat:event", { chatId: "c1", type: "start" });
    expect(socket.messages).toEqual([{ type: "event", channel: "chat:event", payload: { chatId: "c1", type: "start" } }]);
    expect(created).toEqual([client]);
  });

  test("events during a dropped connection are replayed in order on reconnect", () => {
    const { registry } = setup();
    const first = fakeSocket();
    const { client } = registry.attach("tab1", "dev1", first);
    registry.detach("tab1", first);
    client.send("chat:event", { n: 1 });
    client.send("chat:event", { n: 2 });
    const second = fakeSocket();
    const again = registry.attach("tab1", "dev1", second);
    expect(again.resumed).toBe(true);
    expect(again.client).toBe(client);
    expect(second.messages.map((m) => m.payload.n)).toEqual([1, 2]);
  });

  test("a tab that never comes back is gone after the grace period", () => {
    const { registry, scheduler } = setup();
    const socket = fakeSocket();
    const { client } = registry.attach("tab1", "dev1", socket);
    let gone = 0;
    client.onGone(() => gone++);
    registry.detach("tab1", socket);
    scheduler.fireAll();
    expect(gone).toBe(1);
    expect(client.isGone()).toBe(true);
    expect(registry.get("tab1")).toBeUndefined();
    expect(registry.attach("tab1", "dev1", fakeSocket()).resumed).toBe(false);
  });

  test("a stale close from an old socket does not detach the new one", () => {
    const { registry, scheduler } = setup();
    const old = fakeSocket();
    registry.attach("tab1", "dev1", old);
    const fresh = fakeSocket();
    registry.attach("tab1", "dev1", fresh);
    expect(old.closed).toBe(true);
    registry.detach("tab1", old);
    expect(scheduler.pending()).toBe(0);
  });

  test("the same tab id from a different device starts over", () => {
    const { registry } = setup();
    const { client } = registry.attach("tab1", "dev1", fakeSocket());
    const other = registry.attach("tab1", "dev2", fakeSocket());
    expect(other.resumed).toBe(false);
    expect(client.isGone()).toBe(true);
  });

  test("removing a device closes its sockets and ends its clients", () => {
    const { registry } = setup();
    const socket = fakeSocket();
    const { client } = registry.attach("tab1", "dev1", socket);
    const keep = registry.attach("tab2", "dev2", fakeSocket()).client;
    registry.expireDevice("dev1");
    expect(socket.closed).toBe(true);
    expect(client.isGone()).toBe(true);
    expect(keep.isGone()).toBe(false);
  });

  test("ensure creates a detached client that expires if no socket ever attaches", () => {
    const { registry, scheduler } = setup();
    const client = registry.ensure("tab9", "dev1");
    expect(registry.ensure("tab9", "dev1")).toBe(client);
    scheduler.fireAll();
    expect(client.isGone()).toBe(true);
  });

  test("expireAll ends every client", () => {
    const { registry } = setup();
    const a = registry.attach("a1", "dev1", fakeSocket()).client;
    const b = registry.ensure("b1", "dev2");
    registry.expireAll();
    expect(a.isGone() && b.isGone()).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/web/browserClients.test.mjs`
Expected: FAIL with `Cannot find module './browserClients.ts'`.

- [ ] **Step 3: Implement `src/main/web/browserClients.ts`**

```ts
import type { Client } from "../api/client";

export type SocketLike = { send(data: string): void; close(): void };

export type Scheduler = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type BrowserClientRegistry = {
  ensure(clientId: string, deviceId: string): Client;
  attach(clientId: string, deviceId: string, socket: SocketLike): { client: Client; resumed: boolean };
  detach(clientId: string, socket: SocketLike): void;
  expireDevice(deviceId: string): void;
  expireAll(): void;
  get(clientId: string): Client | undefined;
};

type ClientState = {
  deviceId: string;
  socket: SocketLike | null;
  queue: string[];
  timer: unknown;
  gone: boolean;
  listeners: Set<() => void>;
};

type ClientRecord = { client: Client; state: ClientState };

const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createBrowserClientRegistry(opts: {
  graceMs: number;
  scheduler?: Scheduler;
  onCreated?: (client: Client) => void;
}): BrowserClientRegistry {
  const scheduler = opts.scheduler ?? realScheduler;
  const records = new Map<string, ClientRecord>();

  const expire = (clientId: string): void => {
    const record = records.get(clientId);
    if (!record) return;
    records.delete(clientId);
    const { state } = record;
    scheduler.clearTimeout(state.timer);
    state.gone = true;
    state.socket?.close();
    state.socket = null;
    state.queue = [];
    for (const listener of [...state.listeners]) listener();
  };

  const startGrace = (clientId: string, state: ClientState): void => {
    scheduler.clearTimeout(state.timer);
    state.timer = scheduler.setTimeout(() => expire(clientId), opts.graceMs);
  };

  const create = (clientId: string, deviceId: string): ClientRecord => {
    const state: ClientState = {
      deviceId,
      socket: null,
      queue: [],
      timer: undefined,
      gone: false,
      listeners: new Set(),
    };
    const client: Client = {
      id: `browser-${clientId}`,
      kind: "browser",
      send(channel, payload) {
        if (state.gone) return;
        const message = JSON.stringify({ type: "event", channel, payload });
        if (state.socket) state.socket.send(message);
        else state.queue = [...state.queue, message];
      },
      isGone: () => state.gone,
      onGone(listener) {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
    };
    const record = { client, state };
    records.set(clientId, record);
    opts.onCreated?.(client);
    return record;
  };

  const sameDevice = (clientId: string, deviceId: string): ClientRecord | undefined => {
    const existing = records.get(clientId);
    if (!existing) return undefined;
    if (existing.state.deviceId === deviceId) return existing;
    expire(clientId);
    return undefined;
  };

  return {
    ensure(clientId, deviceId) {
      const existing = sameDevice(clientId, deviceId);
      if (existing) return existing.client;
      const record = create(clientId, deviceId);
      startGrace(clientId, record.state);
      return record.client;
    },
    attach(clientId, deviceId, socket) {
      const existing = sameDevice(clientId, deviceId);
      const resumed = existing !== undefined;
      const record = existing ?? create(clientId, deviceId);
      const { state } = record;
      scheduler.clearTimeout(state.timer);
      state.timer = undefined;
      if (state.socket && state.socket !== socket) state.socket.close();
      state.socket = socket;
      const pending = state.queue;
      state.queue = [];
      for (const message of pending) socket.send(message);
      return { client: record.client, resumed };
    },
    detach(clientId, socket) {
      const record = records.get(clientId);
      if (!record || record.state.socket !== socket) return;
      record.state.socket = null;
      startGrace(clientId, record.state);
    },
    expireDevice(deviceId) {
      for (const [clientId, record] of [...records]) {
        if (record.state.deviceId === deviceId) expire(clientId);
      }
    },
    expireAll() {
      for (const clientId of [...records.keys()]) expire(clientId);
    },
    get: (clientId) => records.get(clientId)?.client,
  };
}
```

`resumed` means exactly "this tab's client already existed for this device", so a reconnect within the grace period keeps the same `Client` (and its running chats).

- [ ] **Step 4: Verify**

Run: `bun test src/main/web/browserClients.test.mjs && bun run typecheck`
Expected: 8 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/web/browserClients.ts src/main/web/browserClients.test.mjs
git commit -m "feat: browser clients that survive short disconnects" -m "Each tab is a Client. While its WebSocket is down, events are queued and replayed in order on reconnect; after the grace period the client is gone, which aborts its chats and settles its questions."
```

---

### Task 9: One place at a time: canvas locks

**Files:**
- Create: `src/main/web/canvasLocks.ts`, `src/main/web/canvasLocks.test.mjs`
- Create: `src/renderer/src/lib/lockText.ts`, `src/renderer/src/lib/lockText.test.mjs`
- Create: `src/renderer/src/components/Canvas/LockOverlay.tsx`
- Modify: `src/shared/ipc.ts` (types and `LmcApi.canvasLock`), `src/preload/index.ts`, `src/main/index.ts` (channels, write check, `watchClient`), `src/renderer/src/hooks/useCanvasStore.ts`, `src/renderer/src/components/Canvas/CanvasPane.tsx`

**Interfaces:**
- Consumes: `Client` (Task 1), `api`/`watchClient` (Tasks 2-3).
- Produces: `type CanvasLockResult = { ok: true } | { ok: false; holderKind: "desktop" | "browser" }`; `type CanvasLockLostEvent = { canvasId: string }`; `LOCK_LOST_CHANNEL = "canvas:lockLost"`; `createCanvasLocks(): { acquire; takeOver; release; releaseAll; canWrite }`; `LmcApi.canvasLock = { acquire(id); takeOver(id); release(id); onLost(handler) }`; `type CanvasLockState = "held" | "conflict" | "lost" | null`; store fields `lock`, `lockHolder` and actions `takeOverLock()`, `markLockLost(canvasId)`, `releaseLock()`.

- [ ] **Step 1: Write the failing lock tests**

Create `src/main/web/canvasLocks.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { LOCK_LOST_CHANNEL, createCanvasLocks } from "./canvasLocks.ts";

function client(id, kind = "browser") {
  const c = { id, kind, gone: false, sent: [], send: (ch, p) => c.sent.push([ch, p]), isGone: () => c.gone };
  return c;
}

describe("createCanvasLocks", () => {
  test("the first opener holds the lock; a second tab on the same device conflicts", () => {
    const locks = createCanvasLocks();
    const tabA = client("tab-a");
    const tabB = client("tab-b");
    expect(locks.acquire("canvas1", tabA)).toEqual({ ok: true });
    expect(locks.acquire("canvas1", tabB)).toEqual({ ok: false, holderKind: "browser" });
    expect(locks.acquire("canvas1", tabA)).toEqual({ ok: true });
  });

  test("taking over tells the previous holder it lost the canvas", () => {
    const locks = createCanvasLocks();
    const desktop = client("win", "desktop");
    const tab = client("tab");
    locks.acquire("canvas1", desktop);
    locks.takeOver("canvas1", tab);
    expect(desktop.sent).toEqual([[LOCK_LOST_CHANNEL, { canvasId: "canvas1" }]]);
    expect(locks.canWrite("canvas1", tab)).toBe(true);
    expect(locks.canWrite("canvas1", desktop)).toBe(false);
  });

  test("writes are allowed when nobody holds the canvas or the holder is gone", () => {
    const locks = createCanvasLocks();
    const a = client("a");
    const b = client("b");
    expect(locks.canWrite("free", b)).toBe(true);
    locks.acquire("canvas1", a);
    a.gone = true;
    expect(locks.canWrite("canvas1", b)).toBe(true);
    expect(locks.acquire("canvas1", b)).toEqual({ ok: true });
  });

  test("release and releaseAll free only that client's canvases", () => {
    const locks = createCanvasLocks();
    const a = client("a");
    const b = client("b");
    locks.acquire("one", a);
    locks.acquire("two", a);
    locks.acquire("three", b);
    locks.release("one", b);
    expect(locks.acquire("one", b).ok).toBe(false);
    locks.releaseAll(a);
    expect(locks.acquire("one", b)).toEqual({ ok: true });
    expect(locks.acquire("two", b)).toEqual({ ok: true });
  });
});
```

Create `src/renderer/src/lib/lockText.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { lockOverlayText } from "./lockText.ts";

describe("lockOverlayText", () => {
  test("names where the chat is open", () => {
    expect(lockOverlayText("conflict", "desktop").title).toBe("This chat is open in the desktop app.");
    expect(lockOverlayText("conflict", "browser").title).toBe("This chat is open in another browser tab or device.");
  });
  test("explains a lost lock", () => {
    expect(lockOverlayText("lost", null).title).toBe("This chat was opened somewhere else.");
  });
  test("shows nothing while the chat is held here", () => {
    expect(lockOverlayText("held", null)).toBeNull();
    expect(lockOverlayText(null, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/main/web/canvasLocks.test.mjs src/renderer/src/lib/lockText.test.mjs`
Expected: FAIL, modules not found.

- [ ] **Step 3: Add shared types and the API surface**

In `src/shared/ipc.ts`, before `export type LmcApi = {`, add:

```ts
export type CanvasLockResult = { ok: true } | { ok: false; holderKind: "desktop" | "browser" };
export type CanvasLockLostEvent = { canvasId: string };
```

Inside `LmcApi`, after `canvasName: { … };`, add:

```ts
  canvasLock: {
    /** Claim a canvas for this window or tab; fails if another client holds it. */
    acquire(canvasId: string): Promise<CanvasLockResult>;
    /** Claim a canvas from whoever holds it; they are told via onLost. */
    takeOver(canvasId: string): Promise<void>;
    release(canvasId: string): Promise<void>;
    onLost(handler: (ev: CanvasLockLostEvent) => void): () => void;
  };
```

In `src/preload/index.ts`, add `CanvasLockLostEvent` to the type imports, and before the closing `};` of `api`, add:

```ts
  canvasLock: {
    acquire: (canvasId: string) => ipcRenderer.invoke("canvasLock:acquire", canvasId),
    takeOver: (canvasId: string) => ipcRenderer.invoke("canvasLock:takeOver", canvasId),
    release: (canvasId: string) => ipcRenderer.invoke("canvasLock:release", canvasId),
    onLost: (handler: (ev: CanvasLockLostEvent) => void) => {
      const listener = (_: Electron.IpcRendererEvent, ev: CanvasLockLostEvent) => handler(ev);
      ipcRenderer.on("canvas:lockLost", listener);
      return () => ipcRenderer.off("canvas:lockLost", listener);
    },
  },
```

- [ ] **Step 4: Implement `src/main/web/canvasLocks.ts`**

```ts
import type { CanvasLockResult } from "@shared/ipc";
import type { Client } from "../api/client";

export const LOCK_LOST_CHANNEL = "canvas:lockLost";

type LockClient = Pick<Client, "kind" | "send" | "isGone">;

export type CanvasLocks = {
  acquire(canvasId: string, client: LockClient): CanvasLockResult;
  takeOver(canvasId: string, client: LockClient): void;
  release(canvasId: string, client: LockClient): void;
  releaseAll(client: LockClient): void;
  canWrite(canvasId: string, client: LockClient): boolean;
};

export function createCanvasLocks(): CanvasLocks {
  const holders = new Map<string, LockClient>();

  const isFreeFor = (canvasId: string, client: LockClient): boolean => {
    const holder = holders.get(canvasId);
    return holder === undefined || holder === client || holder.isGone();
  };

  return {
    acquire(canvasId, client) {
      const holder = holders.get(canvasId);
      if (holder && !isFreeFor(canvasId, client)) return { ok: false, holderKind: holder.kind };
      holders.set(canvasId, client);
      return { ok: true };
    },
    takeOver(canvasId, client) {
      const holder = holders.get(canvasId);
      if (holder && holder !== client && !holder.isGone()) {
        holder.send(LOCK_LOST_CHANNEL, { canvasId });
      }
      holders.set(canvasId, client);
    },
    release(canvasId, client) {
      if (holders.get(canvasId) === client) holders.delete(canvasId);
    },
    releaseAll(client) {
      for (const [canvasId, holder] of [...holders]) {
        if (holder === client) holders.delete(canvasId);
      }
    },
    canWrite: (canvasId, client) => isFreeFor(canvasId, client),
  };
}
```

- [ ] **Step 5: Implement `src/renderer/src/lib/lockText.ts`**

```ts
export type CanvasLockState = "held" | "conflict" | "lost" | null;
export type LockHolderKind = "desktop" | "browser" | null;

export function lockOverlayText(
  state: CanvasLockState,
  holder: LockHolderKind,
): { title: string; detail: string } | null {
  if (state === "conflict") {
    return {
      title:
        holder === "desktop"
          ? "This chat is open in the desktop app."
          : "This chat is open in another browser tab or device.",
      detail: "Only one place can edit a chat at a time.",
    };
  }
  if (state === "lost") {
    return {
      title: "This chat was opened somewhere else.",
      detail: "It's read-only here until you take it back.",
    };
  }
  return null;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/main/web/canvasLocks.test.mjs src/renderer/src/lib/lockText.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 7: Wire locks into the main process**

In `src/main/index.ts`:
1. Import `import { createCanvasLocks } from "./web/canvasLocks";` and, next to `const activeChats = createActiveChats();`, add `const canvasLocks = createCanvasLocks();`.
2. In `watchClient`'s `onGone` callback, add `canvasLocks.releaseAll(client);`.
3. Replace the `canvases:write` registration with:

```ts
  api.handle("canvases:write", async (client, canvas: Canvas) => {
    if (!canvasLocks.canWrite(canvas.id, client)) {
      throw new Error("This chat is open on another device.");
    }
    return writeCanvas(canvas);
  });
```

4. After it, register the lock channels:

```ts
  api.handle("canvasLock:acquire", async (client, canvasId: string) =>
    canvasLocks.acquire(canvasId, client),
  );
  api.handle("canvasLock:takeOver", async (client, canvasId: string) => {
    canvasLocks.takeOver(canvasId, client);
  });
  api.handle("canvasLock:release", async (client, canvasId: string) => {
    canvasLocks.release(canvasId, client);
  });
```

- [ ] **Step 8: Hold the lock in the canvas store**

In `src/renderer/src/hooks/useCanvasStore.ts`:
1. Import `import type { CanvasLockState, LockHolderKind } from "@/lib/lockText";`.
2. In the state type, after `error: string | null;` (line 51), add:

```ts
  lock: CanvasLockState;
  lockHolder: LockHolderKind;
```

3. In the actions part of the type, after `loadCanvas: (id: string) => Promise<void>;`, add:

```ts
  takeOverLock: () => Promise<void>;
  markLockLost: (canvasId: string) => void;
  releaseLock: () => void;
```

4. In the initial state, after `error: null,` (line 236), add `lock: null,` and `lockHolder: null,`.
5. In `loadCanvas`, directly after `set({ loaded: false, error: null });`, add:

```ts
        const previous = get().canvasId;
        if (previous && previous !== id && get().lock === "held") {
          void window.api.canvasLock.release(previous);
        }
```

6. Add `import type { CanvasLockResult } from "@shared/ipc";`. In `loadCanvas`, just before the final `set({ canvasId: canvas.id, …, loaded: true, … })`, add the line below. A failed lock request must never stop a chat from opening, so it counts as held:

```ts
        const lock = await window.api.canvasLock
          .acquire(canvas.id)
          .catch((): CanvasLockResult => ({ ok: true }));
```

Then add these two keys inside that `set({ … })`:

```ts
          lock: lock.ok ? "held" : "conflict",
          lockHolder: lock.ok ? null : lock.holderKind,
```

7. Make `save` start with `if (get().lock !== "held") return;`.
8. Add the three actions next to `save`:

```ts
      takeOverLock: async () => {
        const id = get().canvasId;
        if (!id) return;
        await window.api.canvasLock.takeOver(id);
        await get().loadCanvas(id);
      },

      markLockLost: (canvasId) => {
        if (get().canvasId === canvasId) set({ lock: "lost", lockHolder: null });
      },

      releaseLock: () => {
        const id = get().canvasId;
        if (id && get().lock === "held") void window.api.canvasLock.release(id);
        set({ lock: null });
      },
```

- [ ] **Step 9: Show the overlay**

Create `src/renderer/src/components/Canvas/LockOverlay.tsx`:

```tsx
import { lockOverlayText, type CanvasLockState, type LockHolderKind } from "@/lib/lockText";

type Props = {
  state: CanvasLockState;
  holderKind: LockHolderKind;
  onTakeOver: () => void;
};

export function LockOverlay({ state, holderKind, onTakeOver }: Props) {
  const text = lockOverlayText(state, holderKind);
  if (!text) return null;
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/60">
      <div className="max-w-sm rounded-lg border border-border bg-card p-4 text-sm shadow-lg">
        <p className="font-medium text-foreground">{text.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{text.detail}</p>
        <button
          type="button"
          onClick={onTakeOver}
          className="mt-3 cursor-pointer rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-card hover:opacity-90"
        >
          Take over here
        </button>
      </div>
    </div>
  );
}
```

In `src/renderer/src/components/Canvas/CanvasPane.tsx`:
1. Import `import { LockOverlay } from "./LockOverlay";`.
2. Next to the other `useCanvasStore` selectors (around line 69), add:

```tsx
  const lock = useCanvasStore((s) => s.lock);
  const lockHolder = useCanvasStore((s) => s.lockHolder);
  const takeOverLock = useCanvasStore((s) => s.takeOverLock);
  const markLockLost = useCanvasStore((s) => s.markLockLost);
  const releaseLock = useCanvasStore((s) => s.releaseLock);

  useEffect(
    () => window.api.canvasLock.onLost(({ canvasId: lost }) => markLockLost(lost)),
    [markLockLost],
  );
  useEffect(() => () => releaseLock(), [releaseLock]);
```

3. As the last child of the root element (`className="group relative h-full w-full overflow-hidden"`, line 116), add:

```tsx
      <LockOverlay state={lock} holderKind={lockHolder} onTakeOver={() => void takeOverLock()} />
```

- [ ] **Step 10: Verify**

Run: `bun test src/main/web/canvasLocks.test.mjs src/renderer/src/lib/lockText.test.mjs && bun run typecheck`
Expected: pass; clean. The browser adapter (Task 12) implements `canvasLock` for browsers, and until then only the preload does.

- [ ] **Step 11: Commit**

```bash
git add src/main/web/canvasLocks.ts src/main/web/canvasLocks.test.mjs src/renderer/src/lib/lockText.ts src/renderer/src/lib/lockText.test.mjs src/renderer/src/components/Canvas/LockOverlay.tsx src/shared/ipc.ts src/preload/index.ts src/main/index.ts src/renderer/src/hooks/useCanvasStore.ts src/renderer/src/components/Canvas/CanvasPane.tsx
git commit -m "feat: open a chat in one place at a time" -m "Opening a chat claims it for that window or tab. A second opener sees 'open elsewhere — take over?'; the previous holder becomes read-only. Writes from a non-holder are refused by the main process."
```

---

### Task 10: The web server

**Files:**
- Modify: `package.json` (dependency `ws`, dev dependency `@types/ws`)
- Create: `src/main/web/server.ts`, `src/main/web/server.test.mjs`

**Interfaces:**
- Consumes: `ApiRegistry`/`ApiError` (Task 2), `BrowserClientRegistry` (Task 8), `DeviceStore`/`deviceLabel` (Task 5), `checkRequest`/`readCookie`/`GateContext` (Task 6).
- Produces: `BODY_LIMIT_BYTES`, `DEVICE_COOKIE = "lmc_device"`, `CLIENT_HEADER = "x-lmc-client"`; `type WebServerDeps = { registry; clients; devices; gateContext: () => GateContext | null; staticRoot; homeDir; bodyLimitBytes?; now? }`; `type WebServer = { listen(port): Promise<void>; close(): Promise<void>; disconnectDevice(deviceId): void; port(): number | null }`; `createWebServer(deps): WebServer`.
- Wire protocol (the browser adapter in Task 12 relies on it):
  - `POST /api/<encoded channel>` with header `X-LMC-Client: <tab id>` and body `{"args":[…]}`. Responses: `200 {"ok":true,"result":…}`, or `200 {"ok":false,"error":"…"}` for a handler error, `400` malformed, `403` forbidden channel or gate refusal, `404` unknown channel, `413` too large.
  - `GET /ws?client=<tab id>` (WebSocket). The server sends `{"type":"welcome","resumed":bool}` after replaying any queued `{"type":"event","channel","payload"}` messages.
  - `GET /api/fs/dirs?path=…` returns `{"ok":true,"result":{"path","parent","dirs"}}`.
  - `GET /pair?token=…` returns `302` to `/` with `Set-Cookie: lmc_device=…`, or `410` if the token is invalid.

- [ ] **Step 1: Add the dependency**

Run: `bun add ws && bun add -d @types/ws`
Expected: `package.json` lists `ws` under `dependencies` and `@types/ws` under `devDependencies`.

- [ ] **Step 2: Write the failing integration test**

Create `src/main/web/server.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApiRegistry } from "../api/registry.ts";
import { createBrowserClientRegistry } from "./browserClients.ts";
import { loadDeviceStore } from "./devices.ts";
import { createWebServer } from "./server.ts";

const HOST = "my-mac.tail1234.ts.net";
const ORIGIN = `https://${HOST}`;
const OWNER = "me@example.com";

let root;
let server;
let port;
let devices;
let clients;
let cookie;
let ranSecret = 0;

function call({ method = "GET", path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const trusted = (extra = {}) => ({ Host: HOST, "Tailscale-User-Login": OWNER, ...extra });
const paired = (extra = {}) => trusted({ Cookie: cookie, ...extra });
const apiCall = (channel, args, extra = {}) =>
  call({
    method: "POST",
    path: `/api/${encodeURIComponent(channel)}`,
    headers: paired({ Origin: ORIGIN, "X-LMC-Client": "tab12345", "Content-Type": "application/json", ...extra }),
    body: JSON.stringify({ args }),
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lmc-server-"));
  const staticRoot = join(root, "renderer");
  mkdirSync(join(staticRoot, "assets"), { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(staticRoot, "assets", "app.js"), "console.log(1)");
  const home = join(root, "home");
  mkdirSync(join(home, "projects"), { recursive: true });
  mkdirSync(join(home, ".hidden"), { recursive: true });

  devices = await loadDeviceStore(join(root, "devices.json"));
  clients = createBrowserClientRegistry({ graceMs: 60_000 });
  const registry = createApiRegistry();
  registry.handle("echo", async (client, ...args) => ({ kind: client.kind, args }));
  registry.handle("boom", async () => {
    throw new Error("nope");
  });
  registry.handle("web:createPairingLink", async () => ++ranSecret, "desktop-only");

  server = createWebServer({
    registry,
    clients,
    devices,
    gateContext: () => ({ expectedHost: HOST, ownerLogin: OWNER, isPairedDevice: (k) => devices.findByKey(k) !== undefined }),
    staticRoot,
    homeDir: home,
    bodyLimitBytes: 1024,
  });
  await server.listen(0);
  port = server.port();

  const { token } = devices.createPairingToken(Date.now());
  const paired = await call({ path: `/pair?token=${token}`, headers: trusted({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0" }) });
  expect(paired.status).toBe(302);
  cookie = paired.headers["set-cookie"][0].split(";")[0];
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("web server gate", () => {
  test("refuses requests that did not come through Tailscale as the owner", async () => {
    expect((await call({ path: "/", headers: { Host: HOST } })).status).toBe(403);
    expect((await call({ path: "/", headers: trusted({ Host: "evil.example" }) })).status).toBe(403);
  });

  test("an unpaired device gets the pairing instructions", async () => {
    const res = await call({ path: "/", headers: trusted() });
    expect(res.status).toBe(401);
    expect(res.text).toContain("isn't paired");
  });

  test("a pairing link works once", async () => {
    const { token } = devices.createPairingToken(Date.now());
    const first = await call({ path: `/pair?token=${token}`, headers: trusted() });
    expect(first.headers["set-cookie"][0]).toContain("HttpOnly; Secure; SameSite=Strict; Path=/");
    expect((await call({ path: `/pair?token=${token}`, headers: trusted() })).status).toBe(410);
  });
});

describe("static files", () => {
  test("serves the app and its assets to a paired device", async () => {
    const page = await call({ path: "/", headers: paired() });
    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>app</title>");
    const js = await call({ path: "/assets/app.js", headers: paired() });
    expect(js.headers["content-type"]).toContain("text/javascript");
  });

  test("never serves files outside the app folder", async () => {
    expect((await call({ path: "/%2e%2e/%2e%2e/devices.json", headers: paired() })).status).toBe(404);
  });
});

describe("API calls", () => {
  test("routes a call to the shared table as a browser client", async () => {
    const res = await apiCall("echo", [1, "a"]);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true, result: { kind: "browser", args: [1, "a"] } });
  });

  test("refuses calls from another site", async () => {
    expect((await apiCall("echo", [], { Origin: "https://evil.example" })).status).toBe(403);
  });

  test("refuses desktop-only channels without running them", async () => {
    const res = await apiCall("web:createPairingLink", []);
    expect(res.status).toBe(403);
    expect(ranSecret).toBe(0);
  });

  test("unknown channels are 404 and handler errors come back as ok:false", async () => {
    expect((await apiCall("nope", [])).status).toBe(404);
    expect(JSON.parse((await apiCall("boom", [])).text)).toEqual({ ok: false, error: "nope" });
  });

  test("malformed and oversized bodies are refused and the server keeps working", async () => {
    const malformed = await call({
      method: "POST",
      path: "/api/echo",
      headers: paired({ Origin: ORIGIN, "X-LMC-Client": "tab12345" }),
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    const tooLarge = await apiCall("echo", ["x".repeat(2048)]);
    expect(tooLarge.status).toBe(413);
    expect((await apiCall("echo", [2])).status).toBe(200);
  });

  test("requires a tab id", async () => {
    expect((await apiCall("echo", [], { "X-LMC-Client": "" })).status).toBe(400);
  });
});

describe("folder listing", () => {
  test("lists visible folders inside the home folder only", async () => {
    const res = await call({ path: "/api/fs/dirs", headers: paired() });
    const body = JSON.parse(res.text);
    expect(body.result.dirs).toEqual(["projects"]);
    expect(body.result.parent).toBeNull();
    expect((await call({ path: "/api/fs/dirs?path=%2Fetc", headers: paired() })).status).toBe(403);
  });
});

describe("live connection", () => {
  const open = (client) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?client=${client}`, {
        headers: paired({ Origin: ORIGIN }),
      });
      const messages = [];
      ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
      ws.on("open", () => resolve({ ws, messages }));
      ws.on("error", reject);
    });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  test("welcomes a new tab, delivers events, and replays them after a reconnect", async () => {
    const first = await open("tabws001");
    await settle();
    expect(first.messages).toEqual([{ type: "welcome", resumed: false }]);
    clients.get("tabws001").send("chat:event", { n: 1 });
    await settle();
    expect(first.messages[1]).toEqual({ type: "event", channel: "chat:event", payload: { n: 1 } });
    first.ws.close();
    await settle();
    clients.get("tabws001").send("chat:event", { n: 2 });
    const second = await open("tabws001");
    await settle();
    expect(second.messages).toEqual([
      { type: "event", channel: "chat:event", payload: { n: 2 } },
      { type: "welcome", resumed: true },
    ]);
    second.ws.close();
  });

  test("removing a device closes its live connection", async () => {
    const { ws } = await open("tabws002");
    const closed = new Promise((r) => ws.on("close", r));
    const device = devices.list()[0];
    server.disconnectDevice(device.id);
    await closed;
    expect(clients.get("tabws002")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test src/main/web/server.test.mjs`
Expected: FAIL with `Cannot find module './server.ts'`.

- [ ] **Step 4: Implement `src/main/web/server.ts`**

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { ApiError, type ApiRegistry } from "../api/registry";
import type { BrowserClientRegistry, SocketLike } from "./browserClients";
import { deviceLabel, type DeviceStore } from "./devices";
import { checkRequest, readCookie, type GateContext } from "./security";

export const BODY_LIMIT_BYTES = 25 * 1024 * 1024;
export const DEVICE_COOKIE = "lmc_device";
export const CLIENT_HEADER = "x-lmc-client";
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const HTML = "text/html; charset=utf-8";

const CONTENT_TYPES: Record<string, string> = {
  ".html": HTML,
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LMCanvas</title><body style="font-family:system-ui;padding:2rem;max-width:40rem"><h1>${title}</h1><p>${body}</p></body>`;

const NOT_PAIRED_PAGE = page(
  "This device isn't paired yet",
  "On your Mac, open LMCanvas → Settings → Browser access → Pair a device, then open the link it gives you on this device.",
);
const EXPIRED_PAIR_PAGE = page(
  "This pairing link has expired or was already used",
  "Create a new one in LMCanvas on your Mac: Settings → Browser access → Pair a device.",
);

export type WebServerDeps = {
  registry: ApiRegistry;
  clients: BrowserClientRegistry;
  devices: DeviceStore;
  gateContext: () => GateContext | null;
  staticRoot: string;
  homeDir: string;
  bodyLimitBytes?: number;
  now?: () => number;
};

export type WebServer = {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
  disconnectDevice(deviceId: string): void;
  port(): number | null;
};

class BodyTooLargeError extends Error {}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > limit) {
      req.resume();
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > limit) reject(new BodyTooLargeError());
      else resolveBody(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", reject);
  });
}

function isArgsBody(value: unknown): value is { args: unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { args?: unknown }).args);
}

export function createWebServer(deps: WebServerDeps): WebServer {
  const now = deps.now ?? Date.now;
  const limit = deps.bodyLimitBytes ?? BODY_LIMIT_BYTES;
  const staticRoot = resolve(deps.staticRoot);
  const homeDir = resolve(deps.homeDir);
  const wss = new WebSocketServer({ noServer: true, maxPayload: limit });
  const sockets = new Map<WebSocket, string>();
  let server: Server | null = null;

  type Authorized = { ok: true; deviceId: string | null } | { ok: false; status: number };

  const authorize = (req: IncomingMessage, path: string, isUpgrade: boolean): Authorized => {
    const ctx = deps.gateContext();
    if (!ctx) return { ok: false, status: 503 };
    const deviceKey = readCookie(req.headers.cookie, DEVICE_COOKIE);
    const result = checkRequest(
      {
        method: req.method ?? "GET",
        path,
        host: req.headers.host,
        origin: header(req, "origin"),
        tailscaleLogin: header(req, "tailscale-user-login"),
        deviceKey,
        isUpgrade,
      },
      ctx,
    );
    if (!result.ok) {
      console.warn(`[web] refused ${req.method ?? "GET"} ${path}: ${result.reason}`);
      return { ok: false, status: result.status };
    }
    const device = deviceKey ? deps.devices.findByKey(deviceKey) : undefined;
    if (device) void deps.devices.touch(device.id, now());
    return { ok: true, deviceId: device?.id ?? null };
  };

  const pair = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const token = url.searchParams.get("token") ?? "";
    const redeemed = await deps.devices.redeemPairingToken(token, deviceLabel(header(req, "user-agent")), now());
    if (!redeemed) return sendText(res, 410, EXPIRED_PAIR_PAGE, HTML);
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": `${DEVICE_COOKIE}=${redeemed.deviceKey}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
    });
    res.end();
  };

  const invoke = async (req: IncomingMessage, res: ServerResponse, url: URL, deviceId: string | null): Promise<void> => {
    const channel = decodeURIComponent(url.pathname.slice("/api/".length));
    const clientId = header(req, CLIENT_HEADER) ?? "";
    if (!deviceId || !CLIENT_ID_PATTERN.test(clientId)) {
      return sendJson(res, 400, { ok: false, error: "Missing tab id" });
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, limit));
    } catch (error) {
      return error instanceof BodyTooLargeError
        ? sendJson(res, 413, { ok: false, error: "This request is too large (limit 25 MB)." })
        : sendJson(res, 400, { ok: false, error: "Malformed request" });
    }
    if (!isArgsBody(body)) return sendJson(res, 400, { ok: false, error: "Malformed request" });
    const client = deps.clients.ensure(clientId, deviceId);
    try {
      const result = await deps.registry.invoke(channel, client, body.args);
      sendJson(res, 200, { ok: true, result: result ?? null });
    } catch (error) {
      if (error instanceof ApiError) {
        return sendJson(res, error.code === "forbidden" ? 403 : 404, { ok: false, error: error.message });
      }
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const listDirs = async (res: ServerResponse, url: URL): Promise<void> => {
    const requested = resolve(url.searchParams.get("path") || homeDir);
    if (requested !== homeDir && !requested.startsWith(homeDir + sep)) {
      return sendJson(res, 403, { ok: false, error: "Outside your home folder" });
    }
    try {
      const entries = await readdir(requested, { withFileTypes: true });
      const dirs = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      const parent = requested === homeDir ? null : dirname(requested);
      sendJson(res, 200, { ok: true, result: { path: requested, parent, dirs } });
    } catch {
      sendJson(res, 404, { ok: false, error: "Folder not found" });
    }
  };

  const serveStatic = async (res: ServerResponse, pathname: string): Promise<void> => {
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const filePath = resolve(staticRoot, relative);
    if (!filePath.startsWith(staticRoot + sep)) return sendText(res, 404, "Not found");
    try {
      const body = await readFile(filePath);
      const isIndex = filePath.endsWith("index.html");
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": isIndex ? "no-store" : "public, max-age=31536000, immutable",
      });
      res.end(body);
    } catch {
      sendText(res, 404, "Not found");
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = authorize(req, url.pathname, false);
    if (!auth.ok) {
      return auth.status === 401
        ? sendText(res, 401, NOT_PAIRED_PAGE, HTML)
        : sendText(res, auth.status, "Forbidden");
    }
    if (req.method === "GET" && url.pathname === "/pair") return pair(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/fs/dirs") return listDirs(res, url);
    if (req.method === "POST" && url.pathname.startsWith("/api/")) return invoke(req, res, url, auth.deviceId);
    if (req.method === "GET") return serveStatic(res, url.pathname);
    sendText(res, 405, "Method not allowed");
  };

  const refuseUpgrade = (socket: Duplex, status: number): void => {
    socket.write(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return refuseUpgrade(socket, 404);
    const auth = authorize(req, url.pathname, true);
    if (!auth.ok) return refuseUpgrade(socket, auth.status);
    const clientId = url.searchParams.get("client") ?? "";
    if (!auth.deviceId || !CLIENT_ID_PATTERN.test(clientId)) return refuseUpgrade(socket, 400);
    const deviceId = auth.deviceId;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tracked: SocketLike = { send: (data) => ws.send(data), close: () => ws.close() };
      sockets.set(ws, deviceId);
      const { resumed } = deps.clients.attach(clientId, deviceId, tracked);
      ws.send(JSON.stringify({ type: "welcome", resumed }));
      ws.on("close", () => {
        sockets.delete(ws);
        deps.clients.detach(clientId, tracked);
      });
    });
  };

  return {
    listen: (port) =>
      new Promise((resolveListen, reject) => {
        const created = createServer((req, res) => {
          handle(req, res).catch((error: unknown) => {
            console.error("[web] request failed:", error);
            if (!res.headersSent) sendText(res, 500, "Internal error");
          });
        });
        created.on("upgrade", upgrade);
        created.once("error", reject);
        created.listen(port, "127.0.0.1", () => {
          server = created;
          resolveListen();
        });
      }),
    close: () =>
      new Promise((resolveClose) => {
        for (const ws of sockets.keys()) ws.terminate();
        sockets.clear();
        const current = server;
        server = null;
        if (!current) return resolveClose();
        current.close(() => resolveClose());
        current.closeAllConnections();
      }),
    disconnectDevice(deviceId) {
      for (const [ws, owner] of [...sockets]) {
        if (owner === deviceId) ws.close();
      }
      deps.clients.expireDevice(deviceId);
    },
    port() {
      const address = server?.address();
      return typeof address === "object" && address !== null ? address.port : null;
    },
  };
}
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `bun test src/main/web/server.test.mjs`
Expected: PASS (14 tests). On reconnect the server replays queued events first and then sends `welcome`; the adapter (Task 12) handles events in either order.

- [ ] **Step 6: Verify typecheck and that `ws` is packaged**

Run: `bun run typecheck && rm -rf dist out && bun run build && bunx electron-builder --mac dir --arm64 --publish never -c.mac.notarize=false -c.mac.identity=null >/dev/null && bunx @electron/asar list dist/mac-arm64/LMCanvas.app/Contents/Resources/app.asar | grep -c "node_modules/ws/package.json"`
Expected: typecheck clean; prints `1` (electron-builder ships production dependencies). If it prints `0`, add `"node_modules/ws/**/*"` to `build.files` in `package.json` and repeat.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lockb src/main/web/server.ts src/main/web/server.test.mjs
git commit -m "feat: loopback web server for browser access" -m "Serves the built interface, routes POST /api/<channel> to the shared call table as a browser client, streams live events over /ws with replay, lists folders inside home for the folder picker, and pairs devices via one-time links. Every request passes the security gate; bodies are capped at 25 MB."
```

---

### Task 11: Browser-access service and app wiring

**Files:**
- Create: `src/main/web/service.ts`, `src/main/web/service.test.mjs`
- Modify: `src/shared/ipc.ts` (status types, `LmcApi.web`), `src/preload/index.ts`, `src/main/index.ts` (imports, browser clients, startup, `web:*` channels, quit)

**Interfaces:**
- Consumes: Tasks 4-10.
- Produces: `WEB_PORT = 4317`; `type BrowserAccessStatus = { enabled; running; keepAwake; url: string | null; problem: string | null; devices: PairedDeviceSummary[] }`; `type PairedDeviceSummary = { id; label; createdAt; lastSeenAt }`; `type PairingLink = { url; expiresAt }`; `createWebService(deps): WebService` with `status() / setEnabled(bool) / setKeepAwake(bool) / createPairingLink() / removeDevice(id) / startIfEnabled() / shutdown() / gateContext()`; `isLocalPortFree(port)`; `LmcApi.web = { status; setEnabled; setKeepAwake; createPairingLink; removeDevice }`.

- [ ] **Step 1: Write the failing service test**

Create `src/main/web/service.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { WEB_PORT, createWebService } from "./service.ts";

const HOST = "my-mac.tail1234.ts.net";
const OURS = `http://127.0.0.1:${WEB_PORT}`;

function harness({ info, serve, portFree = true, keepAwake = true } = {}) {
  const calls = [];
  const tsState = {
    info: info ?? { running: true, host: HOST, ownerLogin: "me@example.com", httpsAvailable: true },
    serve: serve ?? { httpsInUse: false, proxiesTo: null },
  };
  const tailscale = {
    info: async () => tsState.info,
    serveState: async () => tsState.serve,
    enableServe: async (port) => {
      calls.push(["enableServe", port]);
      tsState.serve = { httpsInUse: true, proxiesTo: `http://127.0.0.1:${port}` };
    },
    disableServe: async () => {
      calls.push(["disableServe"]);
      tsState.serve = { httpsInUse: false, proxiesTo: null };
    },
  };
  let listening = null;
  const server = {
    listen: async (port) => {
      calls.push(["listen", port]);
      listening = port;
    },
    close: async () => {
      calls.push(["close"]);
      listening = null;
    },
    disconnectDevice: (id) => calls.push(["disconnect", id]),
    port: () => listening,
  };
  let browserAccess = { enabled: false, keepAwake };
  const awake = new Set();
  let nextBlocker = 1;
  const service = createWebService({
    tailscale,
    server,
    devices: {
      createPairingToken: (now) => ({ token: "tok123", expiresAt: now + 600_000 }),
      findByKey: (key) => (key === "good" ? { id: "d1" } : undefined),
      list: () => [{ id: "d1", label: "Chrome on Windows", keyHash: "secret-hash", createdAt: 1, lastSeenAt: 2 }],
      remove: async (id) => {
        calls.push(["remove", id]);
        return true;
      },
    },
    readSettings: async () => ({ browserAccess }),
    writeBrowserAccess: async (patch) => {
      browserAccess = { ...browserAccess, ...patch };
      return { browserAccess };
    },
    powerSave: {
      start: () => {
        const id = nextBlocker++;
        awake.add(id);
        return id;
      },
      stop: (id) => awake.delete(id),
    },
    isPortFree: async () => portFree,
    expireBrowserClients: () => calls.push(["expireClients"]),
    now: () => 1_000,
  });
  return { service, calls, tsState, awake, settings: () => browserAccess };
}

describe("createWebService", () => {
  test("turning it on starts the server, publishes it via Serve and keeps the Mac awake", async () => {
    const h = harness();
    const status = await h.service.setEnabled(true);
    expect(status).toMatchObject({ enabled: true, running: true, url: `https://${HOST}`, problem: null });
    expect(h.calls).toEqual([["listen", WEB_PORT], ["enableServe", WEB_PORT]]);
    expect(h.awake.size).toBe(1);
    expect(h.service.gateContext()).toMatchObject({ expectedHost: HOST, ownerLogin: "me@example.com" });
  });

  test("never exposes device key hashes in status", async () => {
    const status = await harness().service.status();
    expect(status.devices).toEqual([{ id: "d1", label: "Chrome on Windows", createdAt: 1, lastSeenAt: 2 }]);
  });

  test.each([
    ["Tailscale not running", { info: { running: false, host: null, ownerLogin: null, httpsAvailable: false } }, "Tailscale isn't running"],
    ["not signed in", { info: { running: true, host: null, ownerLogin: null, httpsAvailable: false } }, "isn't signed in"],
    ["HTTPS certificates off", { info: { running: true, host: HOST, ownerLogin: "me@example.com", httpsAvailable: false } }, "HTTPS certificates are off"],
    ["HTTPS taken by another Serve setup", { serve: { httpsInUse: true, proxiesTo: "http://127.0.0.1:9000" } }, "already used by another Tailscale Serve setup"],
    ["port busy", { portFree: false }, "Port 4317"],
  ])("%s: stays off and says why", async (_label, opts, message) => {
    const h = harness(opts);
    const status = await h.service.setEnabled(true);
    expect(status.running).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.problem).toContain(message);
    expect(h.calls.find(([name]) => name === "enableServe")).toBeUndefined();
    expect(h.service.gateContext()).toBeNull();
  });

  test("an existing mapping to our port is reused, not re-created", async () => {
    const h = harness({ serve: { httpsInUse: true, proxiesTo: OURS } });
    await h.service.setEnabled(true);
    expect(h.calls).toEqual([["listen", WEB_PORT]]);
  });

  test("turning it off removes our Serve mapping, stops the server and lets the Mac sleep", async () => {
    const h = harness();
    await h.service.setEnabled(true);
    const status = await h.service.setEnabled(false);
    expect(status).toMatchObject({ enabled: false, running: false, url: null });
    expect(h.calls.slice(2)).toEqual([["disableServe"], ["close"], ["expireClients"]]);
    expect(h.awake.size).toBe(0);
  });

  test("does not remove a Serve mapping someone else replaced ours with", async () => {
    const h = harness();
    await h.service.setEnabled(true);
    h.tsState.serve = { httpsInUse: true, proxiesTo: "http://127.0.0.1:9000" };
    await h.service.setEnabled(false);
    expect(h.calls.find(([name]) => name === "disableServe")).toBeUndefined();
  });

  test("keep-awake follows the setting", async () => {
    const h = harness({ keepAwake: false });
    await h.service.setEnabled(true);
    expect(h.awake.size).toBe(0);
    await h.service.setKeepAwake(true);
    expect(h.awake.size).toBe(1);
    await h.service.setKeepAwake(false);
    expect(h.awake.size).toBe(0);
  });

  test("pairing links need browser access on and use the .ts.net address", async () => {
    const h = harness();
    expect(() => h.service.createPairingLink()).toThrow("Turn on browser access first.");
    await h.service.setEnabled(true);
    expect(h.service.createPairingLink()).toEqual({ url: `https://${HOST}/pair?token=tok123`, expiresAt: 601_000 });
  });

  test("removing a device revokes it and closes its connections", async () => {
    const h = harness();
    await h.service.removeDevice("d1");
    expect(h.calls).toEqual([["remove", "d1"], ["disconnect", "d1"]]);
  });

  test("startIfEnabled starts only when the setting is on; shutdown keeps the setting", async () => {
    const h = harness();
    await h.service.startIfEnabled();
    expect(h.calls).toEqual([]);
    await h.service.setEnabled(true);
    await h.service.shutdown();
    expect(h.settings().enabled).toBe(true);
    expect((await h.service.status()).running).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/main/web/service.test.mjs`
Expected: FAIL with `Cannot find module './service.ts'`.

- [ ] **Step 3: Add shared types and the API surface**

In `src/shared/ipc.ts`, before `export type LmcApi = {`, add:

```ts
export type PairedDeviceSummary = { id: string; label: string; createdAt: number; lastSeenAt: number };

export type BrowserAccessStatus = {
  enabled: boolean;
  running: boolean;
  keepAwake: boolean;
  url: string | null;
  problem: string | null;
  devices: PairedDeviceSummary[];
};

export type PairingLink = { url: string; expiresAt: number };
```

Inside `LmcApi`, after `canvasLock: { … };`, add:

```ts
  web: {
    /** Desktop-only: browser access over Tailscale. */
    status(): Promise<BrowserAccessStatus>;
    setEnabled(enabled: boolean): Promise<BrowserAccessStatus>;
    setKeepAwake(keepAwake: boolean): Promise<BrowserAccessStatus>;
    createPairingLink(): Promise<PairingLink>;
    removeDevice(deviceId: string): Promise<BrowserAccessStatus>;
  };
```

In `src/preload/index.ts`, after the `canvasLock` block, add:

```ts
  web: {
    status: () => ipcRenderer.invoke("web:status"),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke("web:setEnabled", enabled),
    setKeepAwake: (keepAwake: boolean) => ipcRenderer.invoke("web:setKeepAwake", keepAwake),
    createPairingLink: () => ipcRenderer.invoke("web:createPairingLink"),
    removeDevice: (deviceId: string) => ipcRenderer.invoke("web:removeDevice", deviceId),
  },
```

- [ ] **Step 4: Implement `src/main/web/service.ts`**

```ts
import { createServer as createNetServer } from "node:net";
import type { BrowserAccessStatus, PairingLink } from "@shared/ipc";
import type { AppSettings, BrowserAccessSettings } from "@shared/types";
import type { DeviceStore } from "./devices";
import type { GateContext } from "./security";
import type { WebServer } from "./server";
import { serveTarget, type TailscaleControl } from "./tailscale";

export const WEB_PORT = 4317;

const PROBLEMS = {
  notRunning: "Tailscale isn't running. Open the Tailscale app and sign in, then try again.",
  notSignedIn: "Tailscale isn't signed in on this Mac.",
  noHttps:
    "HTTPS certificates are off for your Tailscale network. Turn on HTTPS in the Tailscale admin console (DNS page), then try again.",
  httpsTaken:
    "HTTPS on this Mac is already used by another Tailscale Serve setup, so LMCanvas won't replace it.",
  portBusy: (port: number) => `Port ${port} on this Mac is already in use.`,
} as const;

export type PowerSave = { start(): number; stop(id: number): void };

export type WebServiceDeps = {
  tailscale: TailscaleControl;
  server: Pick<WebServer, "listen" | "close" | "disconnectDevice" | "port">;
  devices: Pick<DeviceStore, "createPairingToken" | "findByKey" | "list" | "remove">;
  readSettings: () => Promise<Pick<AppSettings, "browserAccess">>;
  writeBrowserAccess: (patch: Partial<BrowserAccessSettings>) => Promise<Pick<AppSettings, "browserAccess">>;
  powerSave: PowerSave;
  isPortFree: (port: number) => Promise<boolean>;
  expireBrowserClients: () => void;
  port?: number;
  now?: () => number;
};

export type WebService = {
  status(): Promise<BrowserAccessStatus>;
  setEnabled(enabled: boolean): Promise<BrowserAccessStatus>;
  setKeepAwake(keepAwake: boolean): Promise<BrowserAccessStatus>;
  createPairingLink(): PairingLink;
  removeDevice(deviceId: string): Promise<BrowserAccessStatus>;
  startIfEnabled(): Promise<void>;
  shutdown(): Promise<void>;
  gateContext(): GateContext | null;
};

export function createWebService(deps: WebServiceDeps): WebService {
  const port = deps.port ?? WEB_PORT;
  const now = deps.now ?? Date.now;
  let live: { host: string; ownerLogin: string } | null = null;
  let problem: string | null = null;
  let blockerId: number | null = null;

  const keepAwakeSetting = async (): Promise<boolean> =>
    (await deps.readSettings()).browserAccess?.keepAwake !== false;

  const applyAwake = (keepAwake: boolean): void => {
    if (live && keepAwake) {
      if (blockerId === null) blockerId = deps.powerSave.start();
      return;
    }
    if (blockerId !== null) {
      deps.powerSave.stop(blockerId);
      blockerId = null;
    }
  };

  const start = async (): Promise<string | null> => {
    try {
      const info = await deps.tailscale.info().catch(() => null);
      if (!info || !info.running) return PROBLEMS.notRunning;
      if (!info.host || !info.ownerLogin) return PROBLEMS.notSignedIn;
      if (!info.httpsAvailable) return PROBLEMS.noHttps;
      const serve = await deps.tailscale.serveState(info.host);
      const ours = serve.proxiesTo === serveTarget(port);
      if (serve.httpsInUse && !ours) return PROBLEMS.httpsTaken;
      if (deps.server.port() === null) {
        if (!(await deps.isPortFree(port))) return PROBLEMS.portBusy(port);
        await deps.server.listen(port);
      }
      if (!ours) await deps.tailscale.enableServe(port);
      live = { host: info.host, ownerLogin: info.ownerLogin };
      return null;
    } catch (error) {
      await deps.server.close();
      return `Couldn't set up Tailscale Serve: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const stop = async (): Promise<void> => {
    if (live) {
      const serve = await deps.tailscale.serveState(live.host).catch(() => null);
      if (serve?.proxiesTo === serveTarget(port)) {
        await deps.tailscale.disableServe().catch((error: unknown) => {
          console.warn("[web] couldn't remove Serve mapping:", error);
        });
      }
    }
    live = null;
    await deps.server.close();
    deps.expireBrowserClients();
    applyAwake(false);
  };

  const status = async (): Promise<BrowserAccessStatus> => {
    const settings = await deps.readSettings();
    return {
      enabled: settings.browserAccess?.enabled === true,
      running: live !== null,
      keepAwake: settings.browserAccess?.keepAwake !== false,
      url: live ? `https://${live.host}` : null,
      problem,
      devices: deps.devices
        .list()
        .map(({ id, label, createdAt, lastSeenAt }) => ({ id, label, createdAt, lastSeenAt })),
    };
  };

  return {
    status,
    async setEnabled(enabled) {
      if (!enabled) {
        await stop();
        problem = null;
        await deps.writeBrowserAccess({ enabled: false });
        return status();
      }
      problem = await start();
      if (problem) {
        live = null;
        await deps.writeBrowserAccess({ enabled: false });
      } else {
        await deps.writeBrowserAccess({ enabled: true });
      }
      applyAwake(await keepAwakeSetting());
      return status();
    },
    async setKeepAwake(keepAwake) {
      await deps.writeBrowserAccess({ keepAwake });
      applyAwake(keepAwake);
      return status();
    },
    createPairingLink() {
      if (!live) throw new Error("Turn on browser access first.");
      const { token, expiresAt } = deps.devices.createPairingToken(now());
      return { url: `https://${live.host}/pair?token=${token}`, expiresAt };
    },
    async removeDevice(deviceId) {
      await deps.devices.remove(deviceId);
      deps.server.disconnectDevice(deviceId);
      return status();
    },
    async startIfEnabled() {
      if ((await deps.readSettings()).browserAccess?.enabled !== true) return;
      problem = await start();
      applyAwake(await keepAwakeSetting());
    },
    shutdown: stop,
    gateContext() {
      if (!live) return null;
      return {
        expectedHost: live.host,
        ownerLogin: live.ownerLogin,
        isPairedDevice: (deviceKey) => deps.devices.findByKey(deviceKey) !== undefined,
      };
    },
  };
}

export function isLocalPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
```

- [ ] **Step 5: Run the service test to verify it passes**

Run: `bun test src/main/web/service.test.mjs`
Expected: PASS (14 tests).

- [ ] **Step 6: Wire everything into `src/main/index.ts`**

1. Add `powerSaveBlocker` to the `electron` import on line 1, and add:

```ts
import { ROOT_DIR } from "./storage/paths";
import { createBrowserClientRegistry } from "./web/browserClients";
import { loadDeviceStore } from "./web/devices";
import { createWebServer } from "./web/server";
import { createTailscale } from "./web/tailscale";
import { createWebService, isLocalPortFree, type WebService } from "./web/service";
```

Change the settings import to `import { readSettings, writeBrowserAccess, writeSettings } from "./storage/settings";`.

2. Below `watchClient`, add:

```ts
const BROWSER_CLIENT_GRACE_MS = 2 * 60 * 1000;
const browserClients = createBrowserClientRegistry({
  graceMs: BROWSER_CLIENT_GRACE_MS,
  onCreated: watchClient,
});
let activeWebService: WebService | null = null;

async function createBrowserAccess(): Promise<WebService> {
  const devices = await loadDeviceStore(join(ROOT_DIR, "web-devices.json"));
  let service: WebService | null = null;
  const server = createWebServer({
    registry: api,
    clients: browserClients,
    devices,
    gateContext: () => service?.gateContext() ?? null,
    staticRoot: join(__dirname, "../renderer"),
    homeDir: homedir(),
  });
  service = createWebService({
    tailscale: createTailscale(),
    server,
    devices,
    readSettings,
    writeBrowserAccess,
    powerSave: {
      start: () => powerSaveBlocker.start("prevent-app-suspension"),
      stop: (id) => powerSaveBlocker.stop(id),
    },
    isPortFree: isLocalPortFree,
    expireBrowserClients: () => browserClients.expireAll(),
  });
  return service;
}

function registerWebChannels(service: WebService): void {
  api.handle("web:status", async () => service.status(), "desktop-only");
  api.handle("web:setEnabled", async (_client, enabled: boolean) => service.setEnabled(enabled), "desktop-only");
  api.handle("web:setKeepAwake", async (_client, keepAwake: boolean) => service.setKeepAwake(keepAwake), "desktop-only");
  api.handle("web:createPairingLink", async () => service.createPairingLink(), "desktop-only");
  api.handle("web:removeDevice", async (_client, deviceId: string) => service.removeDevice(deviceId), "desktop-only");
}
```

3. In `app.whenReady()`, replace the `registerIpc();` / `bindRegistryToIpc(…);` pair with:

```ts
  registerIpc();
  const webService = await createBrowserAccess();
  registerWebChannels(webService);
  bindRegistryToIpc(api, ipcMain, (sender) => watchClient(desktopClient(sender)));
  activeWebService = webService;
```

After `installUpdateMenuItem();`, add:

```ts
  void webService
    .startIfEnabled()
    .catch((error) => console.warn("[web] browser access not started:", error));
```

4. Replace the `before-quit` handler with:

```ts
app.on("before-quit", (event) => {
  if (activeWebService) {
    event.preventDefault();
    const service = activeWebService;
    activeWebService = null;
    void service
      .shutdown()
      .catch((error) => console.warn("[web] shutdown failed:", error))
      .finally(() => app.quit());
    return;
  }
  shutdownCodexAppServers();
});
```

- [ ] **Step 7: Verify**

Run: `bun test src/main/web/service.test.mjs && bun run typecheck && bun run build`
Expected: pass; clean; `✓ built`.

- [ ] **Step 8: Commit**

```bash
git add src/main/web/service.ts src/main/web/service.test.mjs src/shared/ipc.ts src/preload/index.ts src/main/index.ts
git commit -m "feat: turn browser access on and off from the desktop app" -m "The service checks Tailscale (running, signed in, HTTPS certificates, Serve conflicts) and the port, starts the server, publishes it with tailscale serve, keeps the Mac awake if asked, and undoes only its own Serve mapping on disable or quit. Management channels are desktop-only."
```

---

### Task 12: Browser adapter (`window.api` over HTTP and WebSocket)

**Files:**
- Create: `src/renderer/src/lib/webUi.ts` (stores and UI slots), `src/renderer/src/lib/webBridge.ts`, `src/renderer/src/lib/webBridge.test.mjs`, `src/renderer/src/lib/webUi.test.mjs`
- Modify: `src/renderer/src/main.tsx`

**Interfaces:**
- Consumes: wire protocol (Task 10), `LmcApi` (with `canvasLock` and `web`).
- Produces: `isBrowser: boolean`; `CONNECTION_LOST_MESSAGE = "Stopped: connection lost"`; `LOGIN_ON_MAC_MESSAGE`; `type ConnectionState = "connecting" | "connected" | "reconnecting"`; `createWebApi(deps: WebBridgeDeps): LmcApi`; `installWebApiIfNeeded(): void`. From `webUi.ts`: `useWebUiStore` (`connection`, `notice`, `setConnection`, `showNotice`, `clearNotice`), `registerFolderPicker(fn): () => void`, `pickFolderViaUi(defaultPath?)`, `copyPathViaUi(path)`, `type DirListing = { path; parent: string | null; dirs: string[] }`, `parseDirListing(body: unknown): DirListing | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/lib/webUi.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { parseDirListing, pickFolderViaUi, registerFolderPicker, useWebUiStore } from "./webUi.ts";

describe("folder picker slot", () => {
  test("returns null when no picker is mounted", async () => {
    expect(await pickFolderViaUi("/x")).toBeNull();
  });
  test("delegates to the mounted picker until it unmounts", async () => {
    const unregister = registerFolderPicker(async (start) => `${start}/chosen`);
    expect(await pickFolderViaUi("/home")).toBe("/home/chosen");
    unregister();
    expect(await pickFolderViaUi("/home")).toBeNull();
  });
});

describe("parseDirListing", () => {
  test("accepts a well-formed listing", () => {
    const body = { ok: true, result: { path: "/Users/me", parent: null, dirs: ["a", "b"] } };
    expect(parseDirListing(body)).toEqual({ path: "/Users/me", parent: null, dirs: ["a", "b"] });
  });
  test("rejects errors and malformed bodies", () => {
    expect(parseDirListing({ ok: false, error: "x" })).toBeNull();
    expect(parseDirListing({ ok: true, result: { path: 1, dirs: [] } })).toBeNull();
    expect(parseDirListing(null)).toBeNull();
  });
});

describe("useWebUiStore", () => {
  test("tracks connection state and notices", () => {
    useWebUiStore.getState().setConnection("reconnecting");
    useWebUiStore.getState().showNotice("Path copied: /x");
    expect(useWebUiStore.getState().connection).toBe("reconnecting");
    expect(useWebUiStore.getState().notice).toBe("Path copied: /x");
    useWebUiStore.getState().clearNotice();
    expect(useWebUiStore.getState().notice).toBeNull();
  });
});
```

Create `src/renderer/src/lib/webBridge.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { CONNECTION_LOST_MESSAGE, LOGIN_ON_MAC_MESSAGE, createWebApi } from "./webBridge.ts";

const ORIGIN = "https://my-mac.tail1234.ts.net";

function harness(responses = {}) {
  const fetchCalls = [];
  const sockets = [];
  const scheduled = [];
  const states = [];
  const ui = { picked: [], copied: [], opened: [], notices: [] };
  const api = createWebApi({
    fetchFn: async (url, init) => {
      fetchCalls.push({ url, init });
      const channel = decodeURIComponent(url.split("/api/")[1]);
      return { status: 200, json: async () => responses[channel] ?? { ok: true, result: null } };
    },
    openSocket: (url) => {
      const socket = { url, onopen: null, onmessage: null, onclose: null, closed: false, close() { socket.closed = true; } };
      sockets.push(socket);
      return socket;
    },
    origin: ORIGIN,
    clientId: "client123456",
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
    ui: {
      pickFolder: async (start) => {
        ui.picked.push(start);
        return "/Users/me/project";
      },
      copyPath: async (path) => {
        ui.copied.push(path);
      },
      openUrl: (url) => ui.opened.push(url),
      notify: (message) => ui.notices.push(message),
    },
    onConnection: (state) => states.push(state),
  });
  const last = () => sockets[sockets.length - 1];
  const server = {
    welcome: (resumed) => last().onmessage({ data: JSON.stringify({ type: "welcome", resumed }) }),
    event: (channel, payload) => last().onmessage({ data: JSON.stringify({ type: "event", channel, payload }) }),
    drop: () => last().onclose(),
  };
  return { api, fetchCalls, sockets, scheduled, states, ui, server };
}

describe("createWebApi calls", () => {
  test("POSTs the channel and args with the tab id and returns the result", async () => {
    const h = harness({ "canvases:read": { ok: true, result: { id: "c1" } } });
    expect(await h.api.canvases.read("c1")).toEqual({ id: "c1" });
    const { url, init } = h.fetchCalls[0];
    expect(url).toBe(`${ORIGIN}/api/canvases%3Aread`);
    expect(init.method).toBe("POST");
    expect(init.headers["X-LMC-Client"]).toBe("client123456");
    expect(JSON.parse(init.body)).toEqual({ args: ["c1"] });
  });

  test("turns ok:false into a rejected promise with the server's message", async () => {
    const h = harness({ "canvases:write": { ok: false, error: "This chat is open on another device." } });
    await expect(h.api.canvases.write({ id: "c1" })).rejects.toThrow("This chat is open on another device.");
  });
});

describe("createWebApi live events", () => {
  test("connects to /ws with the tab id and reports the connection", () => {
    const h = harness();
    expect(h.sockets[0].url).toBe("wss://my-mac.tail1234.ts.net/ws?client=client123456");
    expect(h.states).toEqual(["connecting"]);
    h.server.welcome(false);
    expect(h.states).toEqual(["connecting", "connected"]);
  });

  test("delivers chat events and ask-user requests to subscribers", () => {
    const h = harness();
    const chat = [];
    const asks = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    h.api.askUser.onRequest((req) => asks.push(req));
    h.server.event("chat:event", { chatId: "c1", type: "text_delta", text: "hi" });
    h.server.event("askUser:request", { id: "q1", nodeId: "n1", questions: [] });
    expect(chat).toEqual([{ chatId: "c1", type: "text_delta", text: "hi" }]);
    expect(asks).toEqual([{ id: "q1", nodeId: "n1", questions: [] }]);
  });

  test("marks running chats stopped when the Mac no longer knows this tab", async () => {
    const h = harness();
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    await h.api.chat.start({ chatId: "c1" });
    await h.api.chat.start({ chatId: "c2" });
    h.server.event("chat:event", { chatId: "c2", type: "done" });
    h.server.drop();
    h.scheduled[0].fn();
    h.server.welcome(false);
    expect(chat.slice(1)).toEqual([
      { chatId: "c1", type: "error", message: CONNECTION_LOST_MESSAGE },
      { chatId: "c1", type: "done", isError: true },
    ]);
  });

  test("a resumed tab gets no synthetic stop events", async () => {
    const h = harness();
    const chat = [];
    h.api.chat.onEvent((ev) => chat.push(ev));
    await h.api.chat.start({ chatId: "c1" });
    h.server.drop();
    h.scheduled[0].fn();
    h.server.welcome(true);
    expect(chat).toEqual([]);
  });

  test("reconnects with backoff 1s, 2s, 4s, 8s, then 10s", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.server.drop();
      h.scheduled[i].fn();
    }
    expect(h.scheduled.map((s) => s.ms)).toEqual([1000, 2000, 4000, 8000, 10000]);
    expect(h.states.filter((s) => s === "reconnecting")).toHaveLength(5);
  });

  test("a successful connection resets the backoff", () => {
    const h = harness();
    h.server.drop();
    h.scheduled[0].fn();
    h.server.drop();
    h.scheduled[1].fn();
    h.sockets[h.sockets.length - 1].onopen();
    h.server.drop();
    expect(h.scheduled[2].ms).toBe(1000);
  });
});

describe("createWebApi desktop-only substitutes", () => {
  test("folder picking, file paths, links and login use the browser UI", async () => {
    const h = harness();
    expect(await h.api.dialog.pickFolder("/Users/me")).toBe("/Users/me/project");
    await h.api.shell.openPath("/Users/me/notes.md");
    await h.api.window.openCanvas("abc");
    await h.api.providers.openLoginTerminal("claude");
    expect(h.ui.picked).toEqual(["/Users/me"]);
    expect(h.ui.copied).toEqual(["/Users/me/notes.md"]);
    expect(h.ui.opened).toEqual([`${ORIGIN}/#/canvas/abc`]);
    expect(h.ui.notices).toEqual([LOGIN_ON_MAC_MESSAGE]);
  });

  test("browser-access management is refused in the browser", async () => {
    const h = harness();
    await expect(h.api.web.createPairingLink()).rejects.toThrow("desktop app");
    expect(h.fetchCalls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/renderer/src/lib/webUi.test.mjs src/renderer/src/lib/webBridge.test.mjs`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/renderer/src/lib/webUi.ts`**

```ts
import { create } from "zustand";

export type ConnectionState = "connecting" | "connected" | "reconnecting";
export type DirListing = { path: string; parent: string | null; dirs: string[] };

const NOTICE_MS = 3_000;

type WebUiState = {
  connection: ConnectionState;
  notice: string | null;
  setConnection: (connection: ConnectionState) => void;
  showNotice: (message: string) => void;
  clearNotice: () => void;
};

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export const useWebUiStore = create<WebUiState>()((set) => ({
  connection: "connecting",
  notice: null,
  setConnection: (connection) => set({ connection }),
  showNotice: (message) => {
    clearTimeout(noticeTimer);
    set({ notice: message });
    noticeTimer = setTimeout(() => set({ notice: null }), NOTICE_MS);
  },
  clearNotice: () => {
    clearTimeout(noticeTimer);
    set({ notice: null });
  },
}));

type FolderPicker = (defaultPath?: string) => Promise<string | null>;
let folderPicker: FolderPicker | null = null;

export function registerFolderPicker(picker: FolderPicker): () => void {
  folderPicker = picker;
  return () => {
    if (folderPicker === picker) folderPicker = null;
  };
}

export function pickFolderViaUi(defaultPath?: string): Promise<string | null> {
  return folderPicker ? folderPicker(defaultPath) : Promise.resolve(null);
}

export async function copyPathViaUi(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    useWebUiStore.getState().showNotice(`Path copied: ${path}`);
  } catch {
    useWebUiStore.getState().showNotice(path);
  }
}

export function parseDirListing(body: unknown): DirListing | null {
  if (typeof body !== "object" || body === null) return null;
  const { ok, result } = body as { ok?: unknown; result?: unknown };
  if (ok !== true || typeof result !== "object" || result === null) return null;
  const { path, parent, dirs } = result as { path?: unknown; parent?: unknown; dirs?: unknown };
  if (typeof path !== "string") return null;
  if (parent !== null && typeof parent !== "string") return null;
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === "string")) return null;
  return { path, parent, dirs };
}
```

- [ ] **Step 4: Implement `src/renderer/src/lib/webBridge.ts`**

```ts
import type { ChatEvent, LmcApi } from "@shared/ipc";
import {
  copyPathViaUi,
  pickFolderViaUi,
  useWebUiStore,
  type ConnectionState,
} from "@/lib/webUi";

export const isBrowser: boolean = typeof window !== "undefined" && !("api" in window);
export const CONNECTION_LOST_MESSAGE = "Stopped: connection lost";
export const LOGIN_ON_MAC_MESSAGE =
  "To sign in to a provider, open LMCanvas on the Mac and sign in there.";
const DESKTOP_ONLY_MESSAGE = "Manage browser access from the LMCanvas desktop app.";
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 10_000;

export type WebSocketLike = {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  close(): void;
};

type FetchLike = (
  url: string,
  init: { method: string; credentials: "same-origin"; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type WebBridgeDeps = {
  fetchFn: FetchLike;
  openSocket: (url: string) => WebSocketLike;
  origin: string;
  clientId: string;
  schedule: (fn: () => void, ms: number) => void;
  ui: {
    pickFolder(defaultPath?: string): Promise<string | null>;
    copyPath(path: string): Promise<void>;
    openUrl(url: string): void;
    notify(message: string): void;
  };
  onConnection: (state: ConnectionState) => void;
};

type ServerMessage =
  | { type: "welcome"; resumed: boolean }
  | { type: "event"; channel: string; payload: unknown };

function parseMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null) return null;
    const message = value as Record<string, unknown>;
    if (message.type === "welcome") return { type: "welcome", resumed: message.resumed === true };
    if (message.type === "event" && typeof message.channel === "string") {
      return { type: "event", channel: message.channel, payload: message.payload };
    }
    return null;
  } catch {
    return null;
  }
}

function resultOf(body: unknown, status: number): unknown {
  if (typeof body === "object" && body !== null) {
    const response = body as { ok?: unknown; result?: unknown; error?: unknown };
    if (response.ok === true) return response.result;
    if (typeof response.error === "string") throw new Error(response.error);
  }
  throw new Error(`Request failed (${status})`);
}

const desktopOnly = (): Promise<never> => Promise.reject(new Error(DESKTOP_ONLY_MESSAGE));

export function createWebApi(deps: WebBridgeDeps): LmcApi {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let following = new Set<string>();
  let retryMs = MIN_RETRY_MS;

  const emit = (channel: string, payload: unknown): void => {
    if (channel === "chat:event") {
      const ev = payload as ChatEvent;
      if (ev.type === "done") following = new Set([...following].filter((id) => id !== ev.chatId));
    }
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };

  const subscribe = <T>(channel: string, handler: (payload: T) => void): (() => void) => {
    const listener = (payload: unknown) => handler(payload as T);
    listeners.set(channel, new Set([...(listeners.get(channel) ?? []), listener]));
    return () => {
      listeners.set(channel, new Set([...(listeners.get(channel) ?? [])].filter((l) => l !== listener)));
    };
  };

  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const response = await deps.fetchFn(`${deps.origin}/api/${encodeURIComponent(channel)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-LMC-Client": deps.clientId },
      body: JSON.stringify({ args }),
    });
    const body: unknown = await response.json().catch(() => null);
    return resultOf(body, response.status) as T;
  };

  const stopFollowedChats = (): void => {
    for (const chatId of [...following]) {
      emit("chat:event", { chatId, type: "error", message: CONNECTION_LOST_MESSAGE });
      emit("chat:event", { chatId, type: "done", isError: true });
    }
  };

  const connect = (): void => {
    const socket = deps.openSocket(
      `${deps.origin.replace(/^http/, "ws")}/ws?client=${encodeURIComponent(deps.clientId)}`,
    );
    socket.onopen = () => {
      retryMs = MIN_RETRY_MS;
    };
    socket.onmessage = (ev) => {
      const message = parseMessage(ev.data);
      if (!message) return;
      if (message.type === "event") return emit(message.channel, message.payload);
      deps.onConnection("connected");
      if (!message.resumed) stopFollowedChats();
    };
    socket.onclose = () => {
      deps.onConnection("reconnecting");
      deps.schedule(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };
  };

  deps.onConnection("connecting");
  connect();

  return {
    canvases: {
      list: () => call("canvases:list"),
      create: (args) => call("canvases:create", args),
      read: (id) => call("canvases:read", id),
      write: (canvas) => call("canvases:write", canvas),
      delete: (id) => call("canvases:delete", id),
    },
    settings: {
      read: () => call("settings:read"),
      write: (s) => call("settings:write", s),
    },
    chat: {
      start: (args) => {
        following = new Set([...following, args.chatId]);
        return call("chat:start", args);
      },
      cancel: (chatId) => call("chat:cancel", chatId),
      cancelForNode: (nodeId) => call("chat:cancelForNode", nodeId),
      onEvent: (handler) => subscribe("chat:event", handler),
    },
    dialog: { pickFolder: (defaultPath) => deps.ui.pickFolder(defaultPath) },
    shell: { openPath: (path) => deps.ui.copyPath(path) },
    processes: {
      start: (args) => call("processes:start", args),
      stop: (id) => call("processes:stop", id),
    },
    files: { list: (cwd) => call("files:list", cwd) },
    slash: { list: (cwd) => call("slash:list", cwd) },
    providers: {
      authStatus: (provider) => call("providers:authStatus", provider),
      openLoginTerminal: async () => {
        deps.ui.notify(LOGIN_ON_MAC_MESSAGE);
      },
      codexRuntime: () => call("providers:codexRuntime"),
    },
    askUser: {
      onRequest: (handler) => subscribe("askUser:request", handler),
      respond: (payload) => call("askUser:respond", payload),
    },
    window: {
      openCanvas: async (canvasId) => {
        deps.ui.openUrl(canvasId ? `${deps.origin}/#/canvas/${canvasId}` : `${deps.origin}/`);
      },
    },
    groupSummary: { generate: (args) => call("groupSummary:generate", args) },
    canvasName: { generate: (args) => call("canvasName:generate", args) },
    canvasLock: {
      acquire: (canvasId) => call("canvasLock:acquire", canvasId),
      takeOver: (canvasId) => call("canvasLock:takeOver", canvasId),
      release: (canvasId) => call("canvasLock:release", canvasId),
      onLost: (handler) => subscribe("canvas:lockLost", handler),
    },
    web: {
      status: desktopOnly,
      setEnabled: desktopOnly,
      setKeepAwake: desktopOnly,
      createPairingLink: desktopOnly,
      removeDevice: desktopOnly,
    },
  };
}

function browserSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  const like: WebSocketLike = { onopen: null, onmessage: null, onclose: null, close: () => ws.close() };
  ws.onopen = () => like.onopen?.();
  ws.onmessage = (ev) => like.onmessage?.({ data: ev.data });
  ws.onclose = () => like.onclose?.();
  return like;
}

export function installWebApiIfNeeded(): void {
  if (!isBrowser) return;
  window.api = createWebApi({
    fetchFn: (url, init) => window.fetch(url, init),
    openSocket: browserSocket,
    origin: window.location.origin,
    clientId: crypto.randomUUID().replace(/-/g, ""),
    schedule: (fn, ms) => {
      window.setTimeout(fn, ms);
    },
    ui: {
      pickFolder: pickFolderViaUi,
      copyPath: copyPathViaUi,
      openUrl: (url) => {
        window.open(url, "_blank", "noopener");
      },
      notify: (message) => useWebUiStore.getState().showNotice(message),
    },
    onConnection: (state) => useWebUiStore.getState().setConnection(state),
  });
}
```

- [ ] **Step 5: Install the adapter before the app renders**

In `src/renderer/src/main.tsx`, add `import { installWebApiIfNeeded } from "./lib/webBridge";` after the existing imports, and call `installWebApiIfNeeded();` on the line before `ReactDOM.createRoot(…)`.

- [ ] **Step 6: Verify**

Run: `bun test src/renderer/src/lib/webUi.test.mjs src/renderer/src/lib/webBridge.test.mjs && bun run typecheck`
Expected: 15 tests pass; typecheck clean. The `LmcApi` object literal must satisfy every member, so a missing channel is a type error here. `call`'s result type is inferred from each `LmcApi` member's return type. If TypeScript reports an `unknown` result on a line, name the type at that call, e.g. `call<CanvasSummary[]>("canvases:list")`.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/webUi.ts src/renderer/src/lib/webUi.test.mjs src/renderer/src/lib/webBridge.ts src/renderer/src/lib/webBridge.test.mjs src/renderer/src/main.tsx
git commit -m "feat: browser adapter for window.api" -m "Outside Electron the interface gets the same LmcApi, backed by POST /api/<channel> and a reconnecting WebSocket. Chats this tab was following are marked 'Stopped: connection lost' if the Mac no longer knows the tab. Desktop-only features use browser substitutes."
```

---

### Task 13: Browser-only interface pieces

**Files:**
- Create: `src/renderer/src/components/web/WebStatusBar.tsx`, `src/renderer/src/components/web/FolderPickerHost.tsx`, `src/renderer/src/components/web/WebChrome.tsx`
- Modify: `src/renderer/src/App.tsx` (final returns), `src/renderer/src/pages/CanvasPage.tsx` (browser-panel button and panel)

**Interfaces:**
- Consumes: `isBrowser` (Task 12); `useWebUiStore`, `registerFolderPicker`, `parseDirListing`, `DirListing` (Task 12).
- Produces: `WebChrome` (mounted only in browsers).

The behaviour these components render (connection state, notices, the folder-picker slot, listing parsing) is already pinned by Task 12's tests. This task adds no new logic, so its gate is typecheck plus a run in a real browser.

- [ ] **Step 1: Create `src/renderer/src/components/web/WebStatusBar.tsx`**

```tsx
import { useWebUiStore } from "@/lib/webUi";

const BANNER_TEXT = {
  connecting: "Connecting to your Mac…",
  reconnecting: "Lost connection to your Mac. Reconnecting…",
} as const;

export function WebStatusBar() {
  const connection = useWebUiStore((s) => s.connection);
  const notice = useWebUiStore((s) => s.notice);
  const banner = connection === "connected" ? null : BANNER_TEXT[connection];
  if (!banner && !notice) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2">
      {banner && (
        <div className="rounded-md border border-amber-500/40 bg-card px-3 py-1.5 text-xs text-amber-600 shadow-lg dark:text-amber-400">
          {banner}
        </div>
      )}
      {notice && (
        <div className="max-w-[90vw] truncate rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground shadow-lg">
          {notice}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/renderer/src/components/web/FolderPickerHost.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { ChevronUp, Folder } from "lucide-react";
import { parseDirListing, registerFolderPicker, type DirListing } from "@/lib/webUi";

type PendingPick = { resolve: (value: string | null) => void; start?: string };

export function FolderPickerHost() {
  const [pending, setPending] = useState<PendingPick | null>(null);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      registerFolderPicker(
        (start) => new Promise<string | null>((resolve) => setPending({ resolve, start })),
      ),
    [],
  );

  const load = useCallback(async (path?: string): Promise<void> => {
    setError(null);
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    const response = await fetch(`/api/fs/dirs${query}`, { credentials: "same-origin" });
    const parsed = parseDirListing(await response.json().catch(() => null));
    if (parsed) return setListing(parsed);
    if (path) return load();
    setError("Couldn't open that folder.");
  }, []);

  useEffect(() => {
    if (pending) void load(pending.start);
  }, [pending, load]);

  if (!pending) return null;

  const finish = (value: string | null): void => {
    pending.resolve(value);
    setPending(null);
    setListing(null);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/60">
      <div className="flex max-h-[80vh] w-[min(28rem,92vw)] flex-col rounded-lg border border-border bg-card shadow-lg">
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-medium text-foreground">Choose a folder on your Mac</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{listing?.path ?? "Loading…"}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {listing?.parent && (
            <button
              type="button"
              onClick={() => void load(listing.parent ?? undefined)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              <ChevronUp className="h-3.5 w-3.5" /> Up
            </button>
          )}
          {listing?.dirs.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => void load(`${listing.path}/${name}`)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
            >
              <Folder className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate">{name}</span>
            </button>
          ))}
          {listing && listing.dirs.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No folders here.</p>
          )}
          {error && <p className="px-2 py-1.5 text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={() => finish(null)}
            className="cursor-pointer rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!listing}
            onClick={() => listing && finish(listing.path)}
            className="cursor-pointer rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-card hover:opacity-90 disabled:opacity-50"
          >
            Choose this folder
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `src/renderer/src/components/web/WebChrome.tsx`**

```tsx
import { FolderPickerHost } from "./FolderPickerHost";
import { WebStatusBar } from "./WebStatusBar";

export function WebChrome() {
  return (
    <>
      <FolderPickerHost />
      <WebStatusBar />
    </>
  );
}
```

- [ ] **Step 4: Mount it and hide the desktop-only browser panel**

In `src/renderer/src/App.tsx`, import `{ isBrowser }` from `@/lib/webBridge` and `{ WebChrome }` from `@/components/web/WebChrome`, then replace the three final lines

```tsx
  if (route.name === "canvas") return <CanvasPage ids={route.ids} />;
  if (route.name === "onboarding") return <OnboardingPage />;
  return <HomePage />;
```

with

```tsx
  const page =
    route.name === "canvas" ? (
      <CanvasPage ids={route.ids} />
    ) : route.name === "onboarding" ? (
      <OnboardingPage />
    ) : (
      <HomePage />
    );
  return (
    <>
      {page}
      {isBrowser && <WebChrome />}
    </>
  );
```

In `src/renderer/src/pages/CanvasPage.tsx`, import `{ isBrowser }` from `@/lib/webBridge`. Then:
1. Wrap the browser-panel toggle `<button onClick={toggleBrowser} …>…</button>` (line ~108) in `{!isBrowser && ( … )}`.
2. Change the right-drawer fallback `<BrowserPanel rightOffset={timelineOffset} />` (line ~167) to `isBrowser ? null : <BrowserPanel rightOffset={timelineOffset} />`.

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run build`
Expected: clean; `✓ built`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/web src/renderer/src/App.tsx src/renderer/src/pages/CanvasPage.tsx
git commit -m "feat: connection banner, folder picker and notices in the browser" -m "Browsers get a 'Lost connection to your Mac' banner, an in-app folder browser limited to the Mac's home folder, and short notices (path copied, sign in on the Mac). The Electron-only web panel is hidden."
```

---

### Task 14: Settings → Browser access

**Files:**
- Create: `src/renderer/src/lib/browserAccessText.ts`, `src/renderer/src/lib/browserAccessText.test.mjs`
- Create: `src/renderer/src/components/settings/BrowserAccessSection.tsx`
- Modify: `src/renderer/src/components/SettingsModal.tsx`

**Interfaces:**
- Consumes: `window.api.web` (Task 11), `BrowserAccessStatus`/`PairingLink` (Task 11), `Toggle` (existing: `{ enabled, onToggle, label, description, icon, disabled? }`), `isBrowser` (Task 12).
- Produces: `statusLine(status): string`; `formatExpiry(expiresAt, now): string`; `formatLastSeen(lastSeenAt, now): string`; `BrowserAccessSection` (desktop only).

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/browserAccessText.test.mjs`:

```js
// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { formatExpiry, formatLastSeen, statusLine } from "./browserAccessText.ts";

const base = { enabled: false, running: false, keepAwake: true, url: null, problem: null, devices: [] };

describe("statusLine", () => {
  test.each([
    [{ ...base, enabled: true, running: true, url: "https://my-mac.tail1234.ts.net" }, "On at https://my-mac.tail1234.ts.net"],
    [{ ...base, problem: "Tailscale isn't running." }, "Tailscale isn't running."],
    [{ ...base, enabled: true }, "On, but not running yet."],
    [base, "Off. Only this Mac can use LMCanvas."],
  ])("%o", (status, line) => {
    expect(statusLine(status)).toBe(line);
  });
});

describe("formatExpiry", () => {
  test("counts down in whole minutes", () => {
    expect(formatExpiry(600_000, 0)).toBe("Expires in 10 min");
    expect(formatExpiry(60_000, 30_000)).toBe("Expires in 1 min");
    expect(formatExpiry(1_000, 2_000)).toBe("Expired. Create a new link.");
  });
});

describe("formatLastSeen", () => {
  test("describes recency", () => {
    expect(formatLastSeen(0, 30_000)).toBe("Active now");
    expect(formatLastSeen(0, 3 * 3_600_000)).toBe("Last seen 3 h ago");
    expect(formatLastSeen(0, 2 * 86_400_000)).toBe("Last seen 2 days ago");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/renderer/src/lib/browserAccessText.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/renderer/src/lib/browserAccessText.ts`**

```ts
import type { BrowserAccessStatus } from "@shared/ipc";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function statusLine(status: BrowserAccessStatus): string {
  if (status.running && status.url) return `On at ${status.url}`;
  if (status.problem) return status.problem;
  if (status.enabled) return "On, but not running yet.";
  return "Off. Only this Mac can use LMCanvas.";
}

export function formatExpiry(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "Expired. Create a new link.";
  return `Expires in ${Math.max(1, Math.round(remaining / MINUTE_MS))} min`;
}

export function formatLastSeen(lastSeenAt: number, now: number): string {
  const elapsed = now - lastSeenAt;
  if (elapsed < MINUTE_MS) return "Active now";
  if (elapsed < HOUR_MS) return `Last seen ${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `Last seen ${Math.floor(elapsed / HOUR_MS)} h ago`;
  return `Last seen ${Math.floor(elapsed / DAY_MS)} days ago`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/renderer/src/lib/browserAccessText.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Create `src/renderer/src/components/settings/BrowserAccessSection.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { Globe, Moon } from "lucide-react";
import type { BrowserAccessStatus, PairingLink } from "@shared/ipc";
import { formatExpiry, formatLastSeen, statusLine } from "@/lib/browserAccessText";
import { Toggle } from "./Toggle";

const CLOCK_TICK_MS = 15_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function BrowserAccessSection() {
  const [status, setStatus] = useState<BrowserAccessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingLink | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    window.api.web.status().then(setStatus).catch((e: unknown) => setError(messageOf(e)));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const run = useCallback(async (action: () => Promise<BrowserAccessStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (e: unknown) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const createLink = async (): Promise<void> => {
    setError(null);
    try {
      setPairing(await window.api.web.createPairingLink());
      setNow(Date.now());
    } catch (e: unknown) {
      setError(messageOf(e));
    }
  };

  if (!status) return null;

  return (
    <div className="pt-2 mt-1 border-t border-border">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        browser access
      </h3>
      <div className="flex flex-col gap-2">
        <Toggle
          enabled={status.enabled}
          disabled={busy}
          onToggle={() => void run(() => window.api.web.setEnabled(!status.enabled))}
          label="Browser access over Tailscale"
          description={statusLine(status)}
          icon={<Globe className="h-4 w-4" />}
        />
        <Toggle
          enabled={status.keepAwake}
          disabled={busy}
          onToggle={() => void run(() => window.api.web.setKeepAwake(!status.keepAwake))}
          label="Keep Mac awake"
          description="While browser access is on. Closing the lid still sleeps the Mac unless it's on power with an external display."
          icon={<Moon className="h-4 w-4" />}
        />

        {status.running && (
          <div className="rounded-md border border-border p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">Pair a device</span>
              <button
                type="button"
                onClick={() => void createLink()}
                className="cursor-pointer rounded-md bg-foreground px-2.5 py-1 text-[11px] font-semibold text-card hover:opacity-90"
              >
                {pairing ? "New link" : "Create link"}
              </button>
            </div>
            {pairing && (
              <div className="mt-2 flex flex-col gap-1.5">
                <code className="break-all rounded bg-muted px-2 py-1 text-[11px]">{pairing.url}</code>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{formatExpiry(pairing.expiresAt, now)}. Open it once on the device you want to pair.</span>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(pairing.url)}
                    className="cursor-pointer rounded-md px-2 py-0.5 hover:bg-muted"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {status.devices.length > 0 && (
          <div className="rounded-md border border-border p-3 text-xs">
            <p className="mb-1.5 font-medium text-foreground">Paired devices</p>
            {status.devices.map((device) => (
              <div key={device.id} className="flex items-center justify-between gap-2 py-1">
                <span className="text-foreground">
                  {device.label}
                  <span className="ml-2 text-muted-foreground">{formatLastSeen(device.lastSeenAt, now)}</span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => window.api.web.removeDevice(device.id))}
                  className="cursor-pointer rounded-md px-2 py-0.5 text-destructive hover:bg-muted disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Add the section to Settings (desktop only)**

In `src/renderer/src/components/SettingsModal.tsx`, import `{ BrowserAccessSection }` from `./settings/BrowserAccessSection` and `{ isBrowser }` from `@/lib/webBridge`. Directly before the `<div className="pt-2 mt-1 border-t border-border">` that contains the `preferences` heading (line ~176), add:

```tsx
              {!isBrowser && <BrowserAccessSection />}
```

- [ ] **Step 7: Verify**

Run: `bun test src/renderer/src/lib/browserAccessText.test.mjs && bun run typecheck && bun run build`
Expected: pass; clean; `✓ built`.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/lib/browserAccessText.ts src/renderer/src/lib/browserAccessText.test.mjs src/renderer/src/components/settings/BrowserAccessSection.tsx src/renderer/src/components/SettingsModal.tsx
git commit -m "feat: Browser access section in Settings" -m "Desktop-only controls: on/off with the exact reason it can't start, keep-awake, one-time pairing links with a countdown, and the paired-device list with Remove."
```

---

### Task 15: Build, install, and verify end to end

**Files:** none (verification only)

- [ ] **Step 1: Run every test file and the typecheck**

Run each file on its own (the settings test redirects HOME):

```bash
cd ~/projects/local-lmcanvas
for f in $(git ls-files '*.test.mjs'); do bun test "$f" >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"; done
bun run typecheck
```

Expected: every line `PASS`; typecheck clean.

- [ ] **Step 2: Build, sign and install**

```bash
rm -rf dist out && bun run build
bunx electron-builder --mac dir --arm64 --publish never -c.mac.notarize=false -c.mac.identity=null
codesign --force --deep --sign - --options runtime --entitlements build/entitlements.mac.plist dist/mac-arm64/LMCanvas.app
codesign --verify --deep --strict dist/mac-arm64/LMCanvas.app
osascript -e 'tell application "LMCanvas" to quit'; sleep 3
rm -rf /Applications/LMCanvas.app && ditto dist/mac-arm64/LMCanvas.app /Applications/LMCanvas.app && open -a /Applications/LMCanvas.app
```

Expected: signature verifies; the app opens. Before quitting, check that no chat is running (`ps` shows no `claude` child of LMCanvas).

- [ ] **Step 3: Regression check with Browser access off**

Send a prompt in the desktop app (Opus 5.5, Default effort) and expect a normal reply. Then run `lsof -nP -iTCP:4317 -sTCP:LISTEN` and `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status`. Expected: nothing listening on port 4317 and `No serve config`.

- [ ] **Step 4: Turn on Browser access**

Settings → Browser access → toggle on. Expected: "On at https://<host>.ts.net". `serve status` now shows the mapping to `http://127.0.0.1:4317`, and nothing mentions Funnel.

- [ ] **Step 5: Pair and use from another computer (with the user)**

On the Windows or Linux machine (both in the tailnet):
1. Open `https://<host>.ts.net`. Expected: "This device isn't paired yet".
2. On the Mac: Settings → Pair a device → Create link; open the link on the other machine. Expected: the app loads, and the device appears under Paired devices.
3. Run a prompt. Expected: streaming reply; PLAN mode works.
4. Pick a folder with the folder badge. Expected: the in-app folder browser lists home folders.
5. Open the same chat on the Mac. Expected: the "open elsewhere — Take over?" prompt, and taking over makes the other side read-only.
6. Turn Wi-Fi off on the other machine for ~20 s mid-reply, then back on. Expected: the reconnect banner, then the missed output appears.
7. Remove the device on the Mac. Expected: the other machine loses access at once and shows the pairing page on reload.

- [ ] **Step 6: Turn it off and confirm cleanup**

Toggle Browser access off. Expected: `serve status` shows `No serve config` and nothing listens on port 4317. Quit the app with it on, relaunch, and confirm it comes back on by itself.

- [ ] **Step 7: Record results**

Report each step's result to the user, including anything that failed. Commit nothing further unless a fix was needed (each fix gets its own commit).
