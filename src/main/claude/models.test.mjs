// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { createClaudeModelCatalog, listClaudeCodeModels } from "./models.ts";
import { FALLBACK_CLAUDE_MODELS } from "../../shared/claudeModels.ts";

const LIVE = [
  { value: "default", displayName: "Default (recommended)", description: "Opus 5.5", supportedEffortLevels: ["low"] },
  { value: "opus", displayName: "Opus 5.5", description: "", supportedEffortLevels: ["low"] },
];

function harness(listImpl, extra = {}) {
  const calls = [];
  let time = 0;
  const catalog = createClaudeModelCatalog({
    executableFor: (binPath) => (binPath ? `/bin/${binPath}` : undefined),
    list: (executable) => {
      calls.push(executable);
      return listImpl(executable, calls.length);
    },
    realpath: (path) => path,
    now: () => time,
    warn: () => {},
    ...extra,
  });
  return { catalog, calls, advance: (ms) => (time += ms) };
}

describe("createClaudeModelCatalog", () => {
  test("asks the CLI once per binary and reuses the list", async () => {
    const { catalog, calls } = harness(async () => LIVE);
    const first = await catalog.list("claude");
    const second = await catalog.list("claude");
    expect(first.live).toBe(true);
    expect(first.models.map((m) => m.value)).toEqual(["default", "opus"]);
    expect(second).toBe(first);
    expect(calls).toEqual(["/bin/claude"]);
  });

  test("concurrent requests share one CLI call", async () => {
    const { catalog, calls } = harness(async () => LIVE);
    const [a, b] = await Promise.all([catalog.list("claude"), catalog.list("claude")]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  test("a different binary, or one a symlink now points elsewhere, gets its own list", async () => {
    let target = "/versions/2.1.289/claude";
    const { catalog, calls } = harness(async () => LIVE, { realpath: () => target });
    await catalog.list("claude");
    target = "/versions/2.1.300/claude";
    await catalog.list("claude");
    expect(calls).toHaveLength(2);
  });

  test("falls back to Claude Code's aliases when the CLI fails, keeps that for a minute, then retries", async () => {
    const { catalog, calls, advance } = harness(async (_exe, n) => {
      if (n === 1) throw new Error("spawn ENOENT");
      return LIVE;
    });
    expect(await catalog.list("claude")).toEqual({ models: [...FALLBACK_CLAUDE_MODELS], live: false });
    advance(30_000);
    expect((await catalog.list("claude")).live).toBe(false);
    expect(calls).toHaveLength(1);
    advance(31_000);
    expect((await catalog.list("claude")).live).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("a CLI call that throws synchronously is handled like any failure", async () => {
    const { catalog } = harness(() => {
      throw new Error("boom");
    });
    expect((await catalog.list("claude")).live).toBe(false);
  });

  test("falls back when the CLI returns no usable models", async () => {
    const { catalog } = harness(async () => [{ nope: true }]);
    expect((await catalog.list("claude")).models).toEqual([...FALLBACK_CLAUDE_MODELS]);
  });

  test("modelsWithin gives up after the budget but the list still arrives for later calls", async () => {
    let release;
    const { catalog } = harness(() => new Promise((resolve) => (release = () => resolve(LIVE))));
    expect(await catalog.modelsWithin("claude", 10)).toBeNull();
    release();
    expect((await catalog.modelsWithin("claude", 10))?.map((m) => m.value)).toEqual(["default", "opus"]);
  });
});

describe("listClaudeCodeModels", () => {
  function fakeQuery(supportedModels) {
    const seen = {};
    const queryFn = ({ options }) => {
      seen.options = options;
      return { supportedModels: () => supportedModels(seen) };
    };
    return { queryFn, seen };
  }

  test("reads the models without settings, plugins, MCP servers or a saved session, then stops the CLI", async () => {
    const { queryFn, seen } = fakeQuery(async () => LIVE);
    expect(await listClaudeCodeModels("/bin/claude", { queryFn, timeoutMs: 1000 })).toEqual(LIVE);
    expect(seen.options).toMatchObject({
      pathToClaudeCodeExecutable: "/bin/claude",
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
    });
    expect(typeof seen.options.cwd).toBe("string");
    expect(seen.options.abortController.signal.aborted).toBe(true);
  });

  test("times out and still stops the CLI", async () => {
    const { queryFn, seen } = fakeQuery(() => new Promise(() => {}));
    await expect(listClaudeCodeModels("/bin/claude", { queryFn, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(seen.options.abortController.signal.aborted).toBe(true);
  });
});

describe("modelsWithin robustness", () => {
  test("answers null instead of throwing when the binary can't be resolved", async () => {
    const catalog = createClaudeModelCatalog({
      executableFor: () => {
        throw new Error("bad settings");
      },
      list: async () => LIVE,
      warn: () => {},
    });
    expect(await catalog.modelsWithin("claude", 50)).toBeNull();
  });
});

describe("keeping the list current while the app runs", () => {
  const NEWER = [...LIVE, { value: "claude-opus-6", displayName: "Opus 6", description: "", supportedEffortLevels: ["low"] }];
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("a live list is re-checked in the background after ten minutes; callers get the cached list meanwhile", async () => {
    const { catalog, calls, advance } = harness(async (_exe, n) => (n === 1 ? LIVE : NEWER));
    await catalog.list("claude");
    advance(9 * 60_000);
    await catalog.list("claude");
    expect(calls).toHaveLength(1);

    advance(2 * 60_000);
    const served = await catalog.list("claude");
    expect(served.models.map((m) => m.value)).toEqual(["default", "opus"]);
    await flush();
    expect(calls).toHaveLength(2);
    expect((await catalog.list("claude")).models.map((m) => m.value)).toContain("claude-opus-6");
  });

  test("a failed background re-check keeps the last good list and tries again a minute later", async () => {
    const { catalog, calls, advance } = harness(async (_exe, n) => {
      if (n === 2) throw new Error("network down");
      return n === 1 ? LIVE : NEWER;
    });
    await catalog.list("claude");
    advance(11 * 60_000);
    await catalog.list("claude");
    await flush();
    const afterFailure = await catalog.list("claude");
    expect(afterFailure.live).toBe(true);
    expect(afterFailure.models.map((m) => m.value)).toEqual(["default", "opus"]);
    expect(calls).toHaveLength(2);

    advance(61_000);
    await catalog.list("claude");
    await flush();
    expect(calls).toHaveLength(3);
    expect((await catalog.list("claude")).models.map((m) => m.value)).toContain("claude-opus-6");
  });

  test("only one background re-check runs at a time", async () => {
    let release;
    const { catalog, calls, advance } = harness((_exe, n) =>
      n === 1 ? Promise.resolve(LIVE) : new Promise((resolve) => (release = () => resolve(NEWER))),
    );
    await catalog.list("claude");
    advance(11 * 60_000);
    await Promise.all([catalog.list("claude"), catalog.list("claude"), catalog.list("claude")]);
    expect(calls).toHaveLength(2);
    release();
  });
});
