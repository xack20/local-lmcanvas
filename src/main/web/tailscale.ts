import { execFile } from "node:child_process";

export const TAILSCALE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const EXEC_TIMEOUT_MS = 15_000;

export type TailscaleInfo = {
  running: boolean;
  host: string | null;
  ownerLogin: string | null;
  httpsAvailable: boolean;
};

/** `funnel`: HTTPS on this host is shared publicly (Tailscale Funnel), not just with the tailnet. */
export type ServeState = { httpsInUse: boolean; proxiesTo: string | null; funnel: boolean };
export type Exec = (args: readonly string[]) => Promise<string>;

export type TailscaleControl = {
  info(): Promise<TailscaleInfo>;
  serveState(host: string): Promise<ServeState>;
  enableServe(port: number): Promise<void>;
  disableServe(): Promise<void>;
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function parseStatus(raw: unknown): TailscaleInfo {
  const status = asObject(raw);
  const self = asObject(status?.Self);
  const dnsName =
    typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  const owner = asObject(asObject(status?.User)?.[String(self?.UserID)]);
  const rawCerts = status?.CertDomains;
  const certDomains: unknown[] = Array.isArray(rawCerts) ? rawCerts : [];
  return {
    running: status?.BackendState === "Running",
    host: dnsName || null,
    ownerLogin: typeof owner?.LoginName === "string" ? owner.LoginName : null,
    httpsAvailable:
      dnsName !== "" &&
      certDomains.some((domain) => typeof domain === "string" && domain.toLowerCase() === dnsName),
  };
}

export function parseServeStatus(raw: unknown, host: string): ServeState {
  const config = asObject(raw);
  const httpsInUse = asObject(config?.TCP)?.["443"] !== undefined;
  const site = asObject(asObject(config?.Web)?.[`${host}:443`]);
  const root = asObject(asObject(site?.Handlers)?.["/"]);
  const funnel = asObject(config?.AllowFunnel)?.[`${host}:443`] === true;
  return { httpsInUse, proxiesTo: typeof root?.Proxy === "string" ? root.Proxy : null, funnel };
}

export const serveTarget = (port: number): string => `http://127.0.0.1:${port}`;
export const serveEnableArgs = (port: number): string[] => [
  "serve",
  "--bg",
  "--https=443",
  serveTarget(port),
];
export const serveDisableArgs = (): string[] => ["serve", "--https=443", "off"];

export const execTailscale: Exec = (args) =>
  new Promise((resolve, reject) => {
    execFile(TAILSCALE_CLI, [...args], { timeout: EXEC_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

export function createTailscale(exec: Exec = execTailscale): TailscaleControl {
  const run = async (args: readonly string[]): Promise<string> => {
    if (args.includes("funnel")) throw new Error("Refusing to run tailscale funnel");
    return exec(args);
  };
  return {
    async info() {
      return parseStatus(JSON.parse(await run(["status", "--json"])));
    },
    async serveState(host) {
      return parseServeStatus(JSON.parse(await run(["serve", "status", "--json"])), host);
    },
    async enableServe(port) {
      await run(serveEnableArgs(port));
    },
    async disableServe() {
      await run(serveDisableArgs());
    },
  };
}
