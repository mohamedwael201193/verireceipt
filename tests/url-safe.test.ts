import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/url-safe-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleUrlSafe } from "../src/handlers/urlSafe";
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

describe("URL_SAFE_GENERAL", () => {
  it("an unflagged URL answers verdict Safe with detections 0, and names that absence is not clearance", async () => {
    stub();
    const result = await handleUrlSafe({ url: "https://example.com/" });
    expect((result.url_check as { verdict: string }).verdict).toBe("Safe");
    expect(result.detections).toBe(0);
    expect(String(result.summary)).toContain("absence is not clearance");
    expect(String(result.answer)).toContain("not a guarantee");
  });
  it("a malware host answers verdict Malicious with detections >= 1 and the matching feeds", async () => {
    stub();
    const result = await handleUrlSafe({ url: "http://malware.wicar.org/data/eicar.com" });
    expect((result.url_check as { verdict: string }).verdict).toBe("Malicious");
    expect(Number(result.detections)).toBeGreaterThanOrEqual(1);
    expect(String(result.summary)).toContain("Malicious");
    const matches = result.matches as { feed: string; matched_entry: string }[];
    expect(matches.some((m) => m.feed.includes("HaGeZi"))).toBe(true);
  });
  it("detections counts distinct feeds: a URL flagged by both the URL list and host lists counts each feed once", async () => {
    stub();
    const first = BODIES["openphish"].split(/\r?\n/).find((l) => /^https?:\/\//.test(l.trim()))!.trim();
    const result = await handleUrlSafe({ url: first });
    const matches = result.matches as { feed: string }[];
    expect(result.detections).toBe(new Set(matches.map((m) => m.feed)).size);
    expect(Number(result.detections)).toBeGreaterThanOrEqual(1);
  });
  it("a URL whose host is a blocklisted IP is Malicious", async () => {
    stub();
    const result = await handleUrlSafe({ url: "http://185.220.101.4/login" });
    expect((result.url_check as { verdict: string }).verdict).toBe("Malicious");
    const matches = result.matches as { feed: string }[];
    expect(matches.some((m) => m.feed === "stamparm ipsum")).toBe(true);
  });
  it("missing, malformed and non-http(s) URLs are 400", async () => {
    stub();
    await expect(handleUrlSafe({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleUrlSafe({ url: "not a url" })).rejects.toMatchObject({ status: 400 });
    await expect(handleUrlSafe({ url: "ftp://example.com/x" })).rejects.toMatchObject({ status: 400 });
  });
  it("returns Unknown with disclosed incomplete screening when one feed is down", async () => {
    stub(["blocklist.de"]);
    const result = await handleUrlSafe({ url: "https://example.com/" });
    expect(result.url_check).toEqual({ verdict: "Unknown" });
    expect(result.screening_complete).toBe(false);
    expect(result.answer).toContain("blocklist.de");
  });
  it("the receipt is persisted with matching evidence hash", async () => {
    stub();
    const result = await handleUrlSafe({ url: "https://example.com/" });
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("URL_SAFE_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("NOT fetched");
  });
  it("GET /v1/url-safe is wired and returns the contract fields", async () => {
    stub();
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/url-safe?url=https%3A%2F%2Fexample.com%2F" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { receipt: { intent: string }; url: string; url_check: { verdict: string }; detections: number; summary: string };
    expect(body.receipt.intent).toBe("URL_SAFE_GENERAL");
    expect(body.url).toBe("https://example.com/");
    expect(body.url_check.verdict).toBe("Safe");
    expect(body.detections).toBe(0);
    expect(typeof body.summary).toBe("string");
    await app.close();
  });
});
it.each(['http://0xb9dc6504/','http://[::ffff:185.220.101.4]/'])('ambiguous/mapped URL host cannot receive Safe verdict: %s',async url=>{
 await expect(handleUrlSafe({url})).rejects.toMatchObject({status:400});
});
