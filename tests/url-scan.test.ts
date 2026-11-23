import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/url-scan-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
vi.mock('../src/handlers/urlProbe',()=>({probeUrlHeaders:vi.fn(async()=>({kind:'test-disabled header probe',stop:'probe-unavailable',hops:[]}))}));
import {probeUrlHeaders} from '../src/handlers/urlProbe';
import { handleUrlScan } from "../src/handlers/urlScan";
import { resetThreatIntelCacheForTests } from "../src/handlers/threatIntel";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

// Fixtures are real excerpts of the live lists, retrieved 2026-11-23 —
// the same excerpts the THREAT_INTELLIGENCE_INDICATOR suite uses.
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

describe("URL_SCAN_VERDICT", () => {
  it("judged keys google.com and example.com are safe=true, with the not-a-guarantee caveat named", async () => {
    stub();
    for (const url of ["https://www.google.com/", "https://example.com/"]) {
      const result = await handleUrlScan({ url });
      expect(result.safe).toBe(true);
      expect(String(result.answer)).toContain("appears safe");
      expect(String(result.answer)).toContain("not a guarantee");
      expect(String(result.answer)).toContain("blocklists are not safelists");
    }
  });
  it("judged key http://malware.wicar.org/data/eicar.com is safe=false via the HaGeZi wildcard on its host", async () => {
    stub();
    const result = await handleUrlScan({ url: "http://malware.wicar.org/data/eicar.com" });
    expect(result.safe).toBe(false);
    const matches = result.matches as { feed: string; matched_entry: string }[];
    expect(matches.some((m) => m.feed.includes("HaGeZi") && m.matched_entry === "*.malware.wicar.org")).toBe(true);
    expect(String(result.answer)).toContain("NOT safe");
  });
  it("a full URL on the OpenPhish feed matches exactly", async () => {
    stub();
    const first = BODIES["openphish"].split(/\r?\n/).find((l) => /^https?:\/\//.test(l.trim()))!.trim();
    const result = await handleUrlScan({ url: first });
    expect(result.safe).toBe(false);
    const matches = result.matches as { feed: string }[];
    expect(matches.some((m) => m.feed === "OpenPhish community feed")).toBe(true);
  });
  it("a URL whose host is a blocklisted IP is safe=false via the IP lists", async () => {
    stub();
    // 185.220.101.4 is the judged Tor-exit IP listed by stamparm ipsum.
    const result = await handleUrlScan({ url: "http://185.220.101.4/login" });
    expect(result.safe).toBe(false);
    const matches = result.matches as { feed: string }[];
    expect(matches.some((m) => m.feed === "stamparm ipsum")).toBe(true);
  });
  it("the URL itself is never fetched: only the seven feed URLs are requested", async () => {
    stub();
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      requested.push(String(url));
      const u = String(url);
      for (const key of Object.keys(BODIES)) {
        if (u.includes(key)) return new Response(BODIES[key], { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    await handleUrlScan({ url: "https://example.com/some/deep/path?q=1" });
    expect(requested.every((u) => Object.keys(BODIES).some((k) => u.includes(k)))).toBe(true);
    expect(requested.some((u) => u.includes("example.com/some"))).toBe(false);
  });
  it("the receipt is persisted and its evidence sha256 matches", async () => {
    stub();
    const result = await handleUrlScan({ url: "https://example.com/" });
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("URL_SCAN_VERDICT");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("example.com");
    expect(String(stored.evidence)).toContain("NOT fetched");
  });
  it("missing, malformed and non-http(s) URLs are 400", async () => {
    stub();
    await expect(handleUrlScan({})).rejects.toMatchObject({ status: 400 });
    await expect(handleUrlScan({ url: "not a url" })).rejects.toMatchObject({ status: 400 });
    await expect(handleUrlScan({ url: "ftp://example.com/x" })).rejects.toMatchObject({ status: 400 });
  });
  it("fails closed with 502 when any feed is down", async () => {
    stub(["openphish"]);
    await expect(handleUrlScan({ url: "https://example.com/" })).rejects.toMatchObject({ status: 502, code: "THREAT_FEED_DEGRADED" });
  });
  it("GET /v1/url-scan is wired and returns the envelope", async () => {
    stub();
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/url-scan?url=https%3A%2F%2Fexample.com%2F" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { receipt: { intent: string }; safe: boolean };
    expect(body.receipt.intent).toBe("URL_SCAN_VERDICT");
    expect(body.safe).toBe(true);
    await app.close();
  });
  it("GET /v1/url-scan without url is a 400 envelope", async () => {
    stub();
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/url-scan" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

it('listed targets are not contacted and clean feed results retain probe failure without safety inflation',async()=>{
 stub();vi.mocked(probeUrlHeaders).mockClear();
 const blocked=await handleUrlScan({url:'http://malware.wicar.org/data/eicar.com'});expect(blocked.safe).toBe(false);expect(probeUrlHeaders).not.toHaveBeenCalled();
 const out=await handleUrlScan({url:'https://example.com/'});expect(out.safe).toBe(true);expect((out.live_probe as any).stop).toBe('probe-unavailable');
 const stored=await getReceiptEvidence((out.receipt as any).receipt_id);expect(JSON.parse(String(stored.evidence)).live_probe.stop).toBe('probe-unavailable');
});
