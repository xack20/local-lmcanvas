// .mjs keeps the bun:test import out of `bun run typecheck`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAIRING_TOKEN_TTL_MS, deviceLabel, loadDeviceStore } from "./devices.ts";

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lmc-devices-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fileFor = (name) => join(dir, `${name}.json`);

describe("loadDeviceStore", () => {
  test("pairs a device once and recognises its key; only a hash is stored", async () => {
    const file = fileFor("pair");
    const store = await loadDeviceStore(file);
    const { token } = store.createPairingToken(1000);
    const paired = await store.redeemPairingToken(token, "Chrome on Windows", 2000);
    expect(paired.device.label).toBe("Chrome on Windows");
    expect(store.findByKey(paired.deviceKey).id).toBe(paired.device.id);
    expect(store.findByKey("not-a-key")).toBeUndefined();
    const saved = readFileSync(file, "utf-8");
    expect(saved).not.toContain(paired.deviceKey);
    expect(saved).toContain(paired.device.keyHash);
    expect(await store.redeemPairingToken(token, "again", 3000)).toBeNull();
  });

  test("refuses expired and unknown tokens", async () => {
    const store = await loadDeviceStore(fileFor("expired"));
    const { token, expiresAt } = store.createPairingToken(0);
    expect(expiresAt).toBe(PAIRING_TOKEN_TTL_MS);
    expect(await store.redeemPairingToken(token, "late", PAIRING_TOKEN_TTL_MS + 1)).toBeNull();
    expect(await store.redeemPairingToken("made-up", "x", 1)).toBeNull();
  });

  test("removing a device revokes its key and persists", async () => {
    const file = fileFor("remove");
    const store = await loadDeviceStore(file);
    const { token } = store.createPairingToken(0);
    const { deviceKey, device } = await store.redeemPairingToken(token, "x", 1);
    expect(await store.remove(device.id)).toBe(true);
    expect(await store.remove(device.id)).toBe(false);
    expect(store.findByKey(deviceKey)).toBeUndefined();
    expect((await loadDeviceStore(file)).list()).toEqual([]);
  });

  test("reloads paired devices from disk", async () => {
    const file = fileFor("reload");
    const first = await loadDeviceStore(file);
    const { token } = first.createPairingToken(0);
    const { deviceKey } = await first.redeemPairingToken(token, "Firefox on Linux", 1);
    const second = await loadDeviceStore(file);
    expect(second.findByKey(deviceKey).label).toBe("Firefox on Linux");
  });

  test("touch records last-seen at most once a minute", async () => {
    const store = await loadDeviceStore(fileFor("touch"));
    const { token } = store.createPairingToken(0);
    const { device } = await store.redeemPairingToken(token, "x", 1_000);
    await store.touch(device.id, 30_000);
    expect(store.list()[0].lastSeenAt).toBe(1_000);
    await store.touch(device.id, 70_000);
    expect(store.list()[0].lastSeenAt).toBe(70_000);
  });

  test("a damaged file loads as no devices", async () => {
    const file = fileFor("damaged");
    writeFileSync(file, "{not json");
    expect((await loadDeviceStore(file)).list()).toEqual([]);
  });

  test("a slow earlier write cannot resurrect a removed device", async () => {
    const file = fileFor("serialize");
    let releaseWrite;
    const writePromise = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    let writeCount = 0;
    const delayedWriter = async (path, contents) => {
      writeCount++;
      if (writeCount === 2) {
        await writePromise;
      }
      return writeFile(path, contents);
    };

    const store = await loadDeviceStore(file, delayedWriter);
    const { token } = store.createPairingToken(0);
    const { deviceKey, device } = await store.redeemPairingToken(token, "x", 1_000);

    store.touch(device.id, 70_000);
    const removePromise = store.remove(device.id);

    releaseWrite();
    await removePromise;

    const reloaded = await loadDeviceStore(file);
    expect(reloaded.findByKey(deviceKey)).toBeUndefined();
  });
});

describe("deviceLabel", () => {
  test.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36", "Chrome on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    [undefined, "Unknown device"],
  ])("labels %s as %s", (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });
});
