// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { parseDirListing, pickFolderViaUi, registerFolderPicker, useWebUiStore } from "./webUi.ts";

describe("folder picker slot", () => {
  test("returns null when no picker is mounted", async () => {
    expect(await pickFolderViaUi("/x")).toBeNull();
  });
  test("delegates to the mounted picker until it unmounts", async () => {
    const unregister = registerFolderPicker(async (start) => `${start}/chosen`);
    expect(await pickFolderViaUi("/home")).toBe("/home/chosen");
    unregister();
    expect(await pickFolderViaUi("/home")).toBeNull();
  });
});

describe("parseDirListing", () => {
  test("accepts a well-formed listing", () => {
    const body = { ok: true, result: { path: "/Users/me", parent: null, dirs: ["a", "b"] } };
    expect(parseDirListing(body)).toEqual({ path: "/Users/me", parent: null, dirs: ["a", "b"] });
  });
  test("rejects errors and malformed bodies", () => {
    expect(parseDirListing({ ok: false, error: "x" })).toBeNull();
    expect(parseDirListing({ ok: true, result: { path: 1, dirs: [] } })).toBeNull();
    expect(parseDirListing(null)).toBeNull();
  });
});

describe("useWebUiStore", () => {
  test("tracks connection state and notices", () => {
    useWebUiStore.getState().setConnection("reconnecting");
    useWebUiStore.getState().showNotice("Path copied: /x");
    expect(useWebUiStore.getState().connection).toBe("reconnecting");
    expect(useWebUiStore.getState().notice).toBe("Path copied: /x");
    useWebUiStore.getState().clearNotice();
    expect(useWebUiStore.getState().notice).toBeNull();
  });
});
