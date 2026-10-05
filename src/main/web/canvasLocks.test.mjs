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
    expect(locks.acquire("canvas1", tabB)).toEqual({ ok: false, holderKind: "browser" });
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
