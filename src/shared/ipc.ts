import type {
  AppSettings,
  Canvas,
  CanvasSummary,
  ClaudeModelList,
  CodexRuntimeInfo,
  CompactionTrigger,
  ContextSnapshot,
  ErrorCode,
  ImageMediaType,
  Message,
  ModelFallback,
  NodeSettings,
  Provider,
  ProviderSessionRef,
  UsageSummary,
} from "./types";

export type AskUserOption = {
  label: string;
  description: string;
  preview?: string;
  /** Provider-native value returned when it differs from the display label. */
  value?: string;
};

export type AskUserQuestion = {
  /** Stable provider question id; falls back to `question` for legacy callers. */
  id?: string;
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserOption[];
  allowFreeText?: boolean;
  secret?: boolean;
  /** Optional questions do not block submission when left unanswered. */
  required?: boolean;
};

export type AskUserRequest = {
  /** Correlates this request with the response. */
  id: string;
  /** The node that initiated the chat which triggered this question. */
  nodeId: string;
  questions: AskUserQuestion[];
};

/** Per-question answers. Single-select → string; multi-select → string[]. */
export type AskUserAnswers = Record<string, string | string[]>;

export type AskUserResponsePayload =
  | { id: string; cancelled: false; answers: AskUserAnswers; notes?: Record<string, string> }
  | { id: string; cancelled: true };


export type Attachment = {
  mediaType: ImageMediaType;
  base64: string;
};

export type FileEntry = {
  path: string;
  type: "file" | "dir";
};

export type SlashItemKind = "command" | "skill";
export type SlashItemSource = "user" | "project" | "plugin" | "builtin";

export type SlashItem = {
  kind: SlashItemKind;
  /** Name without the leading slash. Namespaced commands use `ns:name`. */
  name: string;
  /** One-line description from frontmatter (skills) or first paragraph (commands). */
  description: string;
  source: SlashItemSource;
};

export type ChatStartArgs = {
  chatId: string;
  /** The node initiating the chat — surfaced to the askUser flow so prompts render inline. */
  nodeId: string;
  canvasId: string;
  history: Message[];
  prompt: string;
  attachments?: Attachment[];
  systemPromptOverride?: string;
  /** Per-node run-setting overrides. Resolved against canvas/app defaults in main. */
  nodeSettings?: NodeSettings;
  /** One-shot plan-mode flag (from inline `/plan`). ORed with nodeSettings.planMode. */
  planMode?: boolean;
  /** One-shot chat-only flag (from inline `/chat`). ORed with nodeSettings.chatOnly. */
  chatOnly?: boolean;
  /** Native session belonging to this node's primary parent, when available. */
  parentSession?: ProviderSessionRef;
  /** Native session already owned by this node, when continuing it. */
  currentSession?: ProviderSessionRef;
};

export type CompactArgs = {
  /** The renderer's id for this operation; Stop (chat:cancel / chat:cancelForNode) and quitting see it. */
  chatId?: string;
  canvasId: string;
  nodeId: string;
  mode: "inPlace" | "summaryNode";
  focus?: string;
  session: ProviderSessionRef;
  model?: string;
  cwd?: string;
};

export type CompactResult = {
  sessionId: string;
  before: number | null;
  after: number | null;
  summary: string | null;
  context: ContextSnapshot | null;
  /** The compaction call's own token use and cost. */
  usage?: UsageSummary;
};

export type ChatEvent =
  | { chatId: string; type: "start" }
  | { chatId: string; type: "response_complete" }
  | ({ chatId: string; type: "model_fallback" } & ModelFallback)
  | { chatId: string; type: "session"; session: ProviderSessionRef }
  | { chatId: string; type: "text_delta"; text: string }
  | {
      chatId: string;
      type: "tool_use";
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      chatId: string;
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
    }
  | { chatId: string; type: "thinking_delta"; text: string }
  | { chatId: string; type: "compacting"; active: boolean; error?: string }
  | {
      chatId: string;
      type: "compacted";
      trigger: CompactionTrigger;
      before: number | null;
      after: number | null;
      method?: "summary" | "trimmed";
    }
  | { chatId: string; type: "context"; context: ContextSnapshot }
  | {
      chatId: string;
      type: "done";
      isError?: boolean;
      result?: string;
      code?: ErrorCode;
      provider?: Provider;
      usage?: UsageSummary;
    }
  | {
      chatId: string;
      type: "error";
      message: string;
      code?: ErrorCode;
      provider?: Provider;
    };

export type CanvasCreateArgs = {
  name?: string;
  cwd?: string;
  provider?: Provider;
};

export type GroupSummaryCandidateIpc = {
  nodeId: string;
  prompt: string;
};

export type GeneratedGroupSummaryIpc = {
  title: string;
  nodeIds: string[];
  metadata?: {
    confidence?: number;
    promptVersion?: string;
    generationModel?: string;
  };
};

export type GenerateGroupSummaryRequest = {
  candidates: GroupSummaryCandidateIpc[];
  existingGroupTitles?: string[];
};

export type GenerateCanvasNameRequest = {
  prompt: string;
};

export type PersistentProcessStartArgs = {
  command: string;
  cwd?: string;
};

export type PersistentProcessStartResult = {
  id: string;
  pid: number;
  logPath: string;
};

export type PersistentProcessStopResult = {
  stopped: boolean;
  message?: string;
};

export type ProviderAuthStatus = {
  provider: Provider;
  installed: boolean;
  authenticated: boolean;
  binPath: string | null;
  /** Optional message — e.g. version string when ok, or error explanation when not. */
  detail?: string;
};

export type CanvasLockResult =
  | { ok: true }
  /** `replyRunning`: the holder has a reply running on this canvas, which taking over stops. */
  | { ok: false; holderKind: "desktop" | "browser"; replyRunning: boolean };
export type CanvasLockLostEvent = { canvasId: string };

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

export type LmcApi = {
  canvases: {
    list(): Promise<CanvasSummary[]>;
    create(args: CanvasCreateArgs): Promise<Canvas>;
    read(id: string): Promise<Canvas | null>;
    write(canvas: Canvas): Promise<void>;
    delete(id: string): Promise<void>;
  };
  settings: {
    read(): Promise<AppSettings>;
    write(s: AppSettings): Promise<AppSettings>;
  };
  chat: {
    start(args: ChatStartArgs): Promise<void>;
    cancel(chatId: string): Promise<void>;
    /** Cancel any in-progress chats associated with the given node. */
    cancelForNode(nodeId: string): Promise<void>;
    /** Runs Claude Code's /compact on a node's session, in place or as a summary fork. */
    compact(args: CompactArgs): Promise<CompactResult>;
    onEvent(handler: (ev: ChatEvent) => void): () => void;
  };
  dialog: {
    pickFolder(defaultPath?: string): Promise<string | null>;
  };
  shell: {
    openPath(path: string): Promise<void>;
  };
  processes: {
    /** Start a long-running shell command detached from the agent turn. */
    start(args: PersistentProcessStartArgs): Promise<PersistentProcessStartResult>;
    /** Stop an app-started detached process while it is still tracked in this session. */
    stop(id: string): Promise<PersistentProcessStopResult>;
  };
  files: {
    list(cwd: string): Promise<FileEntry[]>;
  };
  slash: {
    /** List slash commands + skills available from `~/.claude` and the canvas cwd. */
    list(cwd: string): Promise<SlashItem[]>;
  };
  providers: {
    /** Probe a provider's CLI install + auth state. */
    authStatus(provider: Provider): Promise<ProviderAuthStatus>;
    /** Open a shell session to run `<bin> login` for the given provider, in the user's terminal. */
    openLoginTerminal(provider: Provider): Promise<void>;
    /** Runtime model capabilities advertised by the installed Codex CLI. */
    codexRuntime(): Promise<CodexRuntimeInfo>;
    /** Models the installed Claude Code offers; its aliases (live: false) if it can't be asked. */
    claudeModels(): Promise<ClaudeModelList>;
  };
  askUser: {
    /** Subscribe to incoming ask-user requests from the agent. Returns an unsubscribe function. */
    onRequest(handler: (req: AskUserRequest) => void): () => void;
    /** Send the user's answers (or cancellation) back to the agent. */
    respond(payload: AskUserResponsePayload): Promise<void>;
  };
  window: {
    /** Open a new app window. If `canvasId` is provided, the new window opens directly on that canvas. */
    openCanvas(canvasId?: string): Promise<void>;
  };
  groupSummary: {
    /** Generate LLM-backed titles for ordered candidate prompts. Returns [] on failure so the caller can fall back to the heuristic clusterer. */
    generate(args: GenerateGroupSummaryRequest): Promise<GeneratedGroupSummaryIpc[]>;
  };
  canvasName: {
    /** Generate an LLM-backed canvas name from the first prompt. Returns null on failure so the caller keeps its prompt-derived fallback. */
    generate(args: GenerateCanvasNameRequest): Promise<string | null>;
  };
  canvasLock: {
    /** Claim a canvas for this window or tab; fails if another client holds it. */
    acquire(canvasId: string): Promise<CanvasLockResult>;
    /** Claim a canvas from whoever holds it; they are told via onLost. */
    takeOver(canvasId: string): Promise<void>;
    release(canvasId: string): Promise<void>;
    onLost(handler: (ev: CanvasLockLostEvent) => void): () => void;
  };
  web: {
    /** Desktop-only: browser access over Tailscale. */
    status(): Promise<BrowserAccessStatus>;
    setEnabled(enabled: boolean): Promise<BrowserAccessStatus>;
    setKeepAwake(keepAwake: boolean): Promise<BrowserAccessStatus>;
    createPairingLink(): Promise<PairingLink>;
    removeDevice(deviceId: string): Promise<BrowserAccessStatus>;
  };
};

declare global {
  interface Window {
    api: LmcApi;
  }
}
