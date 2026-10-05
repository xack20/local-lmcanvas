// .mjs keeps the bun:test import out of `bun run typecheck`.
// Run this file on its own: it redirects HOME before importing the storage modules.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
let home;
let settings;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "lmc-settings-"));
  process.env.HOME = home;
  const paths = await import("./paths.ts");
  if (!paths.SETTINGS_FILE.startsWith(home)) {
    throw new Error("paths.ts was loaded before HOME was redirected; run this test file on its own");
  }
  settings = await import("./settings.ts");
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("last node settings", () => {
  test("keep a valid Claude model and drop one that isn't a model id", async () => {
    const current = await settings.readSettings();
    await settings.writeSettings({ ...current, lastNodeSettings: { model: "opus", reasoningEffort: "high" } });
    expect((await settings.readSettings()).lastNodeSettings).toEqual({ model: "opus", reasoningEffort: "high" });

    await settings.writeSettings({ ...current, lastNodeSettings: { model: "--verbose" } });
    expect((await settings.readSettings()).lastNodeSettings).toBeUndefined();
  });
});

describe("browser access settings", () => {
  test("default to off with keep-awake on", async () => {
    expect((await settings.readSettings()).browserAccess).toEqual({ enabled: false, keepAwake: true });
  });

  test("writeBrowserAccess changes only the given field", async () => {
    await settings.writeBrowserAccess({ enabled: true });
    expect((await settings.readSettings()).browserAccess).toEqual({ enabled: true, keepAwake: true });
    await settings.writeBrowserAccess({ keepAwake: false });
    expect((await settings.readSettings()).browserAccess).toEqual({ enabled: true, keepAwake: false });
  });

  test("a stale settings write cannot switch browser access on or off", async () => {
    await settings.writeBrowserAccess({ enabled: false, keepAwake: true });
    const stale = await settings.readSettings();
    await settings.writeBrowserAccess({ enabled: true });
    await settings.writeSettings({ ...stale, systemPrompt: "edited elsewhere" });
    const after = await settings.readSettings();
    expect(after.systemPrompt).toBe("edited elsewhere");
    expect(after.browserAccess.enabled).toBe(true);
    await settings.writeSettings({ ...after, browserAccess: { enabled: false, keepAwake: false } });
    expect((await settings.readSettings()).browserAccess).toEqual({ enabled: true, keepAwake: true });
  });

  test("concurrent writes never lose an update", async () => {
    await settings.writeBrowserAccess({ enabled: false, keepAwake: true });
    const result = await Promise.all([
      settings.writeBrowserAccess({ enabled: true }),
      settings.writeBrowserAccess({ keepAwake: false }),
    ]);
    expect((await settings.readSettings()).browserAccess).toEqual({ enabled: true, keepAwake: false });

    // Also test overlapping writeSettings with writeBrowserAccess
    await settings.writeBrowserAccess({ enabled: false, keepAwake: true });
    const stale = await settings.readSettings();
    await Promise.all([
      settings.writeSettings({ ...stale, systemPrompt: "concurrent" }),
      settings.writeBrowserAccess({ enabled: true }),
    ]);
    const final = await settings.readSettings();
    expect(final.systemPrompt).toBe("concurrent");
    expect(final.browserAccess.enabled).toBe(true);
  });
});
