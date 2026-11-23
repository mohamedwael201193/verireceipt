import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/threat-intel-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleThreatIndicator, matchIndicator, resetThreatIntelCacheForTests } from "../src/handlers/threatIntel";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

// Fixtures are real excerpts of the live lists, retrieved 2026-11-23.
const FX = join(__dirname, "fixtures/threat-indicator");
const BODIES: Record<string, string> = {
  "spamhaus.org": readFileSync(join(FX, "spamhaus-drop.txt"), "utf8"),
  "emergingthreats.net": readFileSync(join(FX, "et-compromised.txt"), "utf8"),
  "blocklist.de": readFileSync(join(FX, "blocklistde.txt"), "utf8"),
  "stamparm": readFileSync(join(FX, "ipsum.txt"), "utf8"),
  "Phishing.Database": readFileSync(join(FX, "phishing-db.txt"), "utf8"),
  "hagezi": readFileSync(join(FX, "hagezi-tif.txt"), "utf8"),
  "openphish": readFileSync(join(FX, "openphish.txt"), "utf8"),
};
function stub(down: string[] = []): void {
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    for (const key of Object.keys(BODIES)) {
      if (u.includes(key)) {
        if (down.includes(key)) throw new Error("feed outage");
        return new Response(BODIES[key], { status: 200 });
      }
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}
beforeEach(() => resetThreatIntelCacheForTests({})); // zero floors: tiny real excerpts

describe("THREAT_INTELLIGENCE_INDICATOR", () => {
  it("judged key 185.220.101.4 is listed by ipsum and named with its raw line", async () => {
    stub();
    const result = await handleThreatIndicator({ indicator: "185.220.101.4" });
    expect(result.malicious).toBe(true);
    expect(String(result.answer)).toContain("stamparm ipsum");
    expect(String(result.answer)).toContain("185.220.101.4");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("THREAT_INTELLIGENCE_INDICATOR");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("185.220.101.4");
  });
  it("judged key malware.wicar.org matches the HaGeZi wildcard *.malware.wicar.org", async () => {
    stub();
    const result = await handleThreatIndicator({ indicator: "malware.wicar.org" });
    expect(result.malicious).toBe(true);
    const matches = result.matches as { feed: string; matched_entry: string }[];
    expect(matches.some((m) => m.feed.includes("HaGeZi") && m.matched_entry === "*.malware.wicar.org")).toBe(true);
  });
  it("judged keys 8.8.8.8 and 1.1.1.1 are NOT listed, and the answer says that is not a clearance", async () => {
    stub();
    for (const ip of ["8.8.8.8", "1.1.1.1"]) {
      const result = await handleThreatIndicator({ indicator: ip });
      expect(result.malicious).toBe(false);
      expect(String(result.answer)).toContain("NOT listed");
      expect(String(result.answer)).toContain("NOT a clearance");
    }
  });
  it("a CIDR block in Spamhaus DROP matches an address inside it", async () => {
    stub();
    const result = await handleThreatIndicator({ indicator: "1.10.16.9" });
    expect(result.malicious).toBe(true);
    const matches = result.matches as { feed: string; matched_entry: string }[];
    expect(matches.some((m) => m.feed === "Spamhaus DROP" && m.matched_entry === "1.10.16.0/20")).toBe(true);
  });
  it("a URL indicator matches OpenPhish by full URL", async () => {
    stub();
    const first = BODIES["openphish"].split(/\r?\n/).find((l) => /^https?:\/\//.test(l.trim()))!.trim();
    const result = await handleThreatIndicator({ indicator: first });
    expect(result.malicious).toBe(true);
    const matches = result.matches as { feed: string }[];
    expect(matches.some((m) => m.feed === "OpenPhish community feed")).toBe(true);
  });
  it("one failed feed fails CLOSED with 502, never a partial clean answer", async () => {
    stub(["openphish"]);
    await expect(handleThreatIndicator({ indicator: "8.8.8.8" })).rejects.toMatchObject({ status: 502, code: "THREAT_FEED_DEGRADED" });
  });
  it("a truncated list fails CLOSED, never screened against", async () => {
    resetThreatIntelCacheForTests({ "Spamhaus DROP": 100000 });
    stub();
    await expect(handleThreatIndicator({ indicator: "8.8.8.8" })).rejects.toMatchObject({ status: 502, code: "THREAT_FEED_DEGRADED" });
  });
  it("validates the indicator", async () => {
    stub();
    await expect(handleThreatIndicator({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleThreatIndicator({ indicator: "not an ip" })).rejects.toMatchObject({ status: 400, code: "INVALID_INDICATOR" });
  });
  it("matchIndicator treats 999.1.1.1 as a domain-shaped non-IP, never as an IP", () => {
    const { type } = matchIndicator("999.1.1.1", []);
    expect(type).toBe("domain");
  });
  it("GET /v1/threat-indicator is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/threat-indicator" })).toBe(true);
    await app.close();
  });
});
it('handler never lists TEST-NET-3 in supplemental feeds or Tor context',async()=>{
 stub();const base=globalThis.fetch;
 vi.stubGlobal('fetch',async(u:unknown)=>{const s=String(u);const name=s.includes('torproject')?'tor':s.includes('feodo')?'feodo':s.includes('cinsscore')?'cins':null;return name?new Response(readFileSync(join(__dirname,`fixtures/threat-context/${name}.txt`),'utf8')):base(u as string)});
 const out=await handleThreatIndicator({indicator:'203.0.113.1'});expect(out.malicious).toBe(false);expect(out.tor_exit).toBe(false);expect(out.context_listed_by).toEqual([]);
 for(const row of out.context_feeds as any[]){expect(row.matched_entry).toBeNull();if(row.status==='answered')expect(row.listed).toBe(false);else expect(row.listed).toBeNull();expect(out.context_listed_by).not.toContain(row.name)}
 expect(out.listed_by).not.toContain('Tor exit list');expect(out.listed_by).not.toContain('CINS Army');
});

describe('URL IP-literal screening',()=>{
 it('URL host replays the same actual captured CIDR and individual-IP entries',async()=>{
  stub();
  const {loadFeeds}=await import('../src/handlers/threatIntel');
  const states=await loadFeeds();
  for(const ip of ['1.10.16.9','185.220.101.4']) {
   const bare=matchIndicator(ip,states);
   const url=matchIndicator('http://'+ip+':8080/path?x=1',states);
   expect(url.type).toBe("url");
   expect(url.matches).toEqual(bare.matches);
   expect(url.matches.length).toBeGreaterThan(0);
  }
 });
 it('full URL matches are preserved alongside an IP host match',()=>{
  const url='http://1.10.16.9/path';
  const states:any[]=[{feed:{name:'URL control',kind:'url'},lines:[url]},{feed:{name:'CIDR control',kind:'cidr'},lines:['1.10.16.0/20']}];
  expect(matchIndicator(url,states).matches.map(m=>m.feed)).toEqual(['URL control','CIDR control']);
 });
 it.each(['http://16846985/','http://0x010a1009/','http://01.012.020.011/','http://1.10.4105/','http://%31.10.16.9/','http://1.10.16.9./','http://[::ffff:1.10.16.9]/','http://[::ffff:10a:1009]/','http://[2001:db8::1]/','http://user@1.10.16.9/'])('refuses ambiguous/unsupported literal before a clean result: %s',url=>{
  expect(()=>matchIndicator(url,[])).toThrowError(expect.objectContaining({status:400}));
 });
});
