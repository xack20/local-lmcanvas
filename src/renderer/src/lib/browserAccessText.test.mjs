// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { formatExpiry, formatLastSeen, pairingHint, pairingToShow, statusLine } from "./browserAccessText.ts";

const base = { enabled: false, running: false, keepAwake: true, url: null, problem: null, devices: [] };

describe("statusLine", () => {
  test.each([
    [{ ...base, enabled: true, running: true, url: "https://my-mac.tail1234.ts.net" }, "On at https://my-mac.tail1234.ts.net"],
    [{ ...base, problem: "Tailscale isn't running." }, "Tailscale isn't running."],
    [{ ...base, enabled: true }, "On, but not running yet."],
    [base, "Off. Only this Mac can use LMCanvas."],
  ])("%o", (status, line) => {
    expect(statusLine(status)).toBe(line);
  });
});

describe("formatExpiry", () => {
  test("counts down in whole minutes", () => {
    expect(formatExpiry(600_000, 0)).toBe("Expires in 10 min");
    expect(formatExpiry(60_000, 30_000)).toBe("Expires in 1 min");
    expect(formatExpiry(1_000, 2_000)).toBe("Expired. Create a new link.");
  });
});

describe("formatLastSeen", () => {
  test("describes recency", () => {
    expect(formatLastSeen(0, 30_000)).toBe("Active now");
    expect(formatLastSeen(0, 3 * 3_600_000)).toBe("Last seen 3 h ago");
    expect(formatLastSeen(0, 2 * 86_400_000)).toBe("Last seen 2 days ago");
  });
});

describe("pairingHint", () => {
  test("tells you to open a live link once on the device", () => {
    expect(pairingHint(600_000, 0)).toBe("Expires in 10 min. Open it once on the device you want to pair.");
  });
  test("an expired link only says to make a new one", () => {
    expect(pairingHint(1_000, 2_000)).toBe("Expired. Create a new link.");
  });
});

describe("pairingToShow", () => {
  const link = { url: "https://my-mac.tail1234.ts.net/pair?token=abc", expiresAt: 600_000 };
  test("keeps the link while access is running", () => {
    expect(pairingToShow({ ...base, running: true }, link)).toBe(link);
  });
  test("drops the link once access stops, since the Mac has voided it", () => {
    expect(pairingToShow(base, link)).toBeNull();
    expect(pairingToShow({ ...base, running: true }, null)).toBeNull();
  });
});
