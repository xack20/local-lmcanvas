import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";

export function findExecutable(
  binPath: string | undefined,
  pathEnv: string | undefined,
): string | undefined {
  const name = binPath?.trim();
  if (!name) return undefined;

  const explicit = name.startsWith("~/") ? join(homedir(), name.slice(2)) : name;
  const candidates = explicit.includes(sep)
    ? [explicit]
    : (pathEnv ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, explicit));
  return candidates.find(isExecutableFile);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
