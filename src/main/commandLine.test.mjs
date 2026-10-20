// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommandLine } from "./commandLine.ts";

const NPM_SHIM = `@ECHO off
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

let root;
let npmDir;
let nodeDir;
let exeDir;
let opaqueDir;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lmcanvas-cmd-"));
  npmDir = join(root, "npm");
  nodeDir = join(root, "node");
  exeDir = join(root, "exe");
  opaqueDir = join(root, "opaque");
  for (const dir of [npmDir, nodeDir, exeDir, opaqueDir]) mkdirSync(dir);
  mkdirSync(join(npmDir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js"), "");
  writeFileSync(join(npmDir, "codex.cmd"), NPM_SHIM);
  writeFileSync(join(nodeDir, "node.exe"), "");
  writeFileSync(join(exeDir, "cursor-agent.exe"), "");
  writeFileSync(join(opaqueDir, "agent.cmd"), "@echo off\r\nsomething-else %*\r\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const winEnv = (...dirs) => ({ Path: dirs.join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD" });

describe("resolveCommandLine", () => {
  test("leaves the command alone off Windows", () => {
    expect(resolveCommandLine("codex", ["a"], { PATH: npmDir }, "linux")).toEqual({
      command: "codex",
      args: ["a"],
    });
  });

  test("runs the script behind an npm .cmd shim with node from PATH", () => {
    const line = resolveCommandLine("codex", ["app-server", "--stdio"], winEnv(npmDir, nodeDir), "win32");
    expect(line).toEqual({
      command: join(nodeDir, "node.exe"),
      args: [join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js"), "app-server", "--stdio"],
    });
  });

  test("prefers a node.exe sitting next to the shim", () => {
    writeFileSync(join(npmDir, "node.exe"), "");
    try {
      const line = resolveCommandLine("codex", [], winEnv(npmDir, nodeDir), "win32");
      expect(line.command).toBe(join(npmDir, "node.exe"));
    } finally {
      rmSync(join(npmDir, "node.exe"));
    }
  });

  test("spawns a real .exe directly", () => {
    const line = resolveCommandLine("cursor-agent", ["-p", "hi\nthere"], winEnv(exeDir), "win32");
    expect(line).toEqual({ command: join(exeDir, "cursor-agent.exe"), args: ["-p", "hi\nthere"] });
  });

  test("falls back to cmd.exe with escaped arguments for an unknown shim", () => {
    const line = resolveCommandLine("agent", ["a b", 'say "hi" & exit'], winEnv(opaqueDir), "win32");
    expect(line.command).toBe("cmd.exe");
    expect(line.windowsVerbatimArguments).toBe(true);
    expect(line.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(line.args[3]).toContain('^"a^ b^"');
    expect(line.args[3]).toContain("^&");
  });

  test("returns the bare name when nothing on PATH matches, so spawn reports ENOENT", () => {
    expect(resolveCommandLine("missing", [], winEnv(npmDir), "win32")).toEqual({
      command: "missing",
      args: [],
    });
  });
});
