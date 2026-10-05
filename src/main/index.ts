import { app, BrowserWindow, ipcMain, Menu, MenuItem, nativeImage, powerSaveBlocker, shell, dialog } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  listCanvases,
  createCanvas,
  readCanvas,
  writeCanvas,
  deleteCanvas,
} from "./storage/canvases";
import { readSettings, writeBrowserAccess, writeSettings } from "./storage/settings";
import { ROOT_DIR } from "./storage/paths";
import { buildPromptWithHistory } from "./claude/history";
import { runAgent, type RunnerEvent } from "./agents";
import {
  getCodexRuntimeInfo,
  prewarmCodexAppServer,
  shutdownCodexAppServers,
} from "./agents/codexAppServer";
import { generateGroupSummaries } from "./groupSummary/generate";
import { generateCanvasName } from "./canvasName/generate";
import { getProviderAuthStatus, openLoginTerminal } from "./auth/providerAuth";
import { listFiles } from "./files";
import { listSlashItems } from "./slashItems";
import { startPersistentProcess, stopPersistentProcess } from "./processes";
import {
  cancelAllForClient,
  completeRequest as completeAskUser,
} from "./claude/askUserBridge";
import { createActiveChats } from "./api/activeChats";
import { desktopClient, type Client } from "./api/client";
import { bindRegistryToIpc, createApiRegistry } from "./api/registry";
import { createBrowserClientRegistry, tabIdOf } from "./web/browserClients";
import { createCanvasLocks } from "./web/canvasLocks";
import { loadDeviceStore } from "./web/devices";
import { createWebServer } from "./web/server";
import { createTailscale } from "./web/tailscale";
import { createWebService, isLocalPortFree, type WebService } from "./web/service";
import { getShellPath } from "./shellPath";
import { initAutoUpdate, checkForUpdatesNow } from "./autoUpdate";
import type {
  AskUserResponsePayload,
  ChatEvent,
  ChatStartArgs,
  CanvasCreateArgs,
  GenerateCanvasNameRequest,
  PersistentProcessStartArgs,
  FileEntry,
  GenerateGroupSummaryRequest,
  SlashItem,
} from "@shared/ipc";
import type { AppSettings, Canvas, Provider } from "@shared/types";
import { CANVAS_LOCKED_MESSAGE } from "@shared/canvasLock";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dev: __dirname is .../out/main → ../../resources is the project resources/.
// Packaged: electron-builder copies resources/ to process.resourcesPath/resources.
const APP_ICON_PATH = app.isPackaged
  ? join(process.resourcesPath, "resources/icon.png")
  : join(__dirname, "../../resources/icon.png");

function createWindow(hash?: string): BrowserWindow {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 360,
    minHeight: 480,
    title: "LMCanvas",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#fafafa",
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  if (process.platform === "darwin" && app.dock && !icon.isEmpty()) {
    app.dock.setIcon(icon);
  }

  win.on("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  const suffix = hash ? `#${hash.replace(/^#/, "")}` : "";
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void win.loadURL(devUrl + suffix);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"), {
      hash: hash?.replace(/^#/, ""),
    });
  }

  return win;
}

const activeChats = createActiveChats();
const canvasLocks = createCanvasLocks({
  isReplyRunning: (holder, canvasId) => activeChats.hasForClientOnCanvas(holder, canvasId),
  stopReplies: (holder, canvasId) => activeChats.abortForClientOnCanvas(holder, canvasId),
});
const watchedClients = new WeakSet<Client>();
const api = createApiRegistry();

function watchClient(client: Client): Client {
  if (watchedClients.has(client)) return client;
  watchedClients.add(client);
  client.onGone(() => {
    activeChats.abortForClient(client);
    cancelAllForClient(client);
    canvasLocks.releaseAll(client);
  });
  return client;
}

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

// Browser access is optional: if it can't be set up, the desktop app still
// starts and just has no web:* channels.
async function setUpBrowserAccess(): Promise<WebService | null> {
  try {
    const service = await createBrowserAccess();
    registerWebChannels(service);
    return service;
  } catch (error) {
    console.warn("[web] browser access unavailable:", error);
    return null;
  }
}

const CLAUDE_FABLE_POLICY_FALLBACK_MODEL = "claude-opus-4-8";

function isFableModel(model: string | undefined): model is string {
  return model?.toLowerCase().includes("fable") === true;
}

function isPolicyRefusalEvent(event: RunnerEvent): boolean {
  return (
    (event.kind === "error" ||
      (event.kind === "done" && event.isError === true)) &&
    event.code === "policy_refusal"
  );
}

const TERSE_NARRATION_INSTRUCTION =
  "RESPONSE STYLE: Before each batch of tool calls (typically 1–5 parallel calls), write ONE very short action-form label as a single line — 3 to 8 words, MAX 10, gerund form. Examples: 'Reading the canvas store', 'Searching for tool handlers', 'Editing the badge component', 'Building the calculator UI'. Strict rules: (1) State ONLY the next action — never two sentences, never an acknowledgment followed by an action. (2) NEVER start with a reaction or judgment word: no 'Good', 'Great', 'Perfect', 'Nice', 'Cool', 'Awesome', 'Excellent', 'Got it', 'Done', 'OK', 'Okay', 'Alright', 'Hmm'. (3) NEVER describe what just happened or summarize a prior result — no 'X created.', 'X done.', 'X works.' Skip straight to the next action. (4) NEVER use first-person prefixes like 'I'll', 'Let me', 'I'm going to', 'Now I will'. (5) No trailing ellipsis. When you fire a long sequence of tool calls, insert a fresh action-form label every ~5 calls. Save longer prose for your final answer to the user.";

// Asks the model to usually end with a `<next-steps>` block listing 1–3
// follow-up prompts. The renderer strips this block from the visible text and
// renders each item as a clickable button that branches into a new child node.
const NEXT_STEPS_INSTRUCTION = `SUGGESTED NEXT STEPS: Default to ending most substantive responses with 1–3 proactive follow-up actions the user may want next, especially concrete things to build, refine, verify, compare, or explore. End your response with a block in this exact format:

<next-steps>
- Short label :: Full prompt the user could send as the next message
- Short label :: Full prompt the user could send as the next message
</next-steps>

Rules:
- Place the block at the very end of your response, after all other content. Nothing follows it.
- Each item is on its own line, starts with "- ", and uses " :: " (space-colon-colon-space) as the separator.
- Label is ≤6 words, sentence case, no trailing punctuation.
- Prompt is a complete, standalone instruction the user could send verbatim.
- Prefer at least 1 item whenever there is a plausible next build step, experiment, cleanup, verification step, or adjacent feature. It is okay if the suggestion is proactive rather than explicitly requested.
- Use 2–3 items when there are multiple useful directions, such as "build next", "improve UX", and "verify behavior".
- Omit the block only for tiny acknowledgments, direct factual answers with no useful follow-up, blocked/error responses where the next action is already stated in prose, or when every suggestion would be generic busywork.
- Never wrap the block in code fences or markdown. Never reference it in the prose above.`;

const PERSISTENT_PROCESS_INSTRUCTION = `LONG-RUNNING LOCAL PROCESSES: If the user asks you to start a dev server, watcher, preview server, or similar command that should remain available after your response completes, do not rely on a transient agent background job. Start it in a detached/nohup shell with output redirected to a log file, report the PID and log path, and verify the service over HTTP or with an equivalent health check when possible.`;

const FILES_CACHE_TTL_MS = 10_000;
const filesCache = new Map<string, { at: number; files: FileEntry[] }>();

const SLASH_CACHE_TTL_MS = 10_000;
const slashCache = new Map<string, { at: number; items: SlashItem[] }>();

function registerIpc(): void {
  api.handle("canvases:list", async () => listCanvases(), "shared");
  api.handle("canvases:create", async (_client, args: CanvasCreateArgs) => createCanvas(args), "shared");
  api.handle("canvases:read", async (_client, id: string) => readCanvas(id), "shared");
  api.handle(
    "canvases:write",
    async (client, canvas: Canvas) => {
      if (!canvasLocks.canWrite(canvas.id, client)) {
        throw new Error(CANVAS_LOCKED_MESSAGE);
      }
      return writeCanvas(canvas);
    },
    "shared",
  );
  api.handle(
    "canvasLock:acquire",
    async (client, canvasId: string) => canvasLocks.acquire(canvasId, client),
    "shared",
  );
  api.handle(
    "canvasLock:takeOver",
    async (client, canvasId: string) => {
      canvasLocks.takeOver(canvasId, client);
    },
    "shared",
  );
  api.handle(
    "canvasLock:release",
    async (client, canvasId: string) => {
      canvasLocks.release(canvasId, client);
    },
    "shared",
  );
  api.handle("canvases:delete", async (_client, id: string) => deleteCanvas(id), "shared");

  api.handle("settings:read", async () => readSettings(), "shared");
  api.handle("settings:write", async (_client, s: AppSettings) => writeSettings(s), "shared");

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

  api.handle(
    "shell:openPath",
    async (_client, path: string) => {
      await shell.openPath(path);
    },
    "desktop-only",
  );

  api.handle(
    "processes:start",
    async (_client, args: PersistentProcessStartArgs) => startPersistentProcess(args),
    "shared",
  );

  api.handle(
    "processes:stop",
    async (_client, id: string) => stopPersistentProcess(id),
    "shared",
  );

  api.handle("files:list", async (_client, cwd: string): Promise<FileEntry[]> => {
    if (!cwd) return [];
    const now = Date.now();
    const cached = filesCache.get(cwd);
    if (cached && now - cached.at < FILES_CACHE_TTL_MS) return cached.files;
    const files = await listFiles(cwd);
    filesCache.set(cwd, { at: now, files });
    return files;
  }, "shared");

  api.handle("slash:list", async (_client, cwd: string): Promise<SlashItem[]> => {
    const key = cwd ?? "";
    const now = Date.now();
    const cached = slashCache.get(key);
    if (cached && now - cached.at < SLASH_CACHE_TTL_MS) return cached.items;
    const items = await listSlashItems(key);
    slashCache.set(key, { at: now, items });
    return items;
  }, "shared");

  api.handle("chat:start", async (client, args: ChatStartArgs) => {
    const {
      chatId,
      nodeId,
      canvasId,
      history,
      prompt,
      attachments,
      systemPromptOverride,
      nodeSettings,
      planMode: inlinePlanMode,
      chatOnly: inlineChatOnly,
      parentSession,
      currentSession,
    } = args;
    const send = (ev: ChatEvent) => client.send("chat:event", ev);

    const canvas = await readCanvas(canvasId);
    if (!canvas) {
      send({ chatId, type: "error", message: `Canvas not found: ${canvasId}` });
      send({ chatId, type: "done", isError: true });
      return;
    }

    const settings = await readSettings();
    const combinedPrompt = buildPromptWithHistory(history, prompt);
    const basePrompt = systemPromptOverride ?? settings.systemPrompt ?? "";
    const withTerse = settings.terseToolNarration
      ? basePrompt
        ? `${basePrompt}\n\n${TERSE_NARRATION_INSTRUCTION}`
        : TERSE_NARRATION_INSTRUCTION
      : basePrompt;
    const builtInPrompt = `${PERSISTENT_PROCESS_INSTRUCTION}\n\n${NEXT_STEPS_INSTRUCTION}`;
    const systemPrompt = withTerse ? `${withTerse}\n\n${builtInPrompt}` : builtInPrompt;

    const provider: Provider =
      nodeSettings?.provider ?? canvas.provider ?? settings.defaultProvider ?? "claude";
    const providerCfg = settings.providers?.[provider];
    const binPath =
      providerCfg?.binPath ??
      (provider === "claude" ? settings.claudeBinPath : undefined);
    const model =
      providerCfg?.model ??
      (provider === "claude" ? settings.claudeModel : undefined);
    const reasoningEffort =
      nodeSettings?.reasoningEffort ?? providerCfg?.reasoningEffort;
    const serviceTier = nodeSettings?.serviceTier ?? providerCfg?.serviceTier;
    const compatibleParentSession =
      parentSession?.provider === provider ? parentSession : undefined;
    const compatibleCurrentSession =
      currentSession?.provider === provider ? currentSession : undefined;
    const agentPrompt =
      compatibleCurrentSession || compatibleParentSession ? prompt : combinedPrompt;

    // Effective cwd: node override → canvas → user home (least-invasive fallback so
    // every provider runner — which require a string cwd — always has one).
    const effectiveCwd = nodeSettings?.cwd ?? canvas.cwd ?? homedir();

    // Plan mode resolves as: one-shot inline /plan OR persistent node setting.
    // Claude-only — codex/cursor runners ignore the flag.
    const planMode = Boolean(inlinePlanMode) || Boolean(nodeSettings?.planMode);
    const chatOnly = Boolean(inlineChatOnly) || Boolean(nodeSettings?.chatOnly);

    const controller = new AbortController();
    activeChats.add(chatId, { controller, nodeId, canvasId, client });

    send({ chatId, type: "start" });
    const startedAt = Date.now();
    let firstProviderEventSeen = false;
    console.info("[lmcanvas:latency]", { chatId, provider, phase: "start", elapsedMs: 0 });

    const forwardEvent = (ev: RunnerEvent): void => {
      if (
        !firstProviderEventSeen &&
        (ev.kind === "text_delta" ||
          ev.kind === "thinking_delta" ||
          ev.kind === "tool_use")
      ) {
        firstProviderEventSeen = true;
        console.info("[lmcanvas:latency]", {
          chatId,
          provider,
          phase: "first_provider_event",
          elapsedMs: Date.now() - startedAt,
        });
      }
      switch (ev.kind) {
        case "session":
          send({ chatId, type: "session", session: ev.session });
          return;
        case "response_complete":
          send({ chatId, type: "response_complete" });
          return;
        case "text_delta":
          send({ chatId, type: "text_delta", text: ev.text });
          return;
        case "thinking_delta":
          send({ chatId, type: "thinking_delta", text: ev.text });
          return;
        case "model_fallback":
          send({
            chatId,
            type: "model_fallback",
            fromModel: ev.fromModel,
            toModel: ev.toModel,
            reason: ev.reason,
          });
          return;
        case "tool_use":
          send({
            chatId,
            type: "tool_use",
            toolUseId: ev.toolUseId,
            name: ev.name,
            input: ev.input,
          });
          return;
        case "tool_result":
          send({
            chatId,
            type: "tool_result",
            toolUseId: ev.toolUseId,
            content: ev.content,
            isError: ev.isError,
          });
          return;
        case "error":
          send({
            chatId,
            type: "error",
            message: ev.message,
            code: ev.code,
            provider,
          });
          return;
        case "done":
          console.info("[lmcanvas:latency]", {
            chatId,
            provider,
            phase: "done",
            elapsedMs: Date.now() - startedAt,
          });
          send({
            chatId,
            type: "done",
            isError: ev.isError,
            result: ev.result,
            code: ev.code,
            usage: ev.usage,
            provider: ev.isError ? provider : undefined,
          });
          return;
      }
    };

    const runAttempt = async (
      attemptModel: string | undefined,
      allowPolicyFallback: boolean,
    ): Promise<boolean> => {
      const attemptController = new AbortController();
      const abortAttempt = () => attemptController.abort(controller.signal.reason);
      if (controller.signal.aborted) abortAttempt();
      else controller.signal.addEventListener("abort", abortAttempt, { once: true });

      let policyRefused = false;
      try {
        await runAgent(provider, agentPrompt, {
          cwd: effectiveCwd,
          model: attemptModel,
          reasoningEffort,
          serviceTier,
          parentSession: compatibleParentSession,
          currentSession: compatibleCurrentSession,
          binPath,
          systemPrompt,
          attachments,
          signal: attemptController.signal,
          planMode,
          chatOnly,
          client,
          nodeId,
          onEvent: (ev) => {
            if (policyRefused) return;
            if (allowPolicyFallback && isPolicyRefusalEvent(ev)) {
              policyRefused = true;
              attemptController.abort(new Error("Retrying policy refusal with Opus 4.8."));
              return;
            }
            forwardEvent(ev);
          },
        });
      } finally {
        controller.signal.removeEventListener("abort", abortAttempt);
      }
      return policyRefused;
    };

    try {
      const policyRefused = await runAttempt(
        model,
        provider === "claude" && isFableModel(model),
      );
      if (policyRefused && !controller.signal.aborted) {
        send({
          chatId,
          type: "model_fallback",
          fromModel: model ?? "claude-fable-5",
          toModel: CLAUDE_FABLE_POLICY_FALLBACK_MODEL,
          reason: "policy_refusal",
        });
        console.info("[lmcanvas:latency]", {
          chatId,
          provider,
          phase: "model_fallback",
          fromModel: model ?? "claude-fable-5",
          toModel: CLAUDE_FABLE_POLICY_FALLBACK_MODEL,
          elapsedMs: Date.now() - startedAt,
        });
        await runAttempt(CLAUDE_FABLE_POLICY_FALLBACK_MODEL, false);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      send({ chatId, type: "error", message, provider });
      send({ chatId, type: "done", isError: true, provider });
    } finally {
      activeChats.finish(chatId);
    }
  }, "shared");

  api.handle("chat:cancel", async (client, chatId: string) => {
    activeChats.abort(chatId);
    cancelAllForClient(client);
  }, "shared");

  api.handle("chat:cancelForNode", async (_client, nodeId: string) => {
    activeChats.abortForNode(nodeId);
  }, "shared");

  // Browser adapter only (settles chats whose start request dropped); not part of LmcApi or the preload.
  api.handle("chat:isActive", async (_client, chatId: unknown) => typeof chatId === "string" && activeChats.has(chatId), "shared");

  // Browser adapter only: a tab whose page is closing or reloading frees its chats and locks now
  // instead of after the reconnect grace period. A desktop window has nothing to say goodbye with.
  api.handle(
    "client:bye",
    async (client) => {
      if (client.kind === "browser") browserClients.expire(tabIdOf(client));
    },
    "shared",
  );

  api.handle("askUser:respond", async (_client, payload: AskUserResponsePayload) => {
    completeAskUser(payload);
  }, "shared");

  api.handle("providers:authStatus", async (_client, provider: Provider) => {
    const settings = await readSettings();
    const binPath =
      settings.providers?.[provider]?.binPath ??
      (provider === "claude" ? settings.claudeBinPath : undefined);
    return getProviderAuthStatus(provider, binPath);
  }, "shared");

  api.handle(
    "providers:openLogin",
    async (_client, provider: Provider) => {
      const settings = await readSettings();
      const binPath =
        settings.providers?.[provider]?.binPath ??
        (provider === "claude" ? settings.claudeBinPath : undefined);
      await openLoginTerminal(provider, binPath);
    },
    "desktop-only",
  );

  api.handle("providers:codexRuntime", async () => {
    const settings = await readSettings();
    return getCodexRuntimeInfo(settings.providers?.codex?.binPath ?? "codex");
  }, "shared");

  api.handle(
    "window:openCanvas",
    async (_client, canvasId?: string) => {
      const hash = canvasId ? `/canvas/${canvasId}` : "/";
      createWindow(hash);
    },
    "desktop-only",
  );

  api.handle(
    "groupSummary:generate",
    async (_client, args: GenerateGroupSummaryRequest) => {
      const settings = await readSettings();
      const model =
        settings.providers?.claude?.model ?? settings.claudeModel ?? undefined;
      const binPath = settings.providers?.claude?.binPath ?? settings.claudeBinPath;
      try {
        return await generateGroupSummaries({
          candidates: args.candidates,
          existingGroupTitles: args.existingGroupTitles,
          model,
          binPath,
        });
      } catch (err) {
        console.error("[groupSummary:generate] failed:", err);
        return [];
      }
    },
    "shared",
  );

  api.handle(
    "canvasName:generate",
    async (_client, args: GenerateCanvasNameRequest) => {
      const settings = await readSettings();
      const model =
        settings.providers?.claude?.model ?? settings.claudeModel ?? undefined;
      const binPath = settings.providers?.claude?.binPath ?? settings.claudeBinPath;
      try {
        return await generateCanvasName({ prompt: args.prompt, model, binPath });
      } catch (err) {
        console.error("[canvasName:generate] failed:", err);
        return null;
      }
    },
    "shared",
  );
}

function installUpdateMenuItem(): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  // On macOS the app menu is index 0 ("LMCanvas" / Electron's default). Insert
  // "Check for Updates…" right after "About" so it sits where users expect.
  const appMenu = menu.items[0];
  const submenu = appMenu?.submenu;
  if (!submenu) return;
  const aboutIdx = submenu.items.findIndex((i) => i.role === "about");
  const insertAt = aboutIdx >= 0 ? aboutIdx + 1 : 0;
  submenu.insert(
    insertAt,
    new MenuItem({
      label: "Check for Updates…",
      click: () => checkForUpdatesNow(),
    }),
  );
  Menu.setApplicationMenu(menu);
}

// Subprocess stdin races (e.g. the Claude Agent SDK writing to its own child's
// stdin after we abort the controller) surface as async EPIPE errors with no
// catchable origin. Swallow those; rethrow anything else as a real crash.
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err?.code === "EPIPE") {
    console.warn("[main] swallowed EPIPE from subprocess stdin:", err.message);
    return;
  }
  console.error("[main] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  const err = reason as NodeJS.ErrnoException | undefined;
  if (err?.code === "EPIPE") {
    console.warn("[main] swallowed EPIPE rejection:", err.message);
    return;
  }
  console.error("[main] unhandledRejection:", reason);
});

app.whenReady().then(async () => {
  // macOS GUI apps inherit a minimal PATH that lacks /opt/homebrew/bin,
  // ~/.nvm/.../bin, ~/.local/bin etc. — resolve the user's shell PATH so
  // every spawned CLI (including the one inside claude-agent-sdk) can find
  // its binary.
  try {
    process.env.PATH = await getShellPath();
  } catch {
    // best-effort; fall through with whatever PATH we have
  }

  registerIpc();
  const webService = await setUpBrowserAccess();
  bindRegistryToIpc(api, ipcMain, (sender) => watchClient(desktopClient(sender)));
  activeWebService = webService;
  createWindow();
  initAutoUpdate();
  installUpdateMenuItem();
  void webService
    ?.startIfEnabled()
    .catch((error) => console.warn("[web] browser access not started:", error));

  void readSettings()
    .then((settings) =>
      prewarmCodexAppServer(settings.providers?.codex?.binPath ?? "codex"),
    )
    .catch((error) => console.warn("[codex] prewarm skipped:", error));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  // With browser access off there is nothing to tear down: quit exactly as before.
  if (activeWebService?.needsShutdown()) {
    // A second quit while this shutdown is in flight finds no service and quits
    // at once: a deliberate escape hatch, at the cost of possibly skipping teardown.
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
