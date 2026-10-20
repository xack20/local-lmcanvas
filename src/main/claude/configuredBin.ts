import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, join } from "node:path";

export type FindExecutableOptions = {
  platform?: NodeJS.Platform;
  /** Windows only: file extensions to try for a name without one. Defaults to PATHEXT. */
  extensions?: readonly string[];
};

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function windowsExtensions(pathext: string | undefined = process.env.PATHEXT): string[] {
  return (pathext || DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
}

/** PATH from an env object, matched case-insensitively (Windows spells it `Path`). */
export function pathFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PATH !== undefined) return env.PATH;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return key ? env[key] : undefined;
}

export function findExecutable(
  binPath: string | undefined,
  pathEnv: string | undefined,
  options: FindExecutableOptions = {},
): string | undefined {
  const name = binPath?.trim();
  if (!name) return undefined;

  const windows = (options.platform ?? process.platform) === "win32";
  const homePrefix = windows ? /^~[\\/]/ : /^~\//;
  const explicit = homePrefix.test(name) ? join(homedir(), name.slice(2)) : name;
  const isPath = windows ? /[\\/]/.test(explicit) : explicit.includes("/");
  const bases = isPath
    ? [explicit]
    : (pathEnv ?? "")
        .split(windows ? ";" : delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, explicit));

  const extensions = windows ? (options.extensions ?? windowsExtensions()) : [];
  const candidates = windows
    ? bases.flatMap((base) =>
        extensions.includes(extname(base).toLowerCase())
          ? [base]
          : extensions.map((ext) => base + ext),
      )
    : bases;
  return candidates.find((path) => isExecutableFile(path, windows));
}

// Windows has no execute bit: the extension is what makes a file runnable there.
function isExecutableFile(path: string, windows: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, windows ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
