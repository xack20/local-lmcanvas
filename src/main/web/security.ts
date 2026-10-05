export type GateRequest = {
  method: string;
  path: string;
  host: string | undefined;
  origin: string | undefined;
  tailscaleLogin: string | undefined;
  deviceKey: string | undefined;
  isUpgrade: boolean;
};

export type GateContext = {
  expectedHost: string;
  ownerLogin: string;
  isPairedDevice: (deviceKey: string) => boolean;
};

export type GateResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

const PAIR_PATH = "/pair";

export function checkRequest(req: GateRequest, ctx: GateContext): GateResult {
  if (!req.host || req.host.toLowerCase() !== ctx.expectedHost.toLowerCase()) {
    return { ok: false, status: 403, reason: "bad-host" };
  }
  if (!req.tailscaleLogin || req.tailscaleLogin !== ctx.ownerLogin) {
    return { ok: false, status: 403, reason: "not-owner" };
  }
  const changesState = req.isUpgrade || req.method !== "GET";
  if (changesState && req.origin !== `https://${ctx.expectedHost.toLowerCase()}`) {
    return { ok: false, status: 403, reason: "bad-origin" };
  }
  if (req.method === "GET" && !req.isUpgrade && req.path === PAIR_PATH) return { ok: true };
  if (!req.deviceKey || !ctx.isPairedDevice(req.deviceKey)) {
    return { ok: false, status: 401, reason: "not-paired" };
  }
  return { ok: true };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
