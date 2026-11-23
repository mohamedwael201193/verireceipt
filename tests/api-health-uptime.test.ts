import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
vi.mock("node:https", async importOriginal => ({ ...await importOriginal<typeof import("node:https")>(), request: vi.fn() }));
vi.mock("node:http", async importOriginal => ({ ...await importOriginal<typeof import("node:http")>(), request: vi.fn() }));
const scratch = mkdtempSync("/tmp/api-health-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); __setLookupForTests(null); });
import { handleApiHealth } from "../src/handlers/apiHealth";
import { handleServerUptime } from "../src/handlers/serverUptime";
import { guardPublicHttpUrl, __setLookupForTests, __clearRateLimitsForTests } from "../src/handlers/ssrfGuard";
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
  vi.mocked(httpsRequest).mockImplementation(((_url: unknown, _options: unknown, response: any) => {
    const request = new EventEmitter() as any;
    request.destroy = vi.fn();
    request.end = () => setTimeout(() => {
      if (status === "ABORT" || status === "FAIL") {
        const error = new Error("connect failed"); if (status === "ABORT") error.name = "AbortError";
        request.emit("error", error);
      } else response({statusCode:status,destroy:vi.fn()});
    }, latencyMs);
    return request;
  }) as any);
}
describe("SSRF guard", () => {
  it("blocks private, loopback, link-local, metadata and internal names before any fetch", async () => {
    fakeDns({
      "internal.example.com": ["10.1.2.3"],
      "rebind.example.com": ["93.184.216.34", "169.254.169.254"], // mixed: rebinding refusal
      "metadata.example.com": ["169.254.169.254"],
    });
    for (const t of ["localhost", "foo.localhost", "db.internal", "10.0.0.1", "192.168.0.1", "127.0.0.1", "169.254.169.254", "100.64.1.1", "192.0.2.4", "https://[::ffff:127.0.0.1]", "https://[2001:db8::1]", "https://[2002:7f00:1::]"]) {
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

describe("SSRF follow-ups (reviewer)", () => {
  it("pins the connect address while preserving the original TLS hostname and stops at redirect headers", async () => {
    fakeDns({ "example.com": ["93.184.216.34"] });
    stubFetch(302);
    const target=await guardPublicHttpUrl("https://example.com/path", "url");
    const { measureGet } = await import("../src/handlers/ssrfGuard");
    const r=await measureGet(target,1000,"test-agent");
    expect(r.status).toBe(302);
    const call=vi.mocked(httpsRequest).mock.calls.at(-1)! as any;
    expect(call[0].hostname).toBe("example.com");
    expect(call[1].agent).toBe(false);
    const callback=vi.fn();call[1].lookup("example.com",{all:true},callback);
    await Promise.resolve();
    expect(callback).toHaveBeenCalledWith(null,[{address:"93.184.216.34",family:4}]);
    // A second lookup can never substitute a private answer after validation.
    const again=vi.fn();call[1].lookup("example.com",{},again);
    await Promise.resolve();
    expect(again).toHaveBeenCalledWith(null,"93.184.216.34",4);
  });
  it("bounds a hung socket with an absolute deadline",async()=>{
    vi.mocked(httpsRequest).mockImplementation((() => {const req=new EventEmitter() as any;req.end=vi.fn();req.destroy=vi.fn();return req;}) as any);
    const {measureGet}=await import("../src/handlers/ssrfGuard");
    await expect(measureGet({url:"https://example.com",hostname:"example.com",port:443,addresses:["93.184.216.34"]},10,"test")).rejects.toMatchObject({name:"AbortError"});
  });
  it("uses the direct HTTP branch and prefers IPv4 when both are validated",async()=>{
    stubFetch(200);vi.mocked(httpRequest).mockImplementation(vi.mocked(httpsRequest).getMockImplementation()! as any);
    const {measureGet}=await import("../src/handlers/ssrfGuard");
    const r=await measureGet({url:"http://example.com",hostname:"example.com",port:80,addresses:["2606:4700:4700::1111","93.184.216.34"]},1000,"test");
    expect(r.status).toBe(200);const call=vi.mocked(httpRequest).mock.calls.at(-1)! as any;
    expect(call[1].family).toBe(4);expect(call[1].autoSelectFamily).toBe(false);
  });
  it("literal IPv6 uses the same global validation without an extra DNS resolution",async()=>{
    const target=await guardPublicHttpUrl("https://[2606:4700:4700::1111]", "url");
    expect(target.addresses).toEqual(["2606:4700:4700::1111"]);
  });
  it("route query ambiguity fails before a connection",async()=>{
    const app=buildServer();try{for(const url of ["/v1/api-health?url=example.com&url=example.org","/v1/server-uptime?host=example.com&extra=1"]){expect((await app.inject({method:"GET",url})).statusCode).toBe(400);}}finally{await app.close();}
  });
  it("a trailing-dot hostname shares the rate-limit key with its plain form", async () => {
    __clearRateLimitsForTests();
    fakeDns({ "example.com": ["93.184.216.34"] });
    await guardPublicHttpUrl("example.com", "url");
    await expect(guardPublicHttpUrl("example.com.", "url")).rejects.toMatchObject({ status: 422, code: "RATE_LIMITED" });
  });
});
