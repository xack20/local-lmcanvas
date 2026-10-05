import { app, BrowserWindow, ipcMain, Menu, MenuItem, nativeImage, powerSaveBlocker, shell, dialog } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
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
import { createClaudeModelCatalog } from "./claude/models";
import { loadModelWindows, type ModelWindows } from "./claude/modelWindows";
import { compactFocus, runCompaction } from "./claude/compaction";
import { estimateTokens, fittedPrompt, planReplay, shrinkingReplayBudgets, trimToFit } from "./claude/replayFit";
import { summarizeForReplay } from "./claude/replaySummary";
import { isPromptTooLongEvent, overflowRetryTarget } from "./claude/overflowRetry";
import { DEFAULT_SETUP_TOKENS, DEFAULT_WINDOW } from "@shared/contextSize";
import { claudeExecutable } from "./claude/runner";
import { claudeEffortFor, claudeModelArg, resolveClaudeRun } from "@shared/claudeModels";
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
  CompactArgs,
  CompactResult,
  GenerateCanvasNameRequest,
  PersistentProcessStartArgs,
  FileEntry,
  GenerateGroupSummaryRequest,
  SlashItem,
} from "@shared/ipc";
import type { AppSettings, Canvas, Provider, ProviderSessionRef, ReasoningEffort } from "@shared/types";
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
// Context windows seen per model (filled from each run's measurement), for sizing replays.
let modelWindows: ModelWindows | null = null;
const claudeModels = createClaudeModelCatalog({ executableFor: claudeExecutable });
// How long a chat start waits for the (normally cached) Claude model list before running anyway.
const CLAUDE_MODEL_LIST_BUDGET_MS = 2_000;

function claudeBinPathOf(settings: AppSettings): string | undefined {
  return settings.providers?.claude?.binPath ?? settings.claudeBinPath;
}

/** Settings' Claude model as a safe `--model` value (empty means Claude Code's default). */
function settingsClaudeModelArg(settings: AppSettings): string | undefined {
  return claudeModelArg(settings.providers?.claude?.model ?? settings.claudeModel);
}
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
    // Every chat ends with exactly one `done` (the renderer settles on it). An attempt that
    // overflowed swallows its own, so a stop at that moment would otherwise leave the reply open.
    let doneSent = false;
    const send = (ev: ChatEvent) => {
      if (ev.type === "done") doneSent = true;
      client.send("chat:event", ev);
    };

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
    const requestedEffort = nodeSettings?.reasoningEffort ?? providerCfg?.reasoningEffort;
    const serviceTier = nodeSettings?.serviceTier ?? providerCfg?.serviceTier;
    const compatibleParentSession =
      parentSession?.provider === provider ? parentSession : undefined;
    const compatibleCurrentSession =
      currentSession?.provider === provider ? currentSession : undefined;
    let agentPrompt =
      compatibleCurrentSession || compatibleParentSession ? prompt : combinedPrompt;

    // Effective cwd: node override → canvas → user home (least-invasive fallback so
    // every provider runner — which require a string cwd — always has one).
    const effectiveCwd = nodeSettings?.cwd ?? canvas.cwd ?? homedir();

    // Plan mode resolves as: one-shot inline /plan OR persistent node setting.
    // Claude-only — codex/cursor runners ignore the flag.
    const planMode = Boolean(inlinePlanMode) || Boolean(nodeSettings?.planMode);
    const chatOnly = Boolean(inlineChatOnly) || Boolean(nodeSettings?.chatOnly);

    // The client may have gone while the canvas and settings were read; its onGone
    // cleanup has already run, so a run started now would never be stopped.
    if (client.isGone()) return;
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
        case "compacting":
          send({ chatId, type: "compacting", active: ev.active, ...(ev.error ? { error: ev.error } : {}) });
          return;
        case "compacted":
          send({
            chatId,
            type: "compacted",
            trigger: ev.trigger,
            before: ev.before,
            after: ev.after,
            ...(ev.method ? { method: ev.method } : {}),
          });
          return;
        case "context":
          void modelWindows?.learn(ev.context.model, ev.context.window).catch((error: unknown) =>
            console.warn("[context] couldn't save the model window:", error),
          );
          send({ chatId, type: "context", context: ev.context });
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

    // Set once an overflowed session was compacted: the retry resumes it with the bare prompt.
    let retrySession: ProviderSessionRef | undefined;
    const runAttempt = async (
      attemptModel: string | undefined,
      reasoningEffort: ReasoningEffort | undefined,
      allowPolicyFallback: boolean,
      allowOverflowRetry: boolean,
    ): Promise<{ policyRefused: boolean; overflowed: boolean }> => {
      const attemptController = new AbortController();
      const abortAttempt = () => attemptController.abort(controller.signal.reason);
      if (controller.signal.aborted) abortAttempt();
      else controller.signal.addEventListener("abort", abortAttempt, { once: true });

      let policyRefused = false;
      let overflowed = false;
      try {
        await runAgent(provider, retrySession ? prompt : agentPrompt, {
          cwd: effectiveCwd,
          model: attemptModel,
          reasoningEffort,
          serviceTier,
          parentSession: retrySession ? undefined : compatibleParentSession,
          currentSession: retrySession ?? compatibleCurrentSession,
          binPath,
          systemPrompt,
          attachments,
          signal: attemptController.signal,
          planMode,
          chatOnly,
          client,
          nodeId,
          onEvent: (ev) => {
            // An attempt being retried says nothing more, not even its final `done`.
            if (policyRefused || overflowed) return;
            if (allowOverflowRetry && isPromptTooLongEvent(ev)) {
              overflowed = true;
              attemptController.abort(new Error("Compacting the session and retrying."));
              return;
            }
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
      return { policyRefused, overflowed };
    };

    try {
      // Resolved only now that the chat is registered, so Stop works while the model list loads.
      // The list is warmed at launch; a slow read gets a short budget and the chat runs without it.
      const listedModels =
        provider === "claude"
          ? await claudeModels.modelsWithin(binPath, CLAUDE_MODEL_LIST_BUDGET_MS, controller.signal)
          : null;
      const claudeRun =
        provider === "claude"
          ? resolveClaudeRun({
              nodeModel: nodeSettings?.model,
              settingsModel: providerCfg?.model,
              legacyModel: settings.claudeModel,
              requestedEffort,
              models: listedModels,
            })
          : undefined;
      const model = claudeRun ? claudeRun.model : providerCfg?.model;
      const runModel = claudeRun?.resolvedModel ?? model;

      // Never fail on replay: a branch replayed without a Claude session is fitted to the window.
      if (provider === "claude" && !compatibleCurrentSession && !compatibleParentSession) {
        const window = modelWindows?.windowFor(claudeRun?.resolvedModel) ?? DEFAULT_WINDOW;
        const plan = planReplay({ history, newPrompt: prompt, window, setupTokens: DEFAULT_SETUP_TOKENS });
        if (!plan.fits) {
          send({ chatId, type: "compacting", active: true });
          try {
            const summary = await summarizeForReplay(plan.olderText, {
              executable: claudeExecutable(binPath),
              model: claudeRun?.model,
              cwd: effectiveCwd,
              window,
              signal: controller.signal,
            });
            agentPrompt = fittedPrompt(summary, plan.recent, prompt);
            send({
              chatId,
              type: "compacted",
              trigger: "replay",
              method: "summary",
              before: plan.estimate,
              after: estimateTokens(agentPrompt) + DEFAULT_SETUP_TOKENS,
            });
          } catch (error) {
            if (controller.signal.aborted) {
              // Stopped while summarizing: the run below ends as any stopped chat does.
              send({ chatId, type: "compacting", active: false });
            } else {
              console.warn("[context] replay summary failed; trimming instead:", error);
              agentPrompt = trimToFit(history, prompt, plan.budget);
              send({ chatId, type: "compacted", trigger: "replay", method: "trimmed", before: null, after: null });
            }
          }
        }
      }
      const firstAttempt = await runAttempt(
        model,
        claudeRun ? claudeRun.reasoningEffort : requestedEffort,
        provider === "claude" && isFableModel(runModel),
        provider === "claude",
      );
      if (firstAttempt.policyRefused && !controller.signal.aborted) {
        send({
          chatId,
          type: "model_fallback",
          fromModel: runModel ?? "claude-fable-5",
          toModel: CLAUDE_FABLE_POLICY_FALLBACK_MODEL,
          reason: "policy_refusal",
        });
        console.info("[lmcanvas:latency]", {
          chatId,
          provider,
          phase: "model_fallback",
          fromModel: runModel ?? "claude-fable-5",
          toModel: CLAUDE_FABLE_POLICY_FALLBACK_MODEL,
          elapsedMs: Date.now() - startedAt,
        });
        await runAttempt(
          CLAUDE_FABLE_POLICY_FALLBACK_MODEL,
          claudeEffortFor(listedModels, CLAUDE_FABLE_POLICY_FALLBACK_MODEL, requestedEffort),
          false,
          false,
        );
      }
      // Never fail on overflow: compact the session (or a fork of the parent's) once, then retry.
      if (firstAttempt.overflowed && !controller.signal.aborted) {
        const target = overflowRetryTarget({ current: compatibleCurrentSession, parent: compatibleParentSession });
        if (!target) {
          // A replay the estimate thought would fit (dense text runs past 4 characters a token):
          // leave out more of the oldest messages until it fits.
          const window = modelWindows?.windowFor(claudeRun?.resolvedModel) ?? DEFAULT_WINDOW;
          send({ chatId, type: "compacted", trigger: "replay", method: "trimmed", before: null, after: null });
          let stillOverflowing = true;
          for (const budget of shrinkingReplayBudgets(window, DEFAULT_SETUP_TOKENS)) {
            if (controller.signal.aborted) break;
            agentPrompt = trimToFit(history, prompt, budget);
            const retry = await runAttempt(model, claudeRun ? claudeRun.reasoningEffort : requestedEffort, false, true);
            stillOverflowing = retry.overflowed;
            if (!stillOverflowing) break;
          }
          if (stillOverflowing && !controller.signal.aborted) {
            throw new Error("This conversation is too long for the model, even with its earlier messages left out.");
          }
          return;
        }
        send({ chatId, type: "compacting", active: true });
        try {
          const compacted = await runCompaction({
            executable: claudeExecutable(binPath),
            sessionId: target.sessionId,
            fork: target.fork,
            model: claudeRun?.model,
            cwd: effectiveCwd,
            signal: controller.signal,
          });
          send({ chatId, type: "compacted", trigger: "auto", before: compacted.before, after: compacted.after });
          retrySession = { provider: "claude", id: compacted.sessionId };
          // The node adopts the compacted session now: a stopped retry never reports it itself.
          send({ chatId, type: "session", session: retrySession });
        } catch (error) {
          if (!controller.signal.aborted) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`This conversation is too long for the model, and compacting it failed: ${reason}`);
          }
          // Stopped while compacting: the run below ends as any stopped chat does.
          send({ chatId, type: "compacting", active: false });
        }
        await runAttempt(model, claudeRun ? claudeRun.reasoningEffort : requestedEffort, false, false);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      send({ chatId, type: "error", message, provider });
      send({ chatId, type: "done", isError: true, provider });
    } finally {
      activeChats.finish(chatId);
      if (!doneSent) send({ chatId, type: "done", isError: false, provider });
    }
  }, "shared");

  api.handle("chat:cancel", async (client, chatId: string) => {
    activeChats.abort(chatId);
    cancelAllForClient(client);
  }, "shared");

  api.handle("chat:cancelForNode", async (_client, nodeId: string) => {
    activeChats.abortForNode(nodeId);
  }, "shared");

  api.handle(
    "chat:compact",
    async (client, args: CompactArgs): Promise<CompactResult> => {
      if (!canvasLocks.canWrite(args.canvasId, client)) throw new Error(CANVAS_LOCKED_MESSAGE);
      const session = args.session;
      if (session?.provider !== "claude" || typeof session.id !== "string" || session.id.length === 0) {
        throw new Error("This node has no Claude session to compact.");
      }
      // Tracked like a chat: Stop (chat:cancel / chat:cancelForNode), quitting, a closing tab and a
      // lock takeover all see it and can stop it.
      const chatId = typeof args.chatId === "string" && args.chatId.length > 0 ? args.chatId : `compact-${randomUUID()}`;
      const controller = new AbortController();
      activeChats.add(chatId, { controller, nodeId: args.nodeId, canvasId: args.canvasId, client });
      try {
        const settings = await readSettings();
        const binPath = claudeBinPathOf(settings);
        const run = resolveClaudeRun({
          nodeModel: args.model,
          settingsModel: settings.providers?.claude?.model,
          legacyModel: settings.claudeModel,
          models: await claudeModels.modelsWithin(binPath, CLAUDE_MODEL_LIST_BUDGET_MS, controller.signal),
        });
        const result = await runCompaction({
          executable: claudeExecutable(binPath),
          sessionId: session.id,
          fork: args.mode === "summaryNode",
          focus: compactFocus(args.focus),
          model: run.model,
          cwd: typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : homedir(),
          signal: controller.signal,
        });
        if (result.context) void modelWindows?.learn(result.context.model, result.context.window).catch(() => undefined);
        return result;
      } finally {
        activeChats.finish(chatId);
      }
    },
    "shared",
  );

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

  api.handle("providers:claudeModels", async () => {
    const settings = await readSettings();
    return claudeModels.list(claudeBinPathOf(settings));
  }, "shared");

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
      const model = settingsClaudeModelArg(settings);
      const binPath = claudeBinPathOf(settings);
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
      const model = settingsClaudeModelArg(settings);
      const binPath = claudeBinPathOf(settings);
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

  modelWindows = await loadModelWindows(join(ROOT_DIR, "model-windows.json")).catch(() => null);
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

  // Read Claude Code's model list now so the first chat start doesn't wait for it.
  void readSettings()
    .then((settings) => claudeModels.list(claudeBinPathOf(settings)))
    .catch((error) => console.warn("[claude] model list prewarm skipped:", error));

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
