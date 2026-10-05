// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { checkRequest, readCookie } from "./security.ts";

const CTX = {
  expectedHost: "my-mac.tail1234.ts.net",
  ownerLogin: "me@example.com",
  isPairedDevice: (key) => key === "good-key",
};

const ok = {
  method: "GET",
  path: "/",
  host: "my-mac.tail1234.ts.net",
  origin: undefined,
  tailscaleLogin: "me@example.com",
  deviceKey: "good-key",
  isUpgrade: false,
};
const post = { ...ok, method: "POST", path: "/api/canvases:list", origin: "https://my-mac.tail1234.ts.net" };

describe("checkRequest", () => {
  test.each([
    ["a paired GET", ok, { ok: true }],
    ["a paired same-origin POST", post, { ok: true }],
    ["a paired same-origin WebSocket", { ...post, method: "GET", path: "/ws", isUpgrade: true }, { ok: true }],
    ["the pairing link without a cookie", { ...ok, path: "/pair", deviceKey: undefined }, { ok: true }],
    ["a wrong Host (DNS rebinding)", { ...ok, host: "evil.example" }, { ok: false, status: 403, reason: "bad-host" }],
    ["a missing Host", { ...ok, host: undefined }, { ok: false, status: 403, reason: "bad-host" }],
    ["another Tailscale user", { ...ok, tailscaleLogin: "friend@example.com" }, { ok: false, status: 403, reason: "not-owner" }],
    ["no Tailscale identity (not via Serve)", { ...ok, tailscaleLogin: undefined }, { ok: false, status: 403, reason: "not-owner" }],
    ["an unpaired device", { ...ok, deviceKey: undefined }, { ok: false, status: 401, reason: "not-paired" }],
    ["a revoked device key", { ...ok, deviceKey: "old-key" }, { ok: false, status: 401, reason: "not-paired" }],
    ["a POST from another site", { ...post, origin: "https://evil.example" }, { ok: false, status: 403, reason: "bad-origin" }],
    ["a POST with no Origin", { ...post, origin: undefined }, { ok: false, status: 403, reason: "bad-origin" }],
    ["a WebSocket from another site", { ...ok, path: "/ws", isUpgrade: true, origin: "https://evil.example" }, { ok: false, status: 403, reason: "bad-origin" }],
    ["a same-origin POST to the pairing path without a cookie", { ...post, path: "/pair", deviceKey: undefined }, { ok: true }],
    ["a POST to the pairing path with no Origin", { ...post, path: "/pair", origin: undefined, deviceKey: undefined }, { ok: false, status: 403, reason: "bad-origin" }],
    ["a POST to the pairing path from another site", { ...post, path: "/pair", origin: "https://evil.example", deviceKey: undefined }, { ok: false, status: 403, reason: "bad-origin" }],
  ])("%s", (_label, req, expected) => {
    expect(checkRequest(req, CTX)).toEqual(expected);
  });

  test.each([
    ["a PUT with no Origin", { ...post, method: "PUT", origin: undefined }, { ok: false, status: 403, reason: "bad-origin" }],
    ["a DELETE with no Origin", { ...post, method: "DELETE", origin: undefined }, { ok: false, status: 403, reason: "bad-origin" }],
    ["a WebSocket to the pairing path without a cookie", { ...post, method: "GET", path: "/pair", isUpgrade: true, deviceKey: undefined }, { ok: false, status: 401, reason: "not-paired" }],
    ["a HEAD of the pairing path with no Origin", { ...ok, method: "HEAD", path: "/pair", deviceKey: undefined }, { ok: false, status: 403, reason: "bad-origin" }],
    ["a same-origin HEAD of the pairing path without a cookie", { ...post, method: "HEAD", path: "/pair", deviceKey: undefined }, { ok: false, status: 401, reason: "not-paired" }],
  ])("fails closed: %s", (_label, req, expected) => {
    expect(checkRequest(req, CTX)).toEqual(expected);
  });

  test.each([
    ["no expected host, request has none", { ...CTX, expectedHost: "" }, { ...ok, host: "" }, "bad-host"],
    ["no expected host, request names one", { ...CTX, expectedHost: "" }, ok, "bad-host"],
    ["no owner, request has none", { ...CTX, ownerLogin: "" }, { ...ok, tailscaleLogin: "" }, "not-owner"],
    ["no owner, request names one", { ...CTX, ownerLogin: "" }, ok, "not-owner"],
  ])("fails closed with an empty context: %s", (_label, ctx, req, reason) => {
    expect(checkRequest(req, ctx)).toEqual({ ok: false, status: 403, reason });
  });

  test("host comparison ignores case", () => {
    expect(checkRequest({ ...ok, host: "MY-MAC.tail1234.ts.net" }, CTX)).toEqual({ ok: true });
  });
});

describe("readCookie", () => {
  test("finds a cookie among others and decodes it", () => {
    expect(readCookie("a=1; lmc_device=abc%3D; b=2", "lmc_device")).toBe("abc=");
  });
  test("returns undefined when absent", () => {
    expect(readCookie("a=1", "lmc_device")).toBeUndefined();
    expect(readCookie(undefined, "lmc_device")).toBeUndefined();
  });
  test("returns undefined for a malformed value instead of throwing", () => {
    expect(readCookie("lmc_device=%", "lmc_device")).toBeUndefined();
    expect(readCookie("lmc_device=%ZZ", "lmc_device")).toBeUndefined();
    expect(readCookie("a=1; lmc_device=%E0%A4%A", "lmc_device")).toBeUndefined();
    expect(readCookie("x=%; lmc_device=good", "lmc_device")).toBe("good");
  });
});
