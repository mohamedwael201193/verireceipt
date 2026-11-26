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
    for (const p of ["10.0.0.5", "192.168.1.1", "172.16.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "192.0.2.1", "198.51.100.7", "203.0.113.9"]) {
      expect(await handleIpGeolocation({ ip: p })).toMatchObject({ verdict: "no_data", confidence: 0, receipt: null });
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
  it.each([["Netherlands","The Netherlands","NL"],["Czechia","Czech Republic","CZ"],["Türkiye","Turkey","TR"],["Bahamas","The Bahamas","BS"]])("spelling pair %s / %s with code %s is agreement", async (a, b, code) => {
    const w = JSON.parse(who1111); w.country = a; w.country_code = code;
    const p = JSON.parse(api1111); p.country = b; p.countryCode = code;
    stub({ who: JSON.stringify(w), api: JSON.stringify(p) });
    const r = await handleIpGeolocation({ ip: "1.1.1.1" });
    expect(r.country).toBe(a); expect(r.country_cross_check).toBe("agree"); expect(r.confidence).toBe(0.9);
    expect(String(r.answer)).toContain("Country cross-checked"); expect(String(r.answer)).not.toContain("DISAGREEMENT");
  });
  it("a real ISO code mismatch serves ipwho.is alone with a disclosed disagreement, never averaged", async () => {
    const edited = JSON.parse(api1111); edited.country = "United States"; edited.countryCode = "US"; edited.lat = 10; edited.lon = 20;
    stub({ who: who1111, api: JSON.stringify(edited) });
    const r = await handleIpGeolocation({ ip: "1.1.1.1" });
    expect(r.country).toBe("Australia"); expect(r.latitude).toBe(JSON.parse(who1111).latitude); expect(r.longitude).toBe(JSON.parse(who1111).longitude);
    expect(r.country_cross_check).toBe("disagree"); expect(r.confidence).toBe(0.5);
    const ans = String(r.answer); expect(ans).toContain("Country DISAGREEMENT"); expect(ans).toContain("AU"); expect(ans).toContain("US"); expect(ans).not.toContain("Country cross-checked");
  });
  it("codes sharing a first letter are different countries (AU vs AT)", async () => {
    const w = JSON.parse(who1111); w.country_code = "AU";
    const p = JSON.parse(api1111); p.country = "Austria"; p.countryCode = "AT";
    stub({ who: JSON.stringify(w), api: JSON.stringify(p) });
    const r = await handleIpGeolocation({ ip: "1.1.1.1" });
    expect(r.country_cross_check).toBe("disagree"); expect(String(r.answer)).toContain("(AT)");
  });
  it("the source string says DISAGREED on a mismatch and cross-checked on agreement", async () => {
    const p = JSON.parse(api1111); p.country = "Austria"; p.countryCode = "AT";
    stub({ who: who1111, api: JSON.stringify(p) });
    expect(String((await handleIpGeolocation({ ip: "1.1.1.1" })).source)).toContain("country DISAGREED between the two");
    stub({ who: who1111, api: api1111 });
    const ok = String((await handleIpGeolocation({ ip: "1.1.1.1" })).source);
    expect(ok).toContain("country cross-checked across both"); expect(ok).not.toContain("DISAGREED");
  });
  it("without ISO codes the names decide, dropping a leading 'the'", async () => {
    const w = JSON.parse(who1111); delete w.country_code; w.country = "The Netherlands";
    const p = JSON.parse(api1111); delete p.countryCode; p.country = "Netherlands";
    stub({ who: JSON.stringify(w), api: JSON.stringify(p) });
    expect((await handleIpGeolocation({ ip: "1.1.1.1" })).country_cross_check).toBe("agree");
    p.country = "Chile"; stub({ who: JSON.stringify(w), api: JSON.stringify(p) });
    expect((await handleIpGeolocation({ ip: "1.1.1.1" })).country_cross_check).toBe("disagree");
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
it('metadata comes from same serving source, never merged across differing city estimates',async()=>{stub({who:who8888,api:api8888});const out=await handleIpGeolocation({ip:'8.8.8.8'});expect(out).toMatchObject({region:'California',timezone:'America/Los_Angeles',asn:15169,operator:'Google LLC',metadata_source:'ipwho.is'});});
it('fallback metadata is explicitly source-bound',async()=>{stub({api:api1111});const out=await handleIpGeolocation({ip:'1.1.1.1'});expect(out).toMatchObject({region:'Queensland',timezone:'Australia/Brisbane',asn:13335,operator:'APNIC and Cloudflare DNS Resolver project',metadata_source:'ip-api.com'});});
it.each(['ipwho','api'])('mismatched %s source is not served or written as valid evidence',async source=>{stub(source==='ipwho'?{who:who8888}:{api:api8888});await expect(handleIpGeolocation({ip:'1.1.1.1'})).rejects.toMatchObject({code:'GEO_SOURCES_DOWN'});});
it.each(['ipwho','api'])('missing %s response IP cannot be trusted',async source=>{const row=JSON.parse(source==='ipwho'?who1111:api1111);delete row[source==='ipwho'?'ip':'query'];stub(source==='ipwho'?{who:JSON.stringify(row)}:{api:JSON.stringify(row)});await expect(handleIpGeolocation({ip:'1.1.1.1'})).rejects.toMatchObject({code:'GEO_SOURCES_DOWN'});});
it('a wrong primary cannot contaminate valid fallback metadata',async()=>{stub({who:who8888,api:api1111});const out=await handleIpGeolocation({ip:'1.1.1.1'});expect(out).toMatchObject({city:'South Brisbane',metadata_source:'ip-api.com'});expect(String(out.answer)).toContain('ipwho.is did not answer');});
it('missing optional metadata stays null',async()=>{const d=JSON.parse(who1111);delete d.region;delete d.timezone;delete d.connection;stub({who:JSON.stringify(d)});expect(await handleIpGeolocation({ip:'1.1.1.1'})).toMatchObject({region:null,timezone:null,asn:null,operator:null});});
it('invalid ASN never coerced from arbitrary source text',async()=>{const d=JSON.parse(who1111);d.connection.asn='AS13335';stub({who:JSON.stringify(d)});expect((await handleIpGeolocation({ip:'1.1.1.1'})).asn).toBeNull();});
it('equivalent expanded IPv6 identity binds canonically',async()=>{const d=JSON.parse(who1111);d.ip='2606:4700:4700:0:0:0:0:1111';stub({who:JSON.stringify(d)});expect((await handleIpGeolocation({ip:'2606:4700:4700::1111'})).metadata_source).toBe('ipwho.is');});
it('oversized JSON response never bypasses64KB body bound',async()=>{stub({who:who1111+' '.repeat(64001)});await expect(handleIpGeolocation({ip:'1.1.1.1'})).rejects.toMatchObject({code:'GEO_SOURCES_DOWN'});});
it('redirects are explicitly refused in public reader',async()=>{const f=vi.fn(async(_u:unknown,o:any)=>{expect(o.redirect).toBe('error');return new Response(who1111);});vi.stubGlobal('fetch',f);await handleIpGeolocation({ip:'1.1.1.1'});});
it('ignoring abort cannot hang source beyond hard deadline',async()=>{vi.useFakeTimers();try{vi.stubGlobal('fetch',()=>new Promise(()=>{}));const p=handleIpGeolocation({ip:'1.1.1.1'}).catch(e=>e);await vi.advanceTimersByTimeAsync(5101);expect(await p).toMatchObject({code:'GEO_SOURCES_DOWN'});}finally{vi.useRealTimers();}});
