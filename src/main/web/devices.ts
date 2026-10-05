import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../storage/paths";

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
const LAST_SEEN_PERSIST_INTERVAL_MS = 60 * 1000;
const SECRET_BYTES = 32;

export type PairedDevice = {
  id: string;
  label: string;
  keyHash: string;
  createdAt: number;
  lastSeenAt: number;
};

export type DeviceStore = {
  createPairingToken(now: number): { token: string; expiresAt: number };
  redeemPairingToken(
    token: string,
    label: string,
    now: number,
  ): Promise<{ deviceKey: string; device: PairedDevice } | null>;
  findByKey(deviceKey: string): PairedDevice | undefined;
  touch(deviceId: string, now: number): Promise<void>;
  remove(deviceId: string): Promise<boolean>;
  list(): PairedDevice[];
};

const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isPairedDevice(value: unknown): value is PairedDevice {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.keyHash === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.lastSeenAt === "number"
  );
}

async function readDevices(filePath: string): Promise<PairedDevice[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter(isPairedDevice) : [];
  } catch {
    return [];
  }
}

export async function loadDeviceStore(
  filePath: string,
  write: (path: string, contents: string) => Promise<void> = atomicWriteFile,
): Promise<DeviceStore> {
  let devices = await readDevices(filePath);
  const tokens = new Map<string, number>();
  let writes: Promise<void> = Promise.resolve();

  const writeCurrent = (): Promise<void> => write(filePath, JSON.stringify(devices, null, 2));
  const persist = (): Promise<void> => {
    const run = writes.then(writeCurrent, writeCurrent);
    writes = run.catch(() => undefined);
    return run;
  };

  return {
    createPairingToken(now) {
      const token = randomBytes(SECRET_BYTES).toString("hex");
      const expiresAt = now + PAIRING_TOKEN_TTL_MS;
      tokens.set(hashSecret(token), expiresAt);
      return { token, expiresAt };
    },
    async redeemPairingToken(token, label, now) {
      const tokenHash = hashSecret(token);
      const expiresAt = tokens.get(tokenHash);
      tokens.delete(tokenHash);
      if (expiresAt === undefined || now > expiresAt) return null;
      const deviceKey = randomBytes(SECRET_BYTES).toString("base64url");
      const device: PairedDevice = {
        id: randomBytes(8).toString("hex"),
        label,
        keyHash: hashSecret(deviceKey),
        createdAt: now,
        lastSeenAt: now,
      };
      devices = [...devices, device];
      await persist();
      return { deviceKey, device };
    },
    findByKey(deviceKey) {
      const keyHash = hashSecret(deviceKey);
      return devices.find((device) => sameHash(device.keyHash, keyHash));
    },
    async touch(deviceId, now) {
      const device = devices.find((d) => d.id === deviceId);
      if (!device || now - device.lastSeenAt < LAST_SEEN_PERSIST_INTERVAL_MS) return;
      devices = devices.map((d) => (d.id === deviceId ? { ...d, lastSeenAt: now } : d));
      await persist();
    },
    async remove(deviceId) {
      const remaining = devices.filter((d) => d.id !== deviceId);
      if (remaining.length === devices.length) return false;
      devices = remaining;
      await persist();
      return true;
    },
    list: () => devices.map((device) => ({ ...device })),
  };
}

const OS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Macintosh|Mac OS X/, "Mac"],
  [/Linux/, "Linux"],
];

const BROWSER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//, "Edge"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const os = OS_PATTERNS.find(([pattern]) => pattern.test(ua))?.[1];
  const browser = BROWSER_PATTERNS.find(([pattern]) => pattern.test(ua))?.[1];
  if (!os) return "Unknown device";
  return browser ? `${browser} on ${os}` : os;
}
