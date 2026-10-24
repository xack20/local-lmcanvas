// .mjs keeps the bun:test import out of `bun run typecheck`.
// Run this file on its own: it redirects HOME before importing the storage modules.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
let home;
let canvases;
let paths;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "lmc-canvases-"));
  process.env.HOME = home;
  paths = await import("./paths.ts");
  if (!paths.CANVASES_DIR.startsWith(home)) {
    throw new Error("paths.ts was loaded before HOME was redirected; run this test file on its own");
  }
  canvases = await import("./canvases.ts");
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function saveRaw(id, extra) {
  mkdirSync(paths.CANVASES_DIR, { recursive: true });
  const canvas = { id, name: "Java threads", createdAt: 1, updatedAt: 1, nodes: [], edges: [], ...extra };
  writeFileSync(paths.canvasFilePath(id), JSON.stringify(canvas));
}

describe("reading a canvas", () => {
  test("keeps who named it", async () => {
    saveRaw("byuser", { nameSource: "user" });
    saveRaw("byapp", { nameSource: "auto" });
    expect((await canvases.readCanvas("byuser")).nameSource).toBe("user");
    expect((await canvases.readCanvas("byapp")).nameSource).toBe("auto");
  });

  test("a save keeps the last-used time it's given, so the list order changes only when a canvas is used", async () => {
    await canvases.writeCanvas({ id: "kept", name: "Kept", createdAt: 1, updatedAt: 123, nodes: [], edges: [] });
    expect((await canvases.readCanvas("kept")).updatedAt).toBe(123);

    const before = Date.now();
    await canvases.writeCanvas({ id: "stamped", name: "Stamped", createdAt: 1, nodes: [], edges: [] });
    expect((await canvases.readCanvas("stamped")).updatedAt).toBeGreaterThanOrEqual(before);
  });

  test("keeps a valid organized field and reports it in the canvas list", async () => {
    const organized = { fingerprint: "f", plan: { a: { title: "A" } }, undo: { a: { x: 1, y: 2 } } };
    saveRaw("organized", { organized });
    saveRaw("plain", {});

    expect((await canvases.readCanvas("organized")).organized).toEqual(organized);
    const list = await canvases.listCanvases();
    expect(list.find((c) => c.id === "organized").organized).toBe(true);
    expect(list.find((c) => c.id === "plain").organized).toBe(false);
  });

  test("drops an unknown name source and leaves older canvases without one", async () => {
    saveRaw("bogus", { nameSource: "robot" });
    saveRaw("older", {});
    expect((await canvases.readCanvas("bogus")).nameSource).toBeUndefined();
    expect((await canvases.readCanvas("older")).nameSource).toBeUndefined();
  });
});
