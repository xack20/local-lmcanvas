// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { ApiError, bindRegistryToIpc, createApiRegistry } from "./registry.ts";

const desktop = { id: "d", kind: "desktop" };
const browser = { id: "b", kind: "browser" };

describe("createApiRegistry", () => {
  test("routes a call to its handler with the client and args", async () => {
    const api = createApiRegistry();
    api.handle("echo", async (client, a, b) => ({ kind: client.kind, a, b }));
    expect(await api.invoke("echo", browser, [1, "x"])).toEqual({ kind: "browser", a: 1, b: "x" });
  });

  test("rejects unknown channels with code unknown-channel", async () => {
    const api = createApiRegistry();
    const call = api.invoke("nope", desktop, []);
    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(api.invoke("nope", desktop, [])).rejects.toMatchObject({ code: "unknown-channel" });
  });

  test("refuses desktop-only channels for browser clients without running them", async () => {
    const api = createApiRegistry();
    let ran = 0;
    api.handle("web:createPairingLink", async () => ++ran, "desktop-only");
    await expect(api.invoke("web:createPairingLink", browser, [])).rejects.toMatchObject({ code: "forbidden" });
    expect(ran).toBe(0);
    expect(await api.invoke("web:createPairingLink", desktop, [])).toBe(1);
  });

  test("passes handler errors through unchanged", async () => {
    const api = createApiRegistry();
    api.handle("boom", async () => {
      throw new Error("nope");
    });
    await expect(api.invoke("boom", desktop, [])).rejects.toThrow("nope");
  });

  test("refuses a duplicate channel", () => {
    const api = createApiRegistry();
    api.handle("x", async () => 1);
    expect(() => api.handle("x", async () => 2)).toThrow("Duplicate API channel: x");
  });
});

describe("bindRegistryToIpc", () => {
  test("registers every channel and maps the IPC sender to a client", async () => {
    const api = createApiRegistry();
    api.handle("a", async (client, n) => `${client.id}:${n}`);
    const handlers = new Map();
    bindRegistryToIpc(api, { handle: (channel, fn) => handlers.set(channel, fn) }, (sender) => ({
      id: `desktop-${sender.id}`,
      kind: "desktop",
    }));
    expect([...handlers.keys()]).toEqual(["a"]);
    expect(await handlers.get("a")({ sender: { id: 3 } }, 7)).toBe("desktop-3:7");
  });
});
