// src/main/claude/modelWindows.test.mjs
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelWindows } from "./modelWindows.ts";

const dir = mkdtempSync(join(tmpdir(), "lmc-windows-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadModelWindows", () => {
  test("starts empty when the file is missing or broken", async () => {
    expect((await loadModelWindows(join(dir, "none.json"))).windowFor("claude-opus-5-5")).toBeUndefined();
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect((await loadModelWindows(join(dir, "bad.json"))).windowFor("x")).toBeUndefined();
  });

  test("learns windows, persists them, and ignores bad input", async () => {
    const file = join(dir, "w.json");
    const windows = await loadModelWindows(file);
    await windows.learn("claude-opus-5-5", 1_000_000);
    await windows.learn(undefined, 5);
    await windows.learn("bad", -1);
    expect(windows.windowFor("claude-opus-5-5")).toBe(1_000_000);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "claude-opus-5-5": 1_000_000 });
    expect((await loadModelWindows(file)).windowFor("claude-opus-5-5")).toBe(1_000_000);
  });

  test("concurrent learns all land", async () => {
    const file = join(dir, "c.json");
    const windows = await loadModelWindows(file);
    await Promise.all([windows.learn("a", 1), windows.learn("b", 2), windows.learn("c", 3)]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 1, b: 2, c: 3 });
  });
});
