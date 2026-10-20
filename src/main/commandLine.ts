import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { findExecutable, pathFromEnv, windowsExtensions } from "./claude/configuredBin";

export type CommandLine = {
  command: string;
  args: string[];
  /** Pass through to spawn: the cmd.exe fallback builds its own quoting. */
  windowsVerbatimArguments?: boolean;
};

const SHIM_TARGET = /"%~?dp0%?\\?([^"%]+\.(?:js|mjs|cjs|exe))"/gi;
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * How to spawn a CLI by name without a shell. On Windows, CLIs installed with npm
 * are `.cmd` shims, which Node refuses to spawn directly; this runs the script or
 * .exe the shim points at instead, and only falls back to cmd.exe when it can't tell.
 */
export function resolveCommandLine(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): CommandLine {
  if (platform !== "win32") return { command: bin, args: [...args] };

  const pathEnv = pathFromEnv(env);
  const extensions = windowsExtensions(env.PATHEXT);
  const resolved = findExecutable(bin, pathEnv, { platform, extensions });
  if (!resolved) return { command: bin, args: [...args] };

  const ext = extname(resolved).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: resolved, args: [...args] };

  const target = shimTarget(resolved);
  if (target && extname(target).toLowerCase() === ".exe") {
    return { command: target, args: [...args] };
  }
  if (target) {
    const bundledNode = join(dirname(resolved), "node.exe");
    const node = existsSync(bundledNode)
      ? bundledNode
      : findExecutable("node", pathEnv, { platform, extensions: [".exe"] });
    if (node) return { command: node, args: [target, ...args] };
  }
  return viaCmd(resolved, args, env);
}

function shimTarget(shimPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  const matches = [...text.matchAll(SHIM_TARGET)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = join(dirname(shimPath), matches[i][1].replace(/\\/g, "/"));
    if (basename(candidate).toLowerCase() === "node.exe") continue;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function viaCmd(script: string, args: readonly string[], env: NodeJS.ProcessEnv): CommandLine {
  const line = [script.replace(CMD_META, "^$1"), ...args.map(escapeCmdArg)].join(" ");
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

function escapeCmdArg(arg: string): string {
  const quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${quoted}"`.replace(CMD_META, "^$1");
}
