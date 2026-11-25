// Provider-aware evidence base: the stored-bytes checks must fetch from the
// serving miner's registry base_url, guarded against SSRF and redirects,
// bounded in time and size, defaulting to our own miner. Each guard has a
// test whose mutant goes RED.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVIDENCE_RAW_MAX_BYTES, evidenceBaseUrlDefect, evidenceBaseJoin, verifyPurchase } from "../src/verify";
import { MINER_BASE_URL } from "../src/constants";

const fx = (n: string) => join(__dirname, "fixtures", n);
const signal = JSON.parse(readFileSync(fx("signal-m12-caiso.json"), "utf8"));
const raw = readFileSync(fx("raw-rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR.bin"));
const meta = readFileSync(fx("meta-rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR.json"), "utf8");
const paid = JSON.parse(readFileSync(fx("paid-m12-caiso.json"), "utf8"));
const PAYER = "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3";
const input = { payer: PAYER, minerSlug: "verireceipt", signalHash: paid.body.signal_hash, valueField: "lmp_usd_per_mwh", engineResult: paid.body.result, intent: "GRID_POWER_PRICE_GENERAL" };

function spyFetch(over: { redirect302?: boolean; rawBytes?: Uint8Array } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/engine/v1/signal/")) return new Response(JSON.stringify(signal), { status: 200 });
    // Emulate undici: with redirect:"error" a 302 rejects; without it a 302 comes back.
    if (over.redirect302 && url.includes("/receipts/")) {
      if (init?.redirect === "error") throw new TypeError("fetch failed: redirect mode is set to error");
      return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
    }
    if (url.endsWith("/raw")) return new Response(over.rawBytes ?? raw, { status: 200 });
    if (url.includes("/receipts/")) return new Response(meta, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("evidenceBaseUrlDefect", () => {
  it("accepts an https DNS name, with or without an explicit 443", () => {
    expect(evidenceBaseUrlDefect("https://telegraph-assist.margyn.workers.dev")).toBeNull();
    expect(evidenceBaseUrlDefect("https://miner.example:443/api")).toBeNull();
    expect(evidenceBaseUrlDefect(MINER_BASE_URL)).toBeNull();
  });
  it.each([
    ["http scheme", "http://miner.example", /scheme must be https/],
    ["localhost", "https://localhost:8443", /local name|port/],
    ["localhost with trailing dot", "https://localhost./", /local name/],
    ["subdomain of localhost with trailing dot", "https://x.localhost./", /local name/],
    ["subdomain of localhost", "https://x.localhost", /local name/],
    [".local", "https://printer.local", /local name/],
    [".internal", "https://x.internal", /local name/],
    [".localdomain", "https://x.localdomain", /local name/],
    ["single label", "https://intranet", /at least two labels/],
    ["loopback v4", "https://127.0.0.1", /IP literal/],
    ["short v4 (127.1 normalizes to 127.0.0.1)", "https://127.1", /IP literal/],
    ["decimal v4 (2130706433 normalizes to 127.0.0.1)", "https://2130706433", /IP literal/],
    ["hex IPv4 (normalized by URL parsing)", "https://0x7f.1", /IP literal/],
    ["private v4 (10/8)", "https://10.0.0.5", /IP literal/],
    ["private v4 (172.16/12)", "https://172.16.0.9", /IP literal/],
    ["private v4 (192.168/16)", "https://192.168.1.1", /IP literal/],
    ["link-local v4", "https://169.254.169.254", /IP literal/],
    ["loopback v6", "https://[::1]/", /IP literal/],
    ["v4-mapped v6", "https://[::ffff:127.0.0.1]/", /IP literal/],
    ["non-443 port", "https://miner.example:8443", /port must be 443/],
    ["query", "https://miner.example/?x=1", /query or fragment/],
    ["fragment", "https://miner.example/#f", /query or fragment/],
    ["credentials", "https://user:pass@miner.example", /credentials/],
    ["not a URL", "not a url", /not a URL/],
    ["empty", "", /non-empty/],
  ])("rejects %s", (_label, base, re) => {
    expect(evidenceBaseUrlDefect(base)).toMatch(re);
  });
});

describe("evidenceBaseJoin", () => {
  it("origin plus normalized path, exactly one slash when joined", () => {
    expect(evidenceBaseJoin("https://miner.example")).toBe("https://miner.example");
    expect(evidenceBaseJoin("https://miner.example/")).toBe("https://miner.example");
    expect(evidenceBaseJoin("https://miner.example/api/")).toBe("https://miner.example/api");
    expect(`${evidenceBaseJoin("https://miner.example/api/")}/receipts/r1`).toBe("https://miner.example/api/receipts/r1");
  });
});

describe("verifyPurchase evidence base", () => {
  it("fetches stored evidence from the serving provider's registry base_url", async () => {
    const { f, calls } = spyFetch();
    const v = await verifyPurchase({ ...input, minerBaseUrl: "https://miner-a.example" }, f);
    expect(v.verified).toBe(true);
    const receiptFetches = calls.filter((c) => c.url.includes("/receipts/"));
    expect(receiptFetches.length).toBe(2);
    for (const c of receiptFetches) expect(c.url.startsWith("https://miner-a.example/receipts/")).toBe(true);
  });
  it("defaults to our own miner's evidence base when none is given", async () => {
    const { f, calls } = spyFetch();
    const v = await verifyPurchase(input, f);
    expect(v.verified).toBe(true);
    for (const c of calls.filter((x) => x.url.includes("/receipts/"))) expect(c.url.startsWith(`${MINER_BASE_URL}/receipts/`)).toBe(true);
  });
  it("fails verification on an invalid base URL and never fetches evidence from it", async () => {
    const { f, calls } = spyFetch();
    const v = await verifyPurchase({ ...input, minerBaseUrl: "https://169.254.169.254/latest" }, f);
    expect(v.verified).toBe(false);
    const check = v.checks.find((c) => c.name === "evidence base URL")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/IP literal/);
    expect(calls.some((c) => c.url.includes("/receipts/"))).toBe(false);
  });
  it("issues both evidence fetches with redirect:error and a timeout signal; a 302 fails verification", async () => {
    const { f, calls } = spyFetch({ redirect302: true });
    const v = await verifyPurchase({ ...input, minerBaseUrl: "https://miner-a.example" }, f);
    expect(v.verified).toBe(false);
    // RED on the mutant that drops redirect:"error": the stub then returns the
    // 302 and the failing detail reads "HTTP 302" instead of the fetch failure.
    const check = v.checks.find((c) => c.name === "stored receipt metadata agrees")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/fetch failed/);
    for (const c of calls.filter((x) => x.url.includes("/receipts/"))) {
      expect(c.init?.redirect).toBe("error");
      expect(c.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it("fails verification when the raw bytes exceed the size cap", async () => {
    const big = new Uint8Array(EVIDENCE_RAW_MAX_BYTES + 1);
    const { f } = spyFetch({ rawBytes: big });
    const v = await verifyPurchase({ ...input, minerBaseUrl: "https://miner-a.example" }, f);
    expect(v.verified).toBe(false);
    const check = v.checks.find((c) => c.name === "stored raw bytes within size cap")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/exceeds/);
  });
});
