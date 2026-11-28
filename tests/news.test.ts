import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/news-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); resetNewsCircuitForTests(); resetHeadlineFeedsForTests(); });
import { resetHeadlineFeedsForTests } from "../src/handlers/newsHeadlineFeeds";
import { handleNewsHeadlines } from "../src/handlers/newsHeadlines";
import { handleNewsSearch, buildBrief } from "../src/handlers/newsSearch";
import { resetNewsCircuitForTests, parseHn, parseBbcRss, parseGnewsRss, parseGdelt, gdeltSeendateToIso, topicMatches, HN_INDEX, BBC_INDEX, GNEWS_INDEX, GDELT_INDEX, NewsItem, rankRecent } from "../src/handlers/newsSources";
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
    if(u.includes("/technology/"))throw new Error("topic feed not captured in legacy control");
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
    expect((result.headlines as string[])[0]).toBe(result.top_headline);
    expect((result.urls as string[])[0]).toBe(parseHn(hn).find(h=>h.title===result.top_headline)!.url);
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
    expect(ev.raw_bodies.gdelt).toBe("");
    expect(ev.omitted_indexes[0]).toContain("GDELT omitted");
    expect(ev.raw_bodies.bbc).toBe(bbc);
  });
  it("a topic with no HN match uses Google News when GDELT is omitted", async () => {
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
    expect(result.top_headline).toBe("Acme Robotics unveils warehouse arm - Example News");
    expect((result.headlines as string[])[0]).toBe(result.top_headline);
    expect((result.urls as string[])[0]).toBe("https://news.google.com/rss/articles/x1");
    const headlines = result.headlines as string[];
    expect(headlines).toContain("Acme Robotics unveils warehouse arm - Example News");
    expect(headlines).not.toContain("Acme Robotics expands to Cairo");
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
  it("GDELT is omitted from headlines while other sources answer", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub({ gdelt: "Please limit requests to one every 5 seconds" });
    const result = await handleNewsHeadlines({ topic: "openai", window_hours: "168" });
    expect(result.top_headline).toBe("Advancing chip design with OpenAI models");
    expect((result.headlines as string[])[0]).toBe(result.top_headline);
    expect((result.urls as string[])[0]).toBe(parseHn(hn).find(h=>h.title===result.top_headline)!.url);
    expect(String(result.answer)).toContain("Degraded");
    expect(String(result.answer)).not.toContain(GDELT_INDEX);
  });
  it("degrades honestly when one index is down, 502 when all are", async () => {
    vi.useFakeTimers(); vi.setSystemTime(FROZEN);
    stub({ bbc: "ERR" });
    const result = await handleNewsHeadlines({ topic: "openai", window_hours: "168" });
    expect(result.top_headline).toBe("Advancing chip design with OpenAI models");
    expect((result.headlines as string[])[0]).toBe(result.top_headline);
    expect((result.urls as string[])[0]).toBe(parseHn(hn).find(h=>h.title===result.top_headline)!.url);
    expect(String(result.answer)).toContain("Degraded");
    vi.unstubAllGlobals(); resetHeadlineFeedsForTests();
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
    expect(Number(result.result_count)).toBeGreaterThanOrEqual(1);
    expect((result.sources as string[]).join(" ")).toContain("Story search");
    expect((result.sources as string[]).join(" ")).toContain("Encyclopedia search");
    expect((result.sources as string[]).join(" ")).toContain("Community news search");
    const brief = String(result.brief);
    expect(Array.from(brief).length).toBeLessThanOrEqual(80);
    expect(brief).not.toMatch(/Closest|pts|Named sources only/);
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
    expect(brief).toBe('No recent news found for "zzq nonexistent".');
    expect(Array.from(brief).length).toBeLessThanOrEqual(80);
    expect(String(result.answer).startsWith('No recent news found for "zzq nonexistent".')).toBe(true);
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
      if(source==="gdelt"){await expect(handleNewsHeadlines({topic:"openai"})).rejects.toMatchObject({code:"NEWS_INDEXES_UNREACHABLE"});}
      else {const h = await handleNewsHeadlines({ topic: "openai" });
      expect(h.headlines).toEqual([]);
      expect(String(h.answer)).toContain("Degraded");}
      if(source==="gnews"||source==="gdelt"){await expect(handleNewsSearch({query:"openai"})).rejects.toMatchObject({code:"NEWS_INDEXES_UNREACHABLE"});return;}
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
it("search answer lists dated captured result details with matching URLs",async()=>{
 stub();const out=await handleNewsSearch({query:"openai"});const items=out.results as any[];expect(items.length).toBeGreaterThan(0);expect(String(out.answer)).toContain(items[0].title);expect(String(out.answer)).toContain(items[0].date);expect(String(out.answer)).toContain(items[0].source);expect(String(out.answer)).toContain(items[0].url);expect(out.urls).toEqual(items.map(i=>i.url));
});
it("GDELT timeout breaker expires at one minute and recovered source is retried",async()=>{
 const {fetchIndex,resetNewsCircuitForTests}=await import("../src/handlers/newsSources");resetNewsCircuitForTests();
 const now=Date.now();const clock=vi.spyOn(Date,"now").mockReturnValue(now);const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
 const f=vi.fn().mockRejectedValueOnce(Object.assign(new Error("timeout"),{name:"AbortError"})).mockImplementation(async()=>new Response(gdelt));vi.stubGlobal("fetch",f);
 try{await fetchIndex("https://api.gdeltproject.org/api/v2/doc/doc?query=test");
 clock.mockReturnValue(now+59999);expect((await fetchIndex("https://api.gdeltproject.org/api/v2/doc/doc?query=test")).failure_reason).toBe("circuit_open");expect(f).toHaveBeenCalledTimes(1);
 clock.mockReturnValue(now+60000);const recovered=await fetchIndex("https://api.gdeltproject.org/api/v2/doc/doc?query=test");expect(f).toHaveBeenCalledTimes(2);expect(recovered.body).toBe(gdelt);
 }finally{clock.mockRestore();warn.mockRestore();resetNewsCircuitForTests()}
});
it('headline answer starts with up to five unique captured dated outlet-attributed items, retaining scored top',async()=>{
 vi.useFakeTimers();vi.setSystemTime(FROZEN);stub();
 const out=await handleNewsHeadlines({topic:'openai',window_hours:'168'});
 const items=out.headline_details as {title:string;outlet:string;published:string;url:string}[];
 expect(items).toHaveLength(10);expect(new Set(items.map(i=>i.url)).size).toBe(10);
 const lead=items.map(h=>`"${h.title}" (${h.outlet}, ${h.published}).`).join(' ');
 expect(String(out.answer).startsWith(lead)).toBe(true);expect(items[0].title).toBe(out.top_headline);
 for(const item of items)expect(item.published).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});
it('one available headline is not padded or duplicated to three',async()=>{
 vi.useFakeTimers();vi.setSystemTime(FROZEN);stub({hn:JSON.stringify({hits:[]}),gdelt:JSON.stringify({articles:[]}),bbc:'<rss><channel></channel></rss>'});
 const out=await handleNewsHeadlines({topic:'openai',window_hours:'168'});expect((out.headline_details as any[]).length).toBe(1);
});

it('search widens empty7day story title search to365days and saves all raw bodies',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-12-20T01:00:00Z'));const seen:string[]=[];
 vi.stubGlobal('fetch',async(u:any)=>{const url=String(u);seen.push(url);return new Response(url.includes('algolia')?hn:bbc);});
 const out=await handleNewsSearch({query:'openai'});expect(out.hn_window_days).toBe(365);const urls=seen.filter(u=>u.includes('algolia'));expect(urls).toHaveLength(3);expect(urls[0]).toContain('search_by_date');expect(urls.slice(1).every(u=>u.includes('/search?'))).toBe(true);expect(decodeURIComponent(urls[1])).toContain('created_at_i>'+Math.floor((Date.now()-365*86400000)/1000));
 const stored=await getReceiptEvidence((out.receipt as any).receipt_id);const e=JSON.parse(Buffer.from(stored.evidence!).toString());expect(e.story_captures[0].result.body).toBe(hn);expect(e.closest_hn_matches.every((i:any)=>Date.parse(i.published)>=Date.now()-365*86400000)).toBe(true);
});
it('Google429 gets exactly one bounded retry, Google503 gets none',async()=>{
 vi.useFakeTimers();const {fetchIndex}=await import('../src/handlers/newsSources');const f=vi.fn().mockResolvedValueOnce(new Response('rate',{status:429})).mockResolvedValueOnce(new Response(gnews));vi.stubGlobal('fetch',f);const p=fetchIndex('https://news.google.com/rss/search?q=openai');await vi.advanceTimersByTimeAsync(1000);expect((await p).body).toBe(gnews);expect(f).toHaveBeenCalledTimes(2);
 const g=vi.fn(async()=>new Response('unavailable',{status:503}));vi.stubGlobal('fetch',g);expect((await fetchIndex('https://news.google.com/rss/search?q=openai')).ok).toBe(false);expect(g).toHaveBeenCalledTimes(1);
});
it.each(['https://news.google.com/rss/search?q=test','https://api.gdeltproject.org/api/v2/doc/doc?query=test'])('source budget2500ms for %s',async url=>{
 vi.useFakeTimers();const {fetchIndex,resetNewsCircuitForTests}=await import('../src/handlers/newsSources');resetNewsCircuitForTests();const f=vi.fn((_u:any,o:any)=>new Promise<Response>((_resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Object.assign(new Error('timeout'),{name:'AbortError'})))));vi.stubGlobal('fetch',f);let done=false;const p=fetchIndex(url).then(r=>{done=true;return r;});await vi.advanceTimersByTimeAsync(2499);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);expect((await p).failure_reason).toBe('timeout');resetNewsCircuitForTests();
});
it('recent relevant7day HN match stays7days with one request, future hit excluded from matches and dated lead',async()=>{
 vi.useFakeTimers();vi.setSystemTime(FROZEN);const captured=JSON.parse(hn);const recent=captured.hits.find((h:any)=>h.title&&topicMatches('openai',h.title)&&h.created_at_i<=Date.now()/1000&&h.created_at_i>=Date.now()/1000-7*86400);expect(recent).toBeDefined();const future={...recent,title:'OpenAI future control',created_at_i:Math.floor(Date.now()/1000)+86400};const body=JSON.stringify({...captured,hits:[future,recent]});let calls=0;
 vi.stubGlobal('fetch',async(u:any)=>{if(String(u).includes('algolia')){calls++;return new Response(body);}throw Error('other source down');});
 const out=await handleNewsSearch({query:'openai'});expect(out.hn_window_days).toBe(7);expect(calls).toBe(1);expect(out.answer).not.toContain(future.title);const st=await getReceiptEvidence((out.receipt as any).receipt_id);const e=JSON.parse(Buffer.from(st.evidence!).toString());expect(e.hn_matches).toHaveLength(1);expect(e.hn_matches[0].title).toBe(recent.title);
});

it('mapped technology feed supplies10dated outlet items with exact raw proof, not a single HN story',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-25T07:00:00Z'));
 const raw=readFileSync(join(__dirname,'fixtures/news/bbc-technology-20261125.xml'),'utf8');const seen:string[]=[];
 vi.stubGlobal('fetch',async(u:any)=>{const url=String(u);seen.push(url);if(url.includes('/technology/'))return new Response(raw);throw Error('other source down');});
 const out=await handleNewsHeadlines({topic:'technology',window_hours:'720'});const details=out.headline_details as any[];expect(details.length).toBeGreaterThanOrEqual(5);expect(details.length).toBeLessThanOrEqual(10);expect(details[0].title).toBe(out.top_headline);expect(details.every(i=>i.outlet==='BBC technology current RSS'&&Number.isFinite(Date.parse(i.published)))).toBe(true);expect(seen).toContain('https://feeds.bbci.co.uk/news/technology/rss.xml');const st=await getReceiptEvidence((out.receipt as any).receipt_id);expect(JSON.parse(Buffer.from(st.evidence!).toString()).raw_bodies.topic_feed).toBe(raw);
});
it('topic feeds are closed mapping and ambiguous categories never silently choose one',async()=>{const {topicFeed}=await import('../src/handlers/newsHeadlines');expect(topicFeed('business')?.url).toBe('https://feeds.bbci.co.uk/news/business/rss.xml');expect(topicFeed('health')?.url).toContain('/health/');expect(topicFeed('climate')?.url).toContain('/science_and_environment/');expect(topicFeed('technology business')).toBeNull();expect(topicFeed('../../private')).toBeNull();});
it('topical feed excludes future and expired items in exact answer and evidence',async()=>{
 vi.useFakeTimers();vi.setSystemTime(FROZEN);const one=(title:string,date:string)=>`<item><title>${title}</title><link>https://example.org/${title}</link><pubDate>${date}</pubDate></item>`;const raw='<rss><channel>'+one('valid','Sun, 22 Nov 2026 23:00:00 GMT')+one('future','Tue, 24 Nov 2026 23:00:00 GMT')+one('expired','Thu, 19 Nov 2026 23:00:00 GMT')+'</channel></rss>';
 vi.stubGlobal('fetch',async(u:any)=>{if(String(u).includes('/technology/'))return new Response(raw);throw Error('down');});const out=await handleNewsHeadlines({topic:'technology'});expect(out.top_headline).toBe('valid');expect(out.headlines).toEqual(['valid']);expect(out.answer).toContain('Topic mapping is category coverage, not an exact keyword search.');const st=await getReceiptEvidence((out.receipt as any).receipt_id);expect(JSON.parse(Buffer.from(st.evidence!).toString()).topic_feed_items.map((i:any)=>i.title)).toEqual(['valid']);
});
it('empty sole topical feed remains searched and reachable, mapped failure is degraded',async()=>{
 vi.stubGlobal('fetch',async(u:any)=>{if(String(u).includes('/technology/'))return new Response('<rss><channel></channel></rss>');throw Error('down');});const out=await handleNewsHeadlines({topic:'technology'});expect(out.top_headline).toBeNull();expect(out.answer).toContain('BBC technology current RSS');expect(out.source).not.toContain('no source reachable');let st=await getReceiptEvidence((out.receipt as any).receipt_id);expect(JSON.parse(Buffer.from(st.evidence!).toString()).indexes).toContain('BBC technology current RSS');
 resetHeadlineFeedsForTests();stub();const failed=await handleNewsHeadlines({topic:'technology'});expect(failed.answer).toContain('Degraded: BBC technology current RSS');expect(failed.answer).toContain('unavailable');st=await getReceiptEvidence((failed.receipt as any).receipt_id);expect(JSON.parse(Buffer.from(st.evidence!).toString()).unavailable_indexes).toContain('BBC technology current RSS');
});
it.each(['headlines'])('%s shared deadline survives abort-ignoring slow sources and opens both breakers',async mode=>{vi.useFakeTimers();vi.setSystemTime(FROZEN);const calls:string[]=[];vi.stubGlobal('fetch',async(u:any)=>{const url=String(u);calls.push(url);if(url.includes('google')||url.includes('gdelt'))return new Promise<Response>(()=>{});return new Response(url.includes('algolia')?hn:bbc);});const start=Date.now();const run=()=>mode==='search'?handleNewsSearch({query:'openai'}):handleNewsHeadlines({topic:'openai',window:'24h'});const p=run();await vi.advanceTimersByTimeAsync(3300);const out=await p;expect(Date.now()-start).toBe(3300);expect(out.answer).toContain('Google News RSS search');if(mode==='search')expect(out.answer).toContain('GDELT');const n=calls.filter(u=>u.includes('google')||u.includes('gdelt')).length;expect(n).toBe(2);await run();expect(calls.filter(u=>u.includes('google')||u.includes('gdelt'))).toHaveLength(n);});
it('HN widening uses only remaining shared deadline, never a second full source budget',async()=>{vi.useFakeTimers();vi.setSystemTime(FROZEN);let hnCalls=0;vi.stubGlobal('fetch',async(u:any)=>{if(String(u).includes('algolia')){hnCalls++;if(hnCalls===1){await new Promise(r=>setTimeout(r,2000));return new Response('{"hits":[]}');}return new Promise<Response>(()=>{});}return new Response(String(u).includes('google')?gnews:String(u).includes('gdelt')?gdelt:bbc);});const start=Date.now();const p=handleNewsSearch({query:'openai'});await vi.advanceTimersByTimeAsync(2500);expect((await p).verdict).toBe('verified');expect(Date.now()-start).toBe(2500);expect(hnCalls).toBe(3);});
it.each(['fetch','body'])('slow-host ownership survives breaker expiry until abort-ignoring %s settles',async stage=>{vi.useFakeTimers();const {fetchIndex}=await import('../src/handlers/newsSources');let release:any;const f=vi.fn(async()=>stage==='fetch'?new Promise<Response>(r=>release=()=>r(new Response(gnews))):({ok:true,status:200,redirected:false,text:()=>new Promise<string>(r=>release=()=>r(gnews))} as Response));vi.stubGlobal('fetch',f);const p=fetchIndex('https://news.google.com/rss/search?q=test');await vi.advanceTimersByTimeAsync(2500);await p;await vi.advanceTimersByTimeAsync(60001);expect((await fetchIndex('https://news.google.com/rss/search?q=other')).failure_reason).toBe('circuit_open');expect(f).toHaveBeenCalledTimes(1);release();await vi.advanceTimersByTimeAsync(1);f.mockImplementation(async()=>new Response(gnews));expect((await fetchIndex('https://news.google.com/rss/search?q=other')).ok).toBe(true);expect(f).toHaveBeenCalledTimes(2);});
it('post-source persistence helper fails within remaining total budget',async()=>{vi.useFakeTimers();const {withinNewsDeadline}=await import('../src/handlers/newsSources');const p=withinNewsDeadline(new Promise(()=>{}),Date.now()+450).catch(e=>e);await vi.advanceTimersByTimeAsync(450);expect((await p).message).toContain('persistence deadline');});
it('Google backoff owns host across429 sleep, no concurrent caller or overlapping retry',async()=>{vi.useFakeTimers();const {fetchIndex}=await import('../src/handlers/newsSources');let release:any;const f=vi.fn().mockResolvedValueOnce(new Response('rate',{status:429})).mockImplementation(()=>new Promise<Response>(r=>release=r));vi.stubGlobal('fetch',f);const a=fetchIndex('https://news.google.com/rss/search?q=first');await vi.advanceTimersByTimeAsync(1);const b=await fetchIndex('https://news.google.com/rss/search?q=second');expect(b.failure_reason).toBe('circuit_open');expect(f).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(999);expect(f).toHaveBeenCalledTimes(2);release(new Response(gnews));await vi.advanceTimersByTimeAsync(1);expect((await a).ok).toBe(true);expect(f).toHaveBeenCalledTimes(2);});
