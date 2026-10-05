// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { desktopClient } from "./client.ts";

function fakeWebContents(id = 1) {
  const wc = new EventEmitter();
  wc.id = id;
  wc.destroyed = false;
  wc.sent = [];
  wc.send = (channel, payload) => wc.sent.push([channel, payload]);
  wc.isDestroyed = () => wc.destroyed;
  wc.destroy = () => {
    wc.destroyed = true;
    wc.emit("destroyed");
  };
  return wc;
}

describe("desktopClient", () => {
  test("returns the same client for the same window", () => {
    const wc = fakeWebContents(4);
    expect(desktopClient(wc)).toBe(desktopClient(wc));
    expect(desktopClient(wc).id).toBe("desktop-4");
    expect(desktopClient(wc).kind).toBe("desktop");
  });

  test("forwards send until the window is destroyed", () => {
    const wc = fakeWebContents();
    const client = desktopClient(wc);
    client.send("chat:event", { a: 1 });
    wc.destroy();
    client.send("chat:event", { a: 2 });
    expect(wc.sent).toEqual([["chat:event", { a: 1 }]]);
    expect(client.isGone()).toBe(true);
  });

  test("onGone fires on destroy, and unsubscribing stops it", () => {
    const wc = fakeWebContents();
    const client = desktopClient(wc);
    let fired = 0;
    let removedFired = 0;
    client.onGone(() => fired++);
    const unsubscribe = client.onGone(() => removedFired++);
    unsubscribe();
    wc.destroy();
    expect(fired).toBe(1);
    expect(removedFired).toBe(0);
  });
});
