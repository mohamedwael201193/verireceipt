import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/api-health-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); __setLookupForTests(null); });
import { handleApiHealth } from "../src/handlers/apiHealth";
import { handleServerUptime } from "../src/handlers/serverUptime";
import { guardPublicHttpUrl, __setLookupForTests } from "../src/handlers/ssrfGuard";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
type Lookup = typeof import("node:dns/promises").lookup;
function fakeDns(table: Record<string, string[] | null>): void {
  const fn = (async (host: string, opts?: unknown) => {
    const addrs = table[host];
    if (!addrs) throw new Error("ENOTFOUND");
    if (opts && (opts as { all?: boolean }).all) return addrs.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
    return { address: addrs[0], family: 4 };
  }) as unknown as Lookup;
  __setLookupForTests(fn);
}
function stubFetch(status: number | "ABORT" | "FAIL", latencyMs = 5): void {
  vi.stubGlobal("fetch", async () => {
    await new Promise((r) => setTimeout(r, latencyMs));
    if (status === "ABORT") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    if (status === "FAIL") throw new Error("connect ECONNREFUSED");
    return new Response("ok", { status });
  });
}
describe("SSRF guard", () => {
  it("blocks private, loopback, link-local, metadata and internal names before any fetch", async () => {
    fakeDns({
      "internal.example.com": ["10.1.2.3"],
      "rebind.example.com": ["93.184.216.34", "169.254.169.254"], // mixed: rebinding refusal
      "metadata.example.com": ["169.254.169.254"],
    });
    for (const t of ["localhost", "foo.localhost", "db.internal", "10.0.0.1", "192.168.0.1", "127.0.0.1", "169.254.169.254", "100.64.1.1", "192.0.2.4"]) {
      await expect(guardPublicHttpUrl(t, "url")).rejects.toMatchObject({ status: 422 });
    }
    await expect(guardPublicHttpUrl("internal.example.com", "url")).rejects.toMatchObject({ code: "PRIVATE_HOST" });
    await expect(guardPublicHttpUrl("rebind.example.com", "url")).rejects.toMatchObject({ code: "PRIVATE_HOST" });
    await expect(guardPublicHttpUrl("metadata.example.com", "url")).rejects.toMatchObject({ code: "PRIVATE_HOST" });
    await expect(guardPublicHttpUrl("gone.example.com", "url")).rejects.toMatchObject({ code: "DNS_UNRESOLVABLE" });
  });
  it("rejects credentials, non-http schemes and non-80/443 ports", async () => {
    await expect(guardPublicHttpUrl("ftp://example.com", "url")).rejects.toMatchObject({ code: "BAD_SCHEME" });
    await expect(guardPublicHttpUrl("https://user:pw@example.com", "url")).rejects.toMatchObject({ code: "BAD_URL" });
    fakeDns({ "example.com": ["93.184.216.34"] });
    await expect(guardPublicHttpUrl("https://example.com:22", "url")).rejects.toMatchObject({ code: "PORT_NOT_CHECKED" });
  });
  it("rate-limits a repeated target", async () => {
    fakeDns({ "example.com": ["93.184.216.34"] });
    await guardPublicHttpUrl("https://example.com", "url");
    await expect(guardPublicHttpUrl("https://example.com", "url")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
describe("API_HEALTH_CHECK_GENERAL", () => {
  it("serves only what was measured, with honest vantage wording", async () => {
    fakeDns({ "example.com": ["93.184.216.34"] });
    stubFetch(200);
    const result = await handleApiHealth({ url: "https://example.com/api" });
    expect(result.healthy).toBe(true);
    expect(result.http_status).toBe(200);
    expect(Number(result.latency_ms)).toBeGreaterThanOrEqual(0);
    const ans = String(result.answer);
    expect(ans).toContain("measured once from this server");
    expect(ans).toContain("not a global-availability");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("API_HEALTH_CHECK_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const ev = JSON.parse(stored.evidence.toString("utf8"));
    expect(ev.resolved_addresses).toEqual(["93.184.216.34"]);
  });
  it("a 503 is reachable but unhealthy; a timeout is unreachable; neither is hidden", async () => {
    fakeDns({ "a.example.com": ["93.184.216.34"], "b.example.com": ["93.184.216.34"] });
    stubFetch(503);
    const r1 = await handleApiHealth({ url: "https://a.example.com" });
    expect(r1.healthy).toBe(false);
    expect(r1.reachable).toBe(true);
    vi.unstubAllGlobals();
    stubFetch("ABORT");
    const r2 = await handleApiHealth({ url: "https://b.example.com" });
    expect(r2.reachable).toBe(false);
    expect(String(r2.answer)).toContain("may be reachable from elsewhere");
  });
});
describe("SERVER_UPTIME_MONITOR_GENERAL", () => {
  it("is point-in-time reachability, never an uptime percentage", async () => {
    fakeDns({ "example.com": ["93.184.216.34"] });
    stubFetch(200);
    const result = await handleServerUptime({ host: "example.com" });
    expect(result.reachable_now).toBe(true);
    expect(String(result.answer)).toContain("not an uptime percentage or history");
    const receipt = result.receipt as { intent: string };
    expect(receipt.intent).toBe("SERVER_UPTIME_MONITOR_GENERAL");
  });
  it("a connect failure is reported as unmeasured-down, from one vantage", async () => {
    fakeDns({ "down.example.com": ["93.184.216.34"] });
    stubFetch("FAIL");
    const result = await handleServerUptime({ host: "down.example.com" });
    expect(result.reachable_now).toBe(false);
    expect(String(result.answer)).toContain("may be up and reachable from elsewhere");
  });
});
describe("routes", () => {
  it("GET /v1/api-health and /v1/server-uptime are wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/api-health" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/v1/server-uptime" })).toBe(true);
    await app.close();
  });
});
