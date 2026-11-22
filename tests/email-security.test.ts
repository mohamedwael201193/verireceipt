// Archived public DNS bodies are real. Constructed failure responses below are test-only.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const scratch = mkdtempSync(join(tmpdir(), "vr-email-security-"));
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
import { handleEmailSecurity, normalizeEmailDnsName, normalizeEmailDnsType, parseEmailDnsStatus } from "../src/handlers/emailSecurity";
import { getReceiptEvidence, closeStorage } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
import { exactQuery } from "../src/core/exactQuery";
import { buildServer } from "../src/server";
import { requestMetricsSnapshot, resetRequestMetricsForTests } from "../src/core/requestMetrics";
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/email-security", name), "utf8");
const google = () => fixture("dns-google-nodata.json");
const cloudflare = () => fixture("dns-cloudflare-nodata-exact-accept.json");
function twoBodies(a = google(), b = cloudflare()) {
  const mock = vi.fn<typeof fetch>(async (input) => new Response(String(input).includes("dns.google") ? a : b));
  vi.stubGlobal("fetch", mock); return mock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => { await closeStorage(); rmSync(scratch, { recursive: true, force: true }); });
describe("EMAIL_SECURITY_GENERAL normalization and exact query validation", () => {
  it.each(["_dmarc.Example.COM.", "mail._domainkey.example.com", "bücher.example", ".", "example.com", "123", "foo.123", "001.002.003.004"])("accepts DNS owner %s", (name) => {
    expect(normalizeEmailDnsName(name)).toBeTruthy();
  });
  it("never rewrites numeric owner names as IPv4 shorthand", () => {
    expect(normalizeEmailDnsName("123")).toBe("123");
    expect(normalizeEmailDnsName("foo.123")).toBe("foo.123");
    expect(normalizeEmailDnsName("001.002.003.004")).toBe("001.002.003.004");
    expect(normalizeEmailDnsName("bücher.example")).toBe("xn--bcher-kva.example");
    expect(normalizeEmailDnsName("example.com。 ")).toBe("example.com");
  });
  it.each(["https://example.com", "a@example.com", "a..com", "example.com/path", "x%2ecom", "-x.com", "a".repeat(64)+".com"])("rejects non-owner %s", (name) => {
    expect(() => normalizeEmailDnsName(name)).toThrow();
  });
  it.each(["MX", "txt", "DNSKEY", "HTTPS", "CAA", "TYPE65280", "15", "ANY", "*"])("accepts type %s", (type) => expect(normalizeEmailDnsType(type)).toBeTruthy());
  it.each(["0", "65536", "1.1", "BOGUS_TYPE", "constructor", "__proto__", "MX&name=evil"])("rejects type %s", (type) => expect(() => normalizeEmailDnsType(type)).toThrow());
  it("does not silently select a duplicate, unknown, case-variant or prototype query key", () => {
    for (const query of ["domain=x&domain=y", "domain=x&token=secret", "Domain=x", "__proto__=x", "constructor=x", "%64omain=x&domain=y"]) {
      expect(() => exactQuery("/v1/email-security?"+query, ["domain", "record_type"])).toThrow();
    }
  });
});
describe("EMAIL_SECURITY_GENERAL evidence and failure policy", () => {
  it("does not mistake real NOERROR/CNAME-only bodies for missing MX records", async () => {
    const mock = twoBodies(); const result = await handleEmailSecurity({ domain: "www.iana.org.", record_type: "mx" });
    expect(result.lookup_ok).toBe(true); expect(result.answer).toContain("not record presence");
    expect(mock).toHaveBeenCalledTimes(2); expect(String(mock.mock.calls[0][0])).toContain("type=15");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; fetched_at: string };
    const stored = await getReceiptEvidence(receipt.receipt_id); expect(stored).not.toBeNull();
    const bytes = stored?.evidence; if (!bytes) throw new Error("receipt evidence missing");
    expect(sha256Hex(bytes)).toBe(receipt.raw_response_sha256);
    const evidence = JSON.parse(bytes.toString("utf8")); expect(evidence.observations.map((row: { raw_body: string }) => row.raw_body)).toEqual([google(), cloudflare()]);
    expect(receipt.fetched_at).toBe(evidence.observations[0].fetched_at);
  });
  it("returns false for actual NXDOMAIN, not an HTTP failure", async () => {
    const raw = fixture("dns-google-reserved-invalid.json"); twoBodies(raw, raw);
    expect((await handleEmailSecurity({ domain: "verireceipt-probe.invalid", record_type: "MX" })).lookup_ok).toBe(false);
  });
  it("returns false for actual DNSSEC SERVFAIL and preserves its status", async () => {
    const raw = fixture("dns-google-dnssec.json"); twoBodies(raw, raw);
    const result = await handleEmailSecurity({ domain: "dnssec-failed.org", record_type: "A" });
    expect(result.lookup_ok).toBe(false); expect(result.answer).toContain("DNS Status 2");
  });
  it("refuses a positive/negative split instead of averaging it", async () => {
    const negative = JSON.parse(cloudflare()); negative.Status = 3; twoBodies(google(), JSON.stringify(negative));
    await expect(handleEmailSecurity({ domain: "www.iana.org", record_type: "MX" })).rejects.toMatchObject({ code: "EMAIL_DNS_STATUS_DISAGREEMENT" });
  });
  it("does not coerce string, absent, fractional or negative DNS statuses", () => {
    for (const Status of ["0", undefined, 0.5, -1, null, 4096]) {
      const data = JSON.parse(google()); data.Status = Status;
      expect(() => parseEmailDnsStatus(JSON.stringify(data), "www.iana.org", "MX")).toThrow();
    }
  });
  it("rejects mismatched DNS question name and type, including types beyond the old ten", () => {
    expect(() => parseEmailDnsStatus(google(), "example.com", "MX")).toThrow();
    expect(() => parseEmailDnsStatus(google(), "www.iana.org", "DNSKEY")).toThrow();
  });
  it("keeps DNS status separate from a valid truncated response", () => {
    const data = JSON.parse(google()); data.TC = true;
    expect(parseEmailDnsStatus(JSON.stringify(data), "www.iana.org", "MX")).toEqual({ status: 0, truncated: true });
  });
  it("never converts a total HTTP failure into lookup_ok=false", async () => {
    vi.stubGlobal("fetch", async () => new Response("failure", { status: 503 }));
    await expect(handleEmailSecurity({ domain: "www.iana.org", record_type: "MX" })).rejects.toMatchObject({ code: "EMAIL_DNS_SOURCES_DOWN" });
  });
  it("bounds a stalled leg below one second and labels one-source coverage", async () => {
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", async (input: string) => String(input).includes("dns.google") ? new Response(google()) : new Promise<Response>((resolve) => { release = resolve; }));
    const start = performance.now();
    const result = await handleEmailSecurity({ domain: "www.iana.org", record_type: "MX" });
    expect(performance.now()-start).toBeLessThan(1250); expect(result.lookup_ok).toBe(true); expect(result.answer).toContain("coverage is degraded");
    release(new Response(cloudflare())); await new Promise(setImmediate);
  });
  it("rejects invalid input before any source access", async () => {
    const mock=twoBodies(); await expect(handleEmailSecurity({ domain: "https://evil.invalid", record_type: "MX" })).rejects.toMatchObject({ status: 400 }); expect(mock).not.toHaveBeenCalled();
  });
});
describe("HTTP route and privacy-safe observability", () => {
  it("counts successful/error requests without retaining query values or unknown paths", async () => {
    resetRequestMetricsForTests(); twoBodies(); const logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const app = buildServer();
    try {
      expect((await app.inject({ method: "GET", url: "/v1/email-security?domain=www.iana.org&record_type=MX" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/v1/email-security?domain=PRIVATE_SENTINEL&record_type=MX&token=PRIVATE_SECRET" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/PRIVATE_PATH_SENTINEL" })).statusCode).toBe(404);
      const metrics = requestMetricsSnapshot(); const serialized = JSON.stringify({ metrics, logs: logs.mock.calls });
      expect(serialized).not.toContain("PRIVATE"); expect(serialized).not.toContain("www.iana.org"); expect(serialized).not.toContain("domain=");
      expect(metrics.EMAIL_SECURITY_GENERAL).toMatchObject({ arrived: 2, completed: 2, in_flight: 0, statuses: { "200": 1, "400": 1 } });
      const health = (await app.inject({ method: "GET", url: "/health" })).json(); expect(health.requests.EMAIL_SECURITY_GENERAL.completed).toBe(2);
    } finally { await app.close(); }
  });
});
