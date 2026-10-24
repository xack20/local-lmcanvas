// .mjs keeps the bun:test import out of `bun run typecheck`.
// Run this file on its own: it redirects HOME before importing the storage modules.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
let home;
let paths;
let canvases;
let shareFiles;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "lmc-share-"));
  process.env.HOME = home;
  paths = await import("./paths.ts");
  if (!paths.CANVASES_DIR.startsWith(home)) {
    throw new Error("paths.ts was loaded before HOME was redirected; run this test file on its own");
  }
  canvases = await import("./canvases.ts");
  shareFiles = await import("./canvasShareFiles.ts");
  await canvases.writeCanvas({
    id: "c1",
    name: "Java threads",
    cwd: "/Users/x/proj",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "root",
        type: "custom",
        position: { x: 0, y: 0 },
        data: {
          chat: {
            parentIds: [],
            childIds: ["kid"],
            providerSession: { provider: "claude", id: "sess-1" },
            messages: [
              { id: "u1", role: "user", createdAt: 1, blocks: [{ type: "text", text: "Teach me threads" }] },
              { id: "a1", role: "assistant", createdAt: 2, status: "complete", blocks: [{ type: "text", text: "Threads run on cores." }] },
            ],
          },
        },
      },
      {
        id: "kid",
        type: "custom",
        position: { x: 0, y: 300 },
        data: { chat: { parentIds: ["root"], childIds: [], messages: [] } },
      },
    ],
    edges: [{ id: "e1", source: "root", target: "kid" }],
  });
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

const texts = (c) => c.nodes.flatMap((n) => n.data.chat.messages.flatMap((m) => m.blocks.map((b) => b.text)));
const canvasFiles = () => readdirSync(paths.CANVASES_DIR).filter((f) => f.endsWith(".json")).sort();

describe("canvas share files", () => {
  test("an exported canvas imports as a new canvas that reads back the same", async () => {
    const file = join(home, "Java threads.lmcanvas");
    expect(await shareFiles.exportCanvasToFile("c1", file)).toBe(true);
    expect(await shareFiles.exportCanvasToFile("missing", join(home, "x.lmcanvas"))).toBe(false);

    const result = await shareFiles.importCanvasFromFile(file);

    expect(result.status).toBe("imported");
    expect(result.canvasId).not.toBe("c1");
    const original = await canvases.readCanvas("c1");
    const imported = await canvases.readCanvas(result.canvasId);
    expect(imported.name).toBe("Java threads");
    expect(imported.nameSource).toBe("auto");
    expect(imported.cwd).toBeUndefined();
    expect(imported.nodes).toHaveLength(2);
    expect(imported.edges).toHaveLength(1);
    expect(texts(imported)).toEqual(texts(original));
    expect(imported.nodes.every((n) => n.data.chat.providerSession === undefined)).toBe(true);
    expect(imported.nodes.flatMap((n) => n.data.chat.messages).every((m) => m.imported === true)).toBe(true);
  });

  test("importing the same file twice makes two canvases with different canvas and node ids", async () => {
    const file = join(home, "twice.lmcanvas");
    await shareFiles.exportCanvasToFile("c1", file);

    const first = await shareFiles.importCanvasFromFile(file);
    const second = await shareFiles.importCanvasFromFile(file);

    expect(first.canvasId).not.toBe(second.canvasId);
    const ids = async (id) => (await canvases.readCanvas(id)).nodes.map((n) => n.id);
    const firstIds = await ids(first.canvasId);
    for (const id of await ids(second.canvasId)) expect(firstIds).not.toContain(id);
  });

  test("a file over the size limit is refused without being read", async () => {
    const file = join(home, "big.lmcanvas");
    await shareFiles.exportCanvasToFile("c1", file);
    const before = canvasFiles();

    expect(await shareFiles.importCanvasFromFile(file, 10)).toEqual({ status: "refused", reason: "too-large" });
    expect(canvasFiles()).toEqual(before);
  });

  test("a file that isn't JSON is refused as not an LMCanvas file and nothing is written", async () => {
    const file = join(home, "notes.lmcanvas");
    writeFileSync(file, "hello, this is a text file");
    const before = canvasFiles();

    expect(await shareFiles.importCanvasFromFile(file)).toEqual({ status: "refused", reason: "not-lmcanvas" });
    expect(canvasFiles()).toEqual(before);
  });
});
