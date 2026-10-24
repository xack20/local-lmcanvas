// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { fromShareFile, shareFileName, toShareFile } from "./canvasShare.ts";

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const pngChunk = (type, data) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
  ...pngChunk("IDAT", [9]),
  ...pngChunk("IEND", []),
]).toString("base64");

const ASK = "Where are you starting from?";

function canvas() {
  return {
    id: "c1",
    name: "Java threads",
    nameSource: "user",
    cwd: "/Users/x/proj",
    provider: "claude",
    createdAt: 1,
    updatedAt: 2,
    nodes: [
      {
        id: "root",
        type: "custom",
        position: { x: 0, y: 0 },
        data: {
          title: "Threads",
          width: 420,
          nodeSettings: { cwd: "/Users/x/proj", model: "opus" },
          context: { tokens: 1000 },
          chat: {
            parentIds: [],
            childIds: ["kid"],
            providerSession: { provider: "claude", id: "sess-1" },
            isTemporary: true,
            addedContext: "Thread.start()",
            messages: [
              {
                id: "u1",
                role: "user",
                createdAt: 1,
                blocks: [
                  { type: "text", text: "Teach me threads" },
                  { type: "image", mediaType: "image/png", base64: PNG },
                ],
              },
              {
                id: "a1",
                role: "assistant",
                createdAt: 2,
                status: "complete",
                provider: "claude",
                usage: { inputTokens: 5 },
                errorCode: "auth_required",
                modelFallback: { fromModel: "a", toModel: "b", reason: "policy_refusal" },
                suggestions: [{ label: "Next", prompt: "Go on" }],
                blocks: [
                  { type: "thinking", text: "hmm" },
                  { type: "text", text: "Threads run on cores." },
                  { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls /Users/x" }, result: { content: "secret", isError: false } },
                  { type: "compaction", trigger: "auto", before: 10, after: 5 },
                  { type: "tool_use", id: "t2", name: "ExitPlanMode", input: { plan: "1. Do A" } },
                  {
                    type: "tool_use",
                    id: "t3",
                    name: "mcp__lmc__ask_user_question",
                    input: { questions: [{ question: ASK, header: "Bg", multiSelect: false, options: [] }] },
                    result: { content: JSON.stringify({ answers: { [ASK]: "New to ML" } }), isError: false },
                  },
                ],
              },
            ],
          },
        },
      },
      {
        id: "kid",
        type: "custom",
        position: { x: 0, y: 300 },
        data: {
          chat: {
            parentIds: ["root"],
            childIds: [],
            messages: [
              { id: "u2", role: "user", createdAt: 3, blocks: [{ type: "text", text: "Why?" }] },
              { id: "a2", role: "assistant", createdAt: 4, status: "error", error: "spawn /Users/x/claude ENOENT", errorProvider: "claude", blocks: [] },
            ],
          },
        },
      },
      {
        id: "live",
        type: "custom",
        position: { x: 500, y: 0 },
        data: {
          chat: {
            parentIds: [],
            childIds: [],
            messages: [
              { id: "u3", role: "user", createdAt: 5, blocks: [{ type: "text", text: "Still going" }] },
              { id: "a3", role: "assistant", createdAt: 6, status: "streaming", blocks: [{ type: "text", text: "Partial" }] },
            ],
          },
        },
      },
      { id: "note", type: "stickyNote", position: { x: -200, y: 0 }, data: { stickyText: "Remember volatile", chat: { parentIds: [], childIds: [], messages: [] } } },
    ],
    edges: [{ id: "e1", source: "root", target: "kid", sourceHandle: "bottom", sourceYOffset: 12 }],
  };
}

const counter = () => {
  let n = 0;
  return () => `new${++n}`;
};
const nodeById = (file, id) => file.canvas.nodes.find((n) => n.id === id);
const message = (file, nodeId, msgId) => nodeById(file, nodeId).data.chat.messages.find((m) => m.id === msgId);
const texts = (m) => m.blocks.filter((b) => b.type === "text").map((b) => b.text);

describe("toShareFile", () => {
  test("export keeps the questions, answers, layout, titles, sticky notes and next steps", () => {
    const file = toShareFile(canvas(), 99);

    expect(file).toMatchObject({ format: "lmcanvas", version: 1, exportedAt: 99, canvas: { name: "Java threads" } });
    expect(nodeById(file, "root")).toMatchObject({
      position: { x: 0, y: 0 },
      data: { title: "Threads", width: 420, chat: { childIds: ["kid"], addedContext: "Thread.start()" } },
    });
    expect(nodeById(file, "note").data.stickyText).toBe("Remember volatile");
    expect(file.canvas.edges).toEqual([{ id: "e1", source: "root", target: "kid", sourceHandle: "bottom", sourceYOffset: 12 }]);
    expect(message(file, "root", "u1").blocks.map((b) => b.type)).toEqual(["text", "image"]);
    expect(message(file, "root", "a1")).toMatchObject({ provider: "claude", suggestions: [{ label: "Next", prompt: "Go on" }] });
    expect(texts(message(file, "root", "a1"))).toContain("Threads run on cores.");
  });

  test("export drops tool calls, thinking, compaction, folder paths, sessions, settings, context sizes and usage", () => {
    const json = JSON.stringify(toShareFile(canvas(), 99));
    for (const gone of [
      "tool_use", "thinking", "compaction", "providerSession", "sess-1", "nodeSettings", "/Users/x",
      "usage", "errorCode", "errorProvider", "modelFallback", "isTemporary", "\"cwd\"", "secret", "\"context\"", "nameSource",
    ]) {
      expect(json).not.toContain(gone);
    }
  });

  test("export leaves out the organize plan", () => {
    const organized = { fingerprint: "f", plan: { root: { title: "Threads" } }, undo: { root: { x: 1, y: 2 } } };
    expect(JSON.stringify(toShareFile({ ...canvas(), organized }, 99))).not.toContain("organized");
  });

  test("export turns a plan and a multiple-choice answer into text", () => {
    const replyTexts = texts(message(toShareFile(canvas(), 99), "root", "a1"));
    expect(replyTexts).toContain("**Plan**\n\n1. Do A");
    expect(replyTexts).toContain(`**Question:** ${ASK}\n**Answer:** New to ML`);
  });

  test("export replaces error text and marks a streaming reply interrupted", () => {
    const file = toShareFile(canvas(), 99);
    expect(message(file, "kid", "a2")).toMatchObject({ status: "error", error: "This reply failed." });
    expect(message(file, "live", "a3")).toMatchObject({ status: "error", error: "interrupted" });
  });
});

describe("fromShareFile", () => {
  test("import of an exported file shows the same canvas, with new node ids, imported replies and an auto name", () => {
    const original = canvas();
    const exported = JSON.parse(JSON.stringify(toShareFile(original, 99)));

    const result = fromShareFile(exported, counter());

    expect(result.ok).toBe(true);
    const { canvas: imported } = result;
    expect(imported.name).toBe("Java threads");
    expect(imported.nameSource).toBe("auto");
    expect(imported.nodes).toHaveLength(4);
    const oldIds = original.nodes.map((n) => n.id);
    for (const n of imported.nodes) expect(oldIds).not.toContain(n.id);
    const idOf = Object.fromEntries(exported.canvas.nodes.map((n, i) => [n.id, imported.nodes[i].id]));
    const kid = imported.nodes.find((n) => n.id === idOf.kid);
    const root = imported.nodes.find((n) => n.id === idOf.root);
    expect(kid.data.chat.parentIds).toEqual([idOf.root]);
    expect(root.data.chat.childIds).toEqual([idOf.kid]);
    expect(imported.edges).toHaveLength(1);
    expect(imported.edges[0]).toMatchObject({ source: idOf.root, target: idOf.kid, sourceHandle: "bottom", sourceYOffset: 12 });
    expect(imported.edges[0].id).not.toBe("e1");
    const messages = imported.nodes.flatMap((n) => n.data.chat.messages);
    expect(messages.every((m) => m.imported === true)).toBe(true);
    expect(messages.map(texts)).toEqual(exported.canvas.nodes.flatMap((n) => n.data.chat.messages).map(texts));
  });

  test("import refuses something that isn't an LMCanvas file, and a newer version", () => {
    const share = (extra) => ({ format: "lmcanvas", version: 1, exportedAt: 1, canvas: { name: "x", nodes: [], edges: [] }, ...extra });
    expect(fromShareFile("x", counter())).toEqual({ ok: false, reason: "not-lmcanvas" });
    expect(fromShareFile(null, counter())).toEqual({ ok: false, reason: "not-lmcanvas" });
    expect(fromShareFile(share({ format: "other" }), counter())).toEqual({ ok: false, reason: "not-lmcanvas" });
    expect(fromShareFile(share({ version: "1" }), counter())).toEqual({ ok: false, reason: "not-lmcanvas" });
    expect(fromShareFile(share({ canvas: undefined }), counter())).toEqual({ ok: false, reason: "not-lmcanvas" });
    expect(fromShareFile(share({ version: 2 }), counter())).toEqual({ ok: false, reason: "newer-version" });
    expect(fromShareFile(share({}), counter()).ok).toBe(true);
  });

  test("import keeps what is valid in a damaged file and drops the rest", () => {
    const chat = (extra = {}) => ({ parentIds: [], childIds: [], messages: [], ...extra });
    const result = fromShareFile(
      {
        format: "lmcanvas",
        version: 1,
        exportedAt: 1,
        canvas: {
          name: "Damaged",
          nodes: [
            { id: "A", type: "custom", position: { x: 0, y: 0 }, data: { title: "first", chat: chat() } },
            { id: "A", type: "custom", position: { x: 9, y: 9 }, data: { title: "duplicate", chat: chat() } },
            { id: "B", type: "group", position: { x: 0, y: 0 }, data: { chat: chat() } },
            { id: "C", type: "custom", position: { x: "a", y: 0 }, data: { chat: chat() } },
            {
              id: "D",
              type: "custom",
              position: { x: 0, y: 200 },
              data: {
                chat: chat({
                  parentIds: ["A", "Z"],
                  messages: [
                    {
                      id: "m",
                      role: "assistant",
                      createdAt: 1,
                      status: "complete",
                      blocks: [
                        { type: "tool_use", id: "t", name: "Bash", input: {} },
                        { type: "text", text: 5 },
                        { type: "image", mediaType: "image/tiff", base64: "AAAA" },
                        { type: "text", text: "ok" },
                      ],
                    },
                  ],
                }),
              },
            },
            "not a node",
          ],
          edges: [
            { id: "e1", source: "A", target: "D" },
            { id: "e2", source: "A", target: "Z" },
            { id: "e3", source: 7, target: "D" },
          ],
        },
      },
      counter(),
    );

    expect(result.ok).toBe(true);
    const { nodes, edges } = result.canvas;
    expect(nodes.map((n) => n.data.title ?? null)).toEqual(["first", null]);
    const [a, d] = nodes;
    expect(d.data.chat.parentIds).toEqual([a.id]);
    expect(d.data.chat.messages[0].blocks).toEqual([{ type: "text", text: "ok" }]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: a.id, target: d.id });
  });

  test("an imported canvas with a blank name is called Imported canvas", () => {
    const result = fromShareFile({ format: "lmcanvas", version: 1, exportedAt: 1, canvas: { name: "   ", nodes: [], edges: [] } }, counter());
    expect(result.canvas.name).toBe("Imported canvas");
  });

  test("an imported canvas named Untitled canvas is renamed, since the list hides that name", () => {
    const result = fromShareFile({ format: "lmcanvas", version: 1, exportedAt: 1, canvas: { name: "Untitled Canvas", nodes: [], edges: [] } }, counter());
    expect(result.canvas.name).toBe("Imported canvas");
  });

  test("imported edges use the app's own edge ids, without duplicates or self-loops", () => {
    const chat = { parentIds: [], childIds: [], messages: [] };
    const result = fromShareFile(
      {
        format: "lmcanvas",
        version: 1,
        exportedAt: 1,
        canvas: {
          name: "Edges",
          nodes: [
            { id: "A", type: "custom", position: { x: 0, y: 0 }, data: { chat } },
            { id: "B", type: "custom", position: { x: 0, y: 300 }, data: { chat } },
          ],
          edges: [
            { id: "e1", source: "A", target: "B" },
            { id: "e2", source: "A", target: "B" },
            { id: "e3", source: "B", target: "B" },
          ],
        },
      },
      counter(),
    );
    const [a, b] = result.canvas.nodes;
    expect(result.canvas.edges).toEqual([{ id: `e-${a.id}-${b.id}`, source: a.id, target: b.id }]);
  });

  test("the merge context a node was sent with survives export and import", () => {
    const original = canvas();
    const withMerge = { ...original, nodes: original.nodes.map((n) => (n.id === "kid" ? { ...n, data: { ...n.data, chat: { ...n.data.chat, sentMergeContext: "Conversation 1: …" } } } : n)) };
    const exported = JSON.parse(JSON.stringify(toShareFile(withMerge, 99)));
    const imported = fromShareFile(exported, counter()).canvas;
    expect(imported.nodes.map((n) => n.data.chat.sentMergeContext).filter(Boolean)).toEqual(["Conversation 1: …"]);
  });
});

describe("shareFileName", () => {
  test("a default file name never contains a path separator", () => {
    expect(shareFileName("TCP/IP: basics")).toBe("TCP-IP- basics.lmcanvas");
    expect(shareFileName("a\\b*c?d\"e<f>g|h")).toBe("a-b-c-d-e-f-g-h.lmcanvas");
    expect(shareFileName("")).toBe("Canvas.lmcanvas");
    expect(shareFileName("Java threads")).toBe("Java threads.lmcanvas");
    // A leading dot would hide the file in Finder.
    expect(shareFileName(".env notes")).toBe("env notes.lmcanvas");
    expect(shareFileName("..")).toBe("Canvas.lmcanvas");
  });
});
