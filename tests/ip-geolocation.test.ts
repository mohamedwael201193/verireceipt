import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/ip-geo-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); });
import { handleIpGeolocation, validatePublicIp } from "../src/handlers/ipGeolocation";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
const fixture = (n: string) => readFileSync(join(__dirname, "fixtures/ip-geo", n), "utf8");
// Real ipwho.is and ip-api.com bodies, retrieved 2026-11-23.
const who1111 = fixture("ipwhois-1.1.1.1.json");
const api1111 = fixture("ip-api-1.1.1.1.json");
const who8888 = fixture("ipwhois-8.8.8.8.json");
const api8888 = fixture("ip-api-8.8.8.8.json");
function stub(opts: { who?: string; api?: string }): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    const body = u.includes("ipwho.is") ? opts.who : opts.api;
    if (body === undefined) throw new Error("test outage");
    return new Response(body, { status: 200 });
  });
}
describe("IP_GEOLOCATION_GENERAL", () => {
  it("validates the address shape and refuses private or reserved space", async () => {
    await expect(handleIpGeolocation({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleIpGeolocation({ ip: "999.1.2.3" })).rejects.toMatchObject({ status: 400, code: "INVALID_IP" });
    await expect(handleIpGeolocation({ ip: "not-an-ip" })).rejects.toMatchObject({ status: 400, code: "INVALID_IP" });
    for (const p of ["10.0.0.5", "192.168.1.1", "172.16.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1"]) {
      await expect(handleIpGeolocation({ ip: p })).rejects.toMatchObject({ status: 422, code: "PRIVATE_IP" });
    }
    expect(() => validatePublicIp("8.8.8.8")).not.toThrow();
    expect(() => validatePublicIp("2606:4700:4700::1111")).not.toThrow();
  });
  it("country agreement across both databases serves ipwho.is coordinates with a receipt", async () => {
    stub({ who: who1111, api: api1111 });
    const result = await handleIpGeolocation({ ip: "1.1.1.1" });
    expect(result.country).toBe("Australia");
    expect(result.city).toBe("Brisbane");
    expect(result.latitude).toBe(-27.4679371);
    expect(result.longitude).toBe(153.0280882);
    expect(String(result.answer)).toContain("cross-checked");
    expect(String(result.answer)).toContain("approximate");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("IP_GEOLOCATION_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.raw_bodies["ipwho.is"]).toBe(who1111);
    expect(body.raw_bodies["ip-api.com"]).toBe(api1111);
  });
  it("differing city estimates are disclosed, never averaged", async () => {
    stub({ who: who8888, api: api8888 }); // real bodies: San Jose vs Ashburn for 8.8.8.8
    const result = await handleIpGeolocation({ ip: "8.8.8.8" });
    expect(result.country).toBe("United States");
    expect(result.city).toBe("San Jose"); // ipwho.is serves the coordinates
    expect(result.latitude).toBe(37.3393939);
    const ans = String(result.answer);
    expect(ans).toContain("San Jose");
    expect(ans).toContain("Ashburn");
    expect(ans).toContain("approximate");
  });
  it("a country disagreement between the databases is refused, never averaged", async () => {
    const edited = JSON.parse(api1111);
    edited.country = "United States";
    stub({ who: who1111, api: JSON.stringify(edited) });
    await expect(handleIpGeolocation({ ip: "1.1.1.1" }))
      .rejects.toMatchObject({ status: 502, code: "GEO_SOURCES_DISAGREE" });
  });
  it("one source down serves the other alone with the degradation named", async () => {
    stub({ api: api1111 }); // ipwho.is out
    const result = await handleIpGeolocation({ ip: "1.1.1.1" });
    expect(result.country).toBe("Australia");
    expect(result.city).toBe("South Brisbane");
    expect(String(result.answer)).toContain("single source");
  });
  it("both sources down is an honest 502", async () => {
    stub({});
    await expect(handleIpGeolocation({ ip: "1.1.1.1" }))
      .rejects.toMatchObject({ status: 502, code: "GEO_SOURCES_DOWN" });
  });
  it("GET /v1/ip-geolocation is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/ip-geolocation" })).toBe(true);
    stub({ who: who1111, api: api1111 });
    const res = await app.inject({ method: "GET", url: "/v1/ip-geolocation?ip=1.1.1.1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().country).toBe("Australia");
    await app.close();
  });
});
