import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/news-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
import { handleNewsHeadlines } from "../src/handlers/newsHeadlines";
import { handleNewsSearch, buildBrief } from "../src/handlers/newsSearch";
import { parseHn, parseBbcRss, parseGnewsRss, parseGdelt, gdeltSeendateToIso, topicMatches, HN_INDEX, BBC_INDEX, GNEWS_INDEX, GDELT_INDEX, NewsItem } from "../src/handlers/newsSources";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real bodies, retrieved 2026-11-23: HN Algolia search for "openai"
// (7-day window), Google News RSS search for "openai", GDELT DOC 2.0
// artlist for "openai" (hybrid relevance), and the BBC News World RSS feed.
const hn = readFileSync(join(__dirname, "fixtures/news/hn-algolia-openai-7d.json"), "utf8");
const gnews = readFileSync(join(__dirname, "fixtures/news/gnews-rss-openai.xml"), "utf8");
const gdelt = readFileSync(join(__dirname, "fixtures/news/gdelt-artlist-openai.json"), "utf8");
const bbc = readFileSync(join(__dirname, "fixtures/news/bbc-world-rss.xml"), "utf8");
const FROZEN = new Date("2026-11-23T01:00:00Z");
function stub(opts: { hn?: string; gnews?: string; gdelt?: string; bbc?: string } = {}): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("hn.algolia.com")) {
      if (opts.hn === "ERR") throw new Error("test outage");
      return new Response(opts.hn ?? hn, { status: 200 });
    }
    if (u.includes("news.google.com")) {
      if (opts.gnews === "ERR") throw new Error("test outage");
      return new Response(opts.gnews ?? gnews, { status: 200 });
    }
    if (u.includes("api.gdeltproject.org")) {
      if (opts.gdelt === "ERR") throw new Error("test outage");
      return new Response(opts.gdelt ?? gdelt, { status: 200 });
    }
    if (opts.bbc === "ERR") throw new Error("test outage");
    return new Response(opts.bbc ?? bbc, { status: 200 });
  });
}
describe("NEWS named sources", () => {
  it("parses the real bodies", () => {
    const hnItems = parseHn(hn);
    expect(hnItems.length).toBeGreaterThanOrEqual(4);
    expect(hnItems[0].title).toContain("OpenAI");
    expect(hnItems[0].points).toBe(225);
    const gnewsItems = parseGnewsRss(gnews);
    expect(gnewsItems.length).toBe(1);
    expect(gnewsItems[0].title).toContain("OpenAI");
    expect(gnewsItems[0].outlet).toBe("Reuters");
    expect(gnewsItems[0].published.startsWith("2026-11-")).toBe(true);
    const gdeltItems = parseGdelt(gdelt);
    if (!gdeltItems) throw new Error("gdelt fixture must parse");
    expect(gdeltItems.length).toBe(25);
    expect(gdeltItems[0].title).toContain("OpenAI");
    expect(gdeltItems[0].published).toBe("2026-10-25T10:45:00.000Z");
    expect(gdeltItems[0].outlet).toBe("thenextweb.com");
    const bbcItems = parseBbcRss(bbc);
    expect(bbcItems.length).toBe(35);
    expect(bbcItems[0].title).toContain("COP31");
    expect(bbcItems[0].published).toBe("2026-11-23T00:50:35.000Z");
    expect(topicMatches("openai models", "Advancing chip design with OpenAI models")).toBe(true);
    expect(topicMatches("openai", "COP31 fails to reach major climate deal")).toBe(false);
  });
  it("GDELT seendate converts to ISO and rejects junk", () => {
    expect(gdeltSeendateToIso("20261123T104500Z")).toBe("2026-11-23T10:45:00.000Z");
    expect(gdeltSeendateToIso("not-a-date")).toBe("");
    expect(gdeltSeendateToIso("2026-11-23")).toBe("");
  });
  it("a GDELT rate-limit notice body is a source failure, not items", () => {
    expect(parseGdelt("Please limit requests to one every 5 seconds")).toBe(null);
    expect(parseGdelt("{}")).toBe(null);
    expect(parseGdelt("<html>overloaded</html>")).toBe(null);
  });
});
describe("NEWS_HEADLINES_GENERAL", () => {
  it("validates first", async () => {
    await expect(handleNewsHeadlines({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleNewsHeadlines({ topic: "x", window_hours: "721" })).rejects.toMatchObject({ status: 400, code: "BAD_WINDOW" });
  });
  it("top headline is the highest-points HN story in the window, sources named", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub();
    const result = await handleNewsHeadlines({ topic: "openai", window_hours: "168" });
    expect(result.top_headline).toBe("Advancing chip design with OpenAI models");
    const ans = String(result.answer);
    expect(ans).toContain("Hacker News");
    expect(ans).toContain("named sources");
    expect(ans).toContain("never comprehensive");
    expect(result.confidence).toBe(0.8);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("NEWS_HEADLINES_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const ev = JSON.parse(stored.evidence.toString("utf8"));
    expect(ev.raw_bodies.hn).toBe(hn);
    expect(ev.raw_bodies.gnews).toBe(gnews);
    expect(ev.raw_bodies.gdelt).toBe(gdelt);
    expect(ev.raw_bodies.bbc).toBe(bbc);
  });
  it("a topic with no HN match tops the most recent item across the other sources", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    // Synthetic small bodies: HN empty; Google News and GDELT carry matches
    // at different times; the more recent GDELT item must win.
    const hnEmpty = JSON.stringify({ hits: [] });
    const gnewsOne = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Acme Robotics unveils warehouse arm - Example News</title><link>https://news.google.com/rss/articles/x1</link><pubDate>Sun, 22 Nov 2026 08:00:00 GMT</pubDate><source url="https://example.com">Example News</source></item>
      </channel></rss>`;
    const gdeltTwo = JSON.stringify({ articles: [
      { url: "https://a.example/1", title: "Acme Robotics raises a large round", seendate: "20261122T200000Z", domain: "a.example" },
      { url: "https://b.example/2", title: "Acme Robotics expands to Cairo", seendate: "20261121T090000Z", domain: "b.example" },
    ] });
    const bbcEmpty = `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`;
    stub({ hn: hnEmpty, gnews: gnewsOne, gdelt: gdeltTwo, bbc: bbcEmpty });
    const result = await handleNewsHeadlines({ topic: "acme robotics", window_hours: "72" });
    expect(result.top_headline).toBe("Acme Robotics raises a large round");
    const headlines = result.headlines as string[];
    expect(headlines).toContain("Acme Robotics unveils warehouse arm - Example News");
    expect(headlines).toContain("Acme Robotics expands to Cairo");
  });
  it("a topic with no in-window matches anywhere is an honest 200 with a null top_headline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub({ hn: '{"hits":[]}', gnews: '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>', gdelt: '{"articles":[]}', bbc: '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>' });
    const result = await handleNewsHeadlines({ topic: "zzq-nonexistent-topic", window_hours: "24" });
    expect(result.top_headline).toBe(null);
    expect(result.headlines).toEqual([]);
    expect(result.urls).toEqual([]);
    expect(result.window).toBe("24h");
    const ans = String(result.answer);
    expect(ans).toContain("zero matches");
    expect(ans).toContain("Sources searched");
    expect(ans).toContain("Google News");
    expect(result.confidence).toBe(0.5);
  });
  it("a GDELT rate-limit notice degrades honestly while other sources answer", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub({ gdelt: "Please limit requests to one every 5 seconds" });
    const result = await handleNewsHeadlines({ topic: "openai", window_hours: "168" });
    expect(result.top_headline).toBe("Advancing chip design with OpenAI models");
    expect(String(result.answer)).toContain("Degraded");
    expect(String(result.answer)).toContain(GDELT_INDEX);
  });
  it("degrades honestly when one index is down, 502 when all are", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub({ bbc: "ERR" });
    const result = await handleNewsHeadlines({ topic: "openai", window_hours: "168" });
    expect(result.top_headline).toBe("Advancing chip design with OpenAI models");
    expect(String(result.answer)).toContain("Degraded");
    vi.unstubAllGlobals();
    stub({ hn: "ERR", gnews: "ERR", gdelt: "ERR", bbc: "ERR" });
    await expect(handleNewsHeadlines({ topic: "openai" }))
      .rejects.toMatchObject({ status: 502, code: "NEWS_INDEXES_UNREACHABLE" });
  });
});
describe("NEWS_SEARCH_GENERAL", () => {
  it("validates first", async () => {
    await expect(handleNewsSearch({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
  });
  it("the brief fits the contract budget and names the scope", () => {
    const brief = buildBrief([
      { label: "HN", items: parseHn(hn) },
      { label: "Google News", items: parseGnewsRss(gnews) },
      { label: "GDELT", items: parseGdelt(gdelt) ?? [] },
      { label: "BBC World current feed", items: parseBbcRss(bbc).filter((i) => topicMatches("climate", i.title)) },
    ]);
    expect(new TextEncoder().encode(brief).length).toBeLessThanOrEqual(256);
    expect(brief).toContain("Named sources only");
  });
  it("serves counts and sources with honest scope", async () => {
    stub();
    const result = await handleNewsSearch({ query: "openai" });
    expect(Number(result.result_count)).toBeGreaterThanOrEqual(26);
    expect((result.sources as string[]).join(" ")).toContain("Hacker News");
    expect((result.sources as string[]).join(" ")).toContain("Google News");
    expect((result.sources as string[]).join(" ")).toContain("GDELT");
    const brief = String(result.brief);
    expect(new TextEncoder().encode(brief).length).toBeLessThanOrEqual(256);
    expect(String(result.answer)).toContain("never comprehensive");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("NEWS_SEARCH_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
  });
  it("no matches anywhere is an honest 200 with result_count 0 and sources searched", async () => {
    stub({ hn: '{"hits":[]}', gnews: '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>', gdelt: '{"articles":[]}', bbc: '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>' });
    const result = await handleNewsSearch({ query: "zzq nonexistent" });
    expect(Number(result.result_count)).toBe(0);
    const brief = String(result.brief);
    expect(new TextEncoder().encode(brief).length).toBeLessThanOrEqual(256);
    expect(brief).toContain("HN: 0");
    expect(brief).toContain("Named sources only");
    expect(String(result.answer)).toContain("Sources searched");
    expect(String(result.answer)).toContain("zero matches");
    expect(result.confidence).toBe(0.5);
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
    const hnItems: NewsItem[] = [{ index: HN_INDEX, title: cjkTitle, url: "https://example.com/1", published: "2026-11-23T00:00:00.000Z", points: 42 }];
    const bbcItems: NewsItem[] = [{ index: BBC_INDEX, title: cjkTitle, url: "https://example.com/2", published: "2026-11-23T00:00:00.000Z", points: null }];
    const brief = buildBrief([
      { label: "HN", items: hnItems },
      { label: "Google News", items: [] },
      { label: "GDELT", items: [] },
      { label: "BBC World current feed", items: bbcItems },
    ]);
    const bytes = new TextEncoder().encode(brief);
    expect(bytes.length).toBeLessThanOrEqual(256);
    // The over-long title is truncated with an ellipsis inside the brief;
    // the scope suffix is never truncated away.
    expect(brief).toContain("…");
    expect(brief.endsWith("Named sources only.")).toBe(true);
    // Truncation never splits a multi-byte character: no replacement char.
    expect(brief).not.toContain("�");
  });
  it("a short brief is untouched", () => {
    const hnItems: NewsItem[] = [{ index: HN_INDEX, title: "Acme Robotics raises funding", url: "https://example.com/3", published: "2026-11-23T00:00:00.000Z", points: 7 }];
    const brief = buildBrief([
      { label: "HN", items: hnItems },
      { label: "Google News", items: [] },
      { label: "GDELT", items: [] },
      { label: "BBC World current feed", items: [] },
    ]);
    expect(brief).toContain("Acme Robotics raises funding");
    expect(new TextEncoder().encode(brief).length).toBeLessThanOrEqual(256);
    expect(brief.endsWith("…")).toBe(false);
  });
  it("topic match requires every token, not just some", () => {
    expect(topicMatches("acme robotics", "Acme raises a large funding round")).toBe(false);
    expect(topicMatches("acme robotics", "Robotics sector rallies on strong demand")).toBe(false);
    expect(topicMatches("acme robotics", "Acme Robotics raises a large funding round")).toBe(true);
  });
  it("unused indexes compile-check: GNEWS and GDELT names are exported", () => {
    expect(GNEWS_INDEX).toContain("Google News");
    expect(GDELT_INDEX).toContain("GDELT");
  });
});


describe("news valid-search gate", () => {
  const emptyRss = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>';
  const cases = [
    { hn: "<html>unavailable</html>", gnews: "<html>blocked</html>", gdelt: "rate limited", bbc: "<rss><channel>" },
    { hn: "{}", gnews: "<rss><channel></rss></channel>", gdelt: "null", bbc: "<rss></rss>" },
    { hn: "ERR", gnews: "ERR", gdelt: "rate limited", bbc: "ERR" },
  ];
  for (const [index, bodies] of cases.entries()) {
    it(`fails closed with no valid source, case ${index}`, async () => {
      stub(bodies);
      await expect(handleNewsHeadlines({ topic: "openai" })).rejects.toMatchObject({ status: 502, code: "NEWS_INDEXES_UNREACHABLE" });
      await expect(handleNewsSearch({ query: "openai" })).rejects.toMatchObject({ status: 502, code: "NEWS_INDEXES_UNREACHABLE" });
    });
  }
  for (const source of ["hn", "gnews", "gdelt", "bbc"] as const) {
    it(`allows an empty 200 only with a valid ${source} search`, async () => {
      const bodies = { hn: "{}", gnews: "<html>blocked</html>", gdelt: "rate limited", bbc: "<rss>" };
      bodies[source] = source === "hn" ? '{"hits":[]}' : source === "gdelt" ? '{"articles":[]}' : emptyRss;
      stub(bodies);
      const h = await handleNewsHeadlines({ topic: "openai" });
      expect(h.headlines).toEqual([]);
      expect(String(h.answer)).toContain("Degraded");
      const r = await handleNewsSearch({ query: "openai" });
      expect(r.result_count).toBe(0);
      expect(String(r.answer)).toContain("Degraded");
    });
  }
});


describe("news bounded source diagnostics", () => {
 it("opens the GDELT breaker after timeout and skips the next request", async () => {
  const { fetchIndex, resetNewsCircuitForTests } = await import("../src/handlers/newsSources");
  resetNewsCircuitForTests(); const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = vi.fn(async () => { throw Object.assign(new Error("private-token-and-url"), { name: "AbortError" }); });
  vi.stubGlobal("fetch", f);
  try {
   expect((await fetchIndex("https://api.gdeltproject.org/api/v2/doc/doc?query=test")).failure_reason).toBe("timeout");
   expect((await fetchIndex("https://api.gdeltproject.org/api/v2/doc/doc?query=other")).failure_reason).toBe("circuit_open");
   expect(f).toHaveBeenCalledTimes(1); expect(JSON.stringify(spy.mock.calls)).not.toContain("private-token");
  } finally { resetNewsCircuitForTests(); spy.mockRestore(); }
 });
});
it("search answer leads with three dated publisher-attributed captured headlines",async()=>{
 stub();const out=await handleNewsSearch({query:"openai"});
 const items=parseHn(hn).slice(0,3);
 const lead=items.map(i=>`"${i.title}" (${i.published.slice(0,10)}, ${i.outlet??i.index}).`).join(" ")+" ";
 expect(items).toHaveLength(3);expect(String(out.answer).startsWith(lead)).toBe(true);
});
it("GDELT timeout breaker expires at five minutes and recovered source is retried",async()=>{
 const {fetchIndex,resetNewsCircuitForTests}=await import("../src/handlers/newsSources");resetNewsCircuitForTests();
 const now=Date.now();const clock=vi.spyOn(Date,"now").mockReturnValue(now);const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
 const f=vi.fn().mockRejectedValueOnce(Object.assign(new Error("timeout"),{name:"AbortError"})).mockImplementation(async()=>new Response(gdelt));vi.stubGlobal("fetch",f);
 try{await fetchIndex("https://api.gdeltproject.org/api/v2/doc/doc?query=test");
 clock.mockReturnValue(now+299999);expect((await fetchIndex("https://api.gdeltproject.org/api/v2/doc/doc?query=test")).failure_reason).toBe("circuit_open");expect(f).toHaveBeenCalledTimes(1);
 clock.mockReturnValue(now+300000);const recovered=await fetchIndex("https://api.gdeltproject.org/api/v2/doc/doc?query=test");expect(f).toHaveBeenCalledTimes(2);expect(recovered.body).toBe(gdelt);
 }finally{clock.mockRestore();warn.mockRestore();resetNewsCircuitForTests()}
});
it('headline answer starts with up to five unique captured dated outlet-attributed items, retaining scored top',async()=>{
 vi.useFakeTimers();vi.setSystemTime(FROZEN);stub();
 const out=await handleNewsHeadlines({topic:'openai',window_hours:'168'});
 const items=out.headline_details as {title:string;outlet:string;published:string;url:string}[];
 expect(items).toHaveLength(5);expect(new Set(items.map(i=>i.url)).size).toBe(5);
 const lead=items.map(h=>`"${h.title}" (${h.outlet}, ${h.published}).`).join(' ');
 expect(String(out.answer).startsWith(lead)).toBe(true);expect(items[0].title).toBe(out.top_headline);
 for(const item of items)expect(item.published).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});
it('one available headline is not padded or duplicated to three',async()=>{
 vi.useFakeTimers();vi.setSystemTime(FROZEN);stub({hn:JSON.stringify({hits:[]}),gdelt:JSON.stringify({articles:[]}),bbc:'<rss><channel></channel></rss>'});
 const out=await handleNewsHeadlines({topic:'openai',window_hours:'168'});expect((out.headline_details as any[]).length).toBe(1);
});
