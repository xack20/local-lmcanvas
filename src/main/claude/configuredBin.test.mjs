// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findExecutable } from "./configuredBin.ts";

let root;
let binDir;
let otherDir;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lmcanvas-bin-"));
  binDir = join(root, "bin");
  otherDir = join(root, "other");
  mkdirSync(binDir);
  mkdirSync(otherDir);
  mkdirSync(join(otherDir, "claude"));
  writeFileSync(join(binDir, "claude"), "#!/bin/sh\n");
  chmodSync(join(binDir, "claude"), 0o755);
  writeFileSync(join(binDir, "not-executable"), "");
  chmodSync(join(binDir, "not-executable"), 0o644);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findExecutable", () => {
  test("resolves a bare command name through PATH, skipping directories", () => {
    const pathEnv = [otherDir, binDir].join(delimiter);
    expect(findExecutable("claude", pathEnv)).toBe(join(binDir, "claude"));
  });

  test("returns an explicit path when it is an executable file", () => {
    const explicit = join(binDir, "claude");
    expect(findExecutable(explicit, "")).toBe(explicit);
  });

  test("treats ~/ paths as explicit paths under the home directory", () => {
    expect(findExecutable("~/definitely-missing-lmcanvas-bin", binDir)).toBeUndefined();
    expect(findExecutable("~/", binDir)).toBeUndefined();
  });

  test.each([
    ["missing command", "claude-missing", () => binDir],
    ["non-executable file", "not-executable", () => binDir],
    ["directory named like the command", "claude", () => otherDir],
    ["empty setting", "", () => binDir],
    ["blank setting", "   ", () => binDir],
    ["undefined setting", undefined, () => binDir],
  ])("returns undefined for a %s", (_label, binPath, pathEnv) => {
    expect(findExecutable(binPath, pathEnv())).toBeUndefined();
  });

  test("returns undefined when PATH is unset", () => {
    expect(findExecutable("claude", undefined)).toBeUndefined();
  });
});
