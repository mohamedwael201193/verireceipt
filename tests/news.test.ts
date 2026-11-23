import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/news-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
import { handleNewsHeadlines } from "../src/handlers/newsHeadlines";
import { handleNewsSearch, buildBrief } from "../src/handlers/newsSearch";
import { parseHn, parseBbcRss, topicMatches, HN_INDEX, BBC_INDEX, NewsItem } from "../src/handlers/newsSources";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real bodies, retrieved 2026-11-23: HN Algolia search for "openai"
// (7-day window) and the BBC News World RSS feed.
const hn = readFileSync(join(__dirname, "fixtures/news/hn-algolia-openai-7d.json"), "utf8");
const bbc = readFileSync(join(__dirname, "fixtures/news/bbc-world-rss.xml"), "utf8");
const FROZEN = new Date("2026-11-23T01:00:00Z");
function stub(opts: { hn?: string; bbc?: string } = {}): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("hn.algolia.com")) {
      if (opts.hn === "ERR") throw new Error("test outage");
      return new Response(opts.hn ?? hn, { status: 200 });
    }
    if (opts.bbc === "ERR") throw new Error("test outage");
    return new Response(opts.bbc ?? bbc, { status: 200 });
  });
}
describe("NEWS named indexes", () => {
  it("parses the real bodies", () => {
    const hnItems = parseHn(hn);
    expect(hnItems.length).toBeGreaterThanOrEqual(4);
    expect(hnItems[0].title).toContain("OpenAI");
    expect(hnItems[0].points).toBe(225);
    const bbcItems = parseBbcRss(bbc);
    expect(bbcItems.length).toBe(35);
    expect(bbcItems[0].title).toContain("COP31");
    expect(bbcItems[0].published).toBe("2026-11-23T00:50:35.000Z");
    expect(topicMatches("openai models", "Advancing chip design with OpenAI models")).toBe(true);
    expect(topicMatches("openai", "COP31 fails to reach major climate deal")).toBe(false);
  });
});
describe("NEWS_HEADLINES_GENERAL", () => {
  it("validates first", async () => {
    await expect(handleNewsHeadlines({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleNewsHeadlines({ topic: "x", window_hours: "721" })).rejects.toMatchObject({ status: 400, code: "BAD_WINDOW" });
  });
  it("top headline is the highest-points HN story in the window, indexes named", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub();
    const result = await handleNewsHeadlines({ topic: "openai", window_hours: "168" });
    expect(result.top_headline).toBe("Advancing chip design with OpenAI models");
    const ans = String(result.answer);
    expect(ans).toContain("Hacker News");
    expect(ans).toContain("named indexes");
    expect(ans).toContain("never comprehensive");
    expect(result.confidence).toBe(0.8);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("NEWS_HEADLINES_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const ev = JSON.parse(stored.evidence.toString("utf8"));
    expect(ev.raw_bodies.hn).toBe(hn);
    expect(ev.raw_bodies.bbc).toBe(bbc);
  });
  it("a topic with no in-window matches is an honest 422", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub();
    await expect(handleNewsHeadlines({ topic: "zzq-nonexistent-topic", window_hours: "24" }))
      .rejects.toMatchObject({ status: 422, code: "NO_HEADLINES_IN_WINDOW" });
  });
  it("degrades honestly when one index is down, 502 when both are", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub({ bbc: "ERR" });
    const result = await handleNewsHeadlines({ topic: "openai", window_hours: "168" });
    expect(result.top_headline).toBe("Advancing chip design with OpenAI models");
    expect(String(result.answer)).toContain("Degraded");
    vi.unstubAllGlobals();
    stub({ hn: "ERR", bbc: "ERR" });
    await expect(handleNewsHeadlines({ topic: "openai" }))
      .rejects.toMatchObject({ status: 502, code: "NEWS_INDEXES_UNREACHABLE" });
  });
});
describe("NEWS_SEARCH_GENERAL", () => {
  it("validates first", async () => {
    await expect(handleNewsSearch({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
  });
  it("the brief fits the contract budget and names the indexes", () => {
    const brief = buildBrief(parseHn(hn), parseBbcRss(bbc).filter((i) => topicMatches("climate", i.title)), []);
    expect(brief.length).toBeLessThanOrEqual(256);
    expect(brief).toContain("Named indexes only");
  });
  it("serves counts and sources with honest scope", async () => {
    stub();
    const result = await handleNewsSearch({ query: "openai" });
    expect(Number(result.result_count)).toBeGreaterThanOrEqual(4);
    expect((result.sources as string[]).join(" ")).toContain("Hacker News");
    const brief = String(result.brief);
    expect(brief.length).toBeLessThanOrEqual(256);
    expect(String(result.answer)).toContain("never comprehensive");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("NEWS_SEARCH_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
  });
  it("no matches anywhere is an honest 422", async () => {
    stub();
    await expect(handleNewsSearch({ query: "zzq nonexistent" }))
      .rejects.toMatchObject({ status: 422, code: "NO_RESULTS" });
  });
  it("GET routes are wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/news-headlines" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/v1/news-search" })).toBe(true);
    stub();
    const res = await app.inject({ method: "GET", url: "/v1/news-search?query=openai" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("news brief byte cap and topic tokens (reviewer follow-up)", () => {
  it("the brief never exceeds the 256-byte contract budget, even with multi-byte titles", () => {
    // A long CJK title: each character is 3 UTF-8 bytes, so a naive
    // character-length cap would overflow the byte budget.
    const cjkTitle = "人工知能企業が大型資金調達を発表、世界市場で注目を集める".repeat(4);
    const hn: NewsItem[] = [{ index: HN_INDEX, title: cjkTitle, url: "https://example.com/1", published: "2026-11-23T00:00:00.000Z", points: 42 }];
    const bbc: NewsItem[] = [{ index: BBC_INDEX, title: cjkTitle, url: "https://example.com/2", published: "2026-11-23T00:00:00.000Z", points: null }];
    const brief = buildBrief(hn, bbc, []);
    const bytes = new TextEncoder().encode(brief);
    expect(bytes.length).toBeLessThanOrEqual(256);
    expect(brief.endsWith("…")).toBe(true);
    // Truncation never splits a multi-byte character: no replacement char.
    expect(brief).not.toContain("�");
  });
  it("a short brief is untouched", () => {
    const hn: NewsItem[] = [{ index: HN_INDEX, title: "Acme Robotics raises funding", url: "https://example.com/3", published: "2026-11-23T00:00:00.000Z", points: 7 }];
    const brief = buildBrief(hn, [], []);
    expect(brief).toContain("Acme Robotics raises funding");
    expect(new TextEncoder().encode(brief).length).toBeLessThanOrEqual(256);
    expect(brief.endsWith("…")).toBe(false);
  });
  it("topic match requires every token, not just some", () => {
    expect(topicMatches("acme robotics", "Acme raises a large funding round")).toBe(false);
    expect(topicMatches("acme robotics", "Robotics sector rallies on strong demand")).toBe(false);
    expect(topicMatches("acme robotics", "Acme Robotics raises a large funding round")).toBe(true);
  });
});
