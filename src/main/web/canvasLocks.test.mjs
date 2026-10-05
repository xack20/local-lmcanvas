// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { LOCK_LOST_CHANNEL, createCanvasLocks } from "./canvasLocks.ts";

function client(id, kind = "browser") {
  const c = { id, kind, gone: false, sent: [], send: (ch, p) => c.sent.push([ch, p]), isGone: () => c.gone };
  return c;
}

describe("createCanvasLocks", () => {
  test("the first opener holds the lock; a second tab on the same device conflicts", () => {
    const locks = createCanvasLocks();
    const tabA = client("tab-a");
    const tabB = client("tab-b");
    expect(locks.acquire("canvas1", tabA)).toEqual({ ok: true });
    expect(locks.acquire("canvas1", tabB)).toEqual({ ok: false, holderKind: "browser", replyRunning: false });
    expect(locks.acquire("canvas1", tabA)).toEqual({ ok: true });
  });

  test("taking over tells the previous holder it lost the canvas", () => {
    const locks = createCanvasLocks();
    const desktop = client("win", "desktop");
    const tab = client("tab");
    locks.acquire("canvas1", desktop);
    locks.takeOver("canvas1", tab);
    expect(desktop.sent).toEqual([[LOCK_LOST_CHANNEL, { canvasId: "canvas1" }]]);
    expect(locks.canWrite("canvas1", tab)).toBe(true);
    expect(locks.canWrite("canvas1", desktop)).toBe(false);
  });

  test("writes are allowed when nobody holds the canvas or the holder is gone", () => {
    const locks = createCanvasLocks();
    const a = client("a");
    const b = client("b");
    expect(locks.canWrite("free", b)).toBe(true);
    locks.acquire("canvas1", a);
    a.gone = true;
    expect(locks.canWrite("canvas1", b)).toBe(true);
    expect(locks.acquire("canvas1", b)).toEqual({ ok: true });
  });

  test("release and releaseAll free only that client's canvases", () => {
    const locks = createCanvasLocks();
    const a = client("a");
    const b = client("b");
    locks.acquire("one", a);
    locks.acquire("two", a);
    locks.acquire("three", b);
    locks.release("one", b);
    expect(locks.acquire("one", b).ok).toBe(false);
    locks.releaseAll(a);
    expect(locks.acquire("one", b)).toEqual({ ok: true });
    expect(locks.acquire("two", b)).toEqual({ ok: true });
  });
});

describe("createCanvasLocks with running replies", () => {
  // `running` holds "<client id>:<canvas id>" for each reply in progress.
  function withReplies(running) {
    const stopped = [];
    const locks = createCanvasLocks({
      isReplyRunning: (holder, canvasId) => running.has(`${holder.id}:${canvasId}`),
      stopReplies: (holder, canvasId) => {
        stopped.push([holder.id, canvasId, holder.sent.length]);
        running.delete(`${holder.id}:${canvasId}`);
      },
    });
    return { locks, stopped };
  }

  test("a conflict says whether the holder has a reply running on that canvas", () => {
    const { locks } = withReplies(new Set(["win:canvas1"]));
    const desktop = client("win", "desktop");
    locks.acquire("canvas1", desktop);
    locks.acquire("canvas2", desktop);
    expect(locks.acquire("canvas1", client("tab"))).toEqual({ ok: false, holderKind: "desktop", replyRunning: true });
    expect(locks.acquire("canvas2", client("tab"))).toEqual({ ok: false, holderKind: "desktop", replyRunning: false });
  });

  test("taking over stops the previous holder's replies on that canvas before it switches", () => {
    const { locks, stopped } = withReplies(new Set(["win:canvas1"]));
    const desktop = client("win", "desktop");
    const tab = client("tab");
    locks.acquire("canvas1", desktop);
    locks.takeOver("canvas1", tab);
    expect(stopped).toEqual([["win", "canvas1", 0]]);
    expect(desktop.sent).toEqual([[LOCK_LOST_CHANNEL, { canvasId: "canvas1" }]]);
    expect(locks.canWrite("canvas1", tab)).toBe(true);
  });

  test("taking over a free canvas, your own, or one whose holder is gone stops nothing", () => {
    const { locks, stopped } = withReplies(new Set());
    const a = client("a");
    const b = client("b");
    locks.takeOver("free", a);
    locks.takeOver("free", a);
    locks.acquire("canvas1", b);
    b.gone = true;
    locks.takeOver("canvas1", a);
    expect(stopped).toEqual([]);
  });
});
