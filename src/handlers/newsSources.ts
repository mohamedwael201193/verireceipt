// Named news sources shared by NEWS_HEADLINES_GENERAL and NEWS_SEARCH_GENERAL.
//
// NAMED SOURCES ONLY: coverage is exactly the four keyless sources below,
// and every answer names the sources it used. This is never represented as
// comprehensive news coverage.
//
//  1. Hacker News story index via the Algolia API (hn.algolia.com, keyless):
//     an upstream full-text search over the whole HN story index. Because
//     Algolia relevance can return loose matches, HN hits are additionally
//     filtered locally on the title (every topic token must appear).
//  2. Google News RSS search (news.google.com/rss/search, keyless): an
//     upstream full-text news search; returned items are matches by
//     construction, so no local token filter is applied.
//     Terms risk: the feed notice limits reuse to personal, non-commercial
//     feed readers. Keyless access does not grant republication rights.
//  3. GDELT DOC 2.0 article list (api.gdeltproject.org, keyless): an
//     upstream full-text news search; same trust policy as Google News.
//     GDELT answers rate-limit and overload conditions with a 200 plain-text
//     notice instead of JSON; an unparseable body is treated as a source
//     failure and disclosed, never silently dropped.
//  4. BBC News World RSS (feeds.bbci.co.uk, keyless): NOT a search — only
//     the current feed file (about 35 items), matched locally by topic
//     tokens over title + description. Every answer says the BBC side is
//     its current feed only.
import { upstreamUnavailable } from "../core/errors";

const SOURCE_TIMEOUT_MS = 2500;
let gdeltBlockedUntil = 0;
export function resetNewsCircuitForTests(): void { gdeltBlockedUntil = 0; }
const UA = "VeriReceipt/2.0 news observer (+https://verireceipt.vercel.app)";

export const HN_INDEX = "Hacker News story index (Algolia API)";
export const GNEWS_INDEX = "Google News RSS search";
export const GDELT_INDEX = "GDELT DOC 2.0 article index";
export const BBC_INDEX = "BBC News World RSS (current feed only)";
export const INDEXES = [HN_INDEX, GNEWS_INDEX, GDELT_INDEX, BBC_INDEX];
// Deterministic tie-break order when two sources carry a headline with the
// same timestamp (applied after points and recency rules).
export const SOURCE_PRIORITY = [HN_INDEX, GNEWS_INDEX, GDELT_INDEX, BBC_INDEX];

export interface NewsItem {
  index: string; title: string; url: string;
  points: number | null; published: string; // ISO
  outlet?: string; // publisher name when the source provides one
}

export async function fetchText(url: string, timeoutMs=SOURCE_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "*/*" } });
    if (!res.ok || res.redirected) throw Object.assign(new Error("source response unavailable"), { safeReason: res.redirected ? "redirect" : "http_error", safeStatus: res.status });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function hnSearchUrl(query: string, cutoffUnix: number | null): string {
  const base = `https://hn.algolia.com/api/v1/${cutoffUnix===null?"search":"search_by_date"}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`;
  return cutoffUnix === null ? base : `${base}&numericFilters=${encodeURIComponent(`created_at_i>${cutoffUnix}`)}`;
}

export function gnewsSearchUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

export function gdeltSearchUrl(query: string, opts: { windowHours?: number | null; sort?: "datedesc" | "hybridrel" } = {}): string {
  const sort = opts.sort ?? "hybridrel";
  const base = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=25&format=json&sort=${sort}`;
  return opts.windowHours == null ? base : `${base}&timespan=${opts.windowHours}h`;
}

export function parseHn(raw: string): NewsItem[] {
  const d = JSON.parse(raw) as { hits?: unknown };
  if (!d || !Array.isArray(d.hits)) throw new Error("invalid HN search body");
  const out: NewsItem[] = [];
  for (const h of d.hits as Record<string, unknown>[]) {
    if (!h || typeof h !== "object" || typeof h.title !== "string") throw new Error("invalid HN hit");
    const title = String(h.title ?? "").trim();
    if (!title) continue;
    out.push({
      index: HN_INDEX, title,
      url: String(h.url ?? `https://news.ycombinator.com/item?id=${String(h.objectID ?? "")}`),
      points: typeof h.points === "number" ? h.points : null,
      published: typeof h.created_at_i === "number" ? new Date(h.created_at_i * 1000).toISOString() : String(h.created_at ?? ""),
    });
  }
  return out;
}

function cdata(s: string): string {
  const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(s);
  return (m ? m[1] : s).trim();
}

/** Reject non-RSS bodies and truncated/misnested XML before regex extraction.
 * This is the restricted RSS subset used by these feeds, not a general XML
 * reader. Unsupported declarations fail closed rather than implying zero hits.
 */
function validateRss(raw: string): void {
  const text = raw.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (!/^\s*<rss(?:\s[^<>]*)?>[\s\S]*<\/rss>\s*$/.test(text)) throw new Error("invalid RSS root");
  const stack: string[] = [];
  const tags = text.match(/<[^>]*>/g) ?? [];
  const remainder = text.replace(/<[^>]*>/g, "");
  if (/[<>]/.test(remainder)) throw new Error("invalid XML text");
  let channels = 0;
  for (const tag of tags) {
    const close = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(tag);
    if (close) {
      if (stack.pop() !== close[1]) throw new Error("misnested RSS XML");
      continue;
    }
    const open = /^<([A-Za-z_][\w:.-]*)(?:\s+[^<>]*)?\/?>$/.exec(tag);
    if (!open) throw new Error("unsupported XML declaration");
    if (open[1] === "channel" && stack.join("/") === "rss") channels++;
    if (!/\/>$/.test(tag)) stack.push(open[1]);
  }
  if (stack.length || channels !== 1) throw new Error("incomplete RSS channel");
}

export function parsedSource(result: FetchResult, parser: (raw: string) => NewsItem[] | null): NewsItem[] | null {
  if (!result.ok) return null;
  try { return parser(result.body); } catch { return null; }
}

function parseRssItems(raw: string, index: string): NewsItem[] {
  validateRss(raw);
  const out: NewsItem[] = [];
  const items = raw.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const it of items) {
    const t = /<title>([\s\S]*?)<\/title>/.exec(it);
    const l = /<link>([\s\S]*?)<\/link>/.exec(it);
    const p = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(it);
    const dsc = /<description>([\s\S]*?)<\/description>/.exec(it);
    const src = /<source[^>]*>([\s\S]*?)<\/source>/.exec(it);
    const title = t ? cdata(t[1]) : "";
    if (!title || !l || !p) throw new Error("invalid RSS item");
    const pub = p ? new Date(cdata(p[1])) : null;
    if (!pub || Number.isNaN(pub.getTime())) throw new Error("invalid RSS date");
    out.push({
      index, title,
      url: l ? cdata(l[1]) : "",
      points: null,
      published: pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : "",
      ...(src ? { outlet: cdata(src[1]) } : {}),
      // description retained only for topic matching via the raw block
      ...(dsc ? { description: cdata(dsc[1]) } : {}),
    } as NewsItem);
  }
  return out;
}

export function parseBbcRss(raw: string): NewsItem[] {
  return parseRssItems(raw, BBC_INDEX);
}

export function parseGnewsRss(raw: string): NewsItem[] {
  return parseRssItems(raw, GNEWS_INDEX);
}

/** GDELT seendate ("20261123T104500Z") to ISO; "" when unparseable. */
export function gdeltSeendateToIso(seendate: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(seendate.trim());
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

/**
 * Parse a GDELT DOC 2.0 artlist body. Returns null when the body is not the
 * expected JSON (GDELT serves rate-limit/overload notices as 200 plain
 * text); callers treat null as a source failure and disclose it.
 */
export function parseGdelt(raw: string): NewsItem[] | null {
  let d: { articles?: unknown };
  try {
    d = JSON.parse(raw) as { articles?: unknown };
  } catch {
    return null;
  }
  if (!d || !Array.isArray(d.articles)) return null;
  const out: NewsItem[] = [];
  for (const a of d.articles as Record<string, unknown>[]) {
    if (!a || typeof a !== "object" || typeof a.title !== "string") return null;
    const title = String(a.title ?? "").trim();
    if (!title) continue;
    out.push({
      index: GDELT_INDEX, title,
      url: String(a.url ?? ""),
      points: null,
      published: typeof a.seendate === "string" ? gdeltSeendateToIso(a.seendate) : "",
      ...(typeof a.domain === "string" && a.domain ? { outlet: a.domain } : {}),
    });
  }
  return out;
}

/** Topic match: every token of the topic must appear (normalized, case-insensitive). */
export function topicMatches(topic: string, text: string): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = norm(topic).split(" ").filter(Boolean);
  if (!tokens.length) return false;
  const hay = ` ${norm(text)} `;
  return tokens.every((t) => hay.includes(` ${t} `));
}

/** Deterministic HN ranking: points desc, then recency, then title. */
export function rankHn(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) =>
    (b.points ?? 0) - (a.points ?? 0) || b.published.localeCompare(a.published) || a.title.localeCompare(b.title));
}

/** Deterministic recency ranking across non-HN sources: published desc, then source priority, then title. */
export function rankRecent(items: NewsItem[]): NewsItem[] {
  const prio = (i: NewsItem) => SOURCE_PRIORITY.indexOf(i.index);
  return [...items].sort((a, b) =>
    b.published.localeCompare(a.published) || prio(a) - prio(b) || a.title.localeCompare(b.title));
}

export function inWindow(item: NewsItem, cutoffIso: string): boolean {
  return item.published !== "" && item.published >= cutoffIso;
}

export interface FetchResult { ok: boolean; body: string; failure_reason?: string }

export async function fetchIndex(url: string): Promise<FetchResult> {
  const host = new URL(url).hostname;
  const gdelt = host === "api.gdeltproject.org";
  if (gdelt && Date.now() < gdeltBlockedUntil) return { ok: false, body: "", failure_reason: "circuit_open" };
  try {
    let body:string;
    try {body=await fetchText(url,gdelt||host==='news.google.com'?4500:SOURCE_TIMEOUT_MS);}
    catch(e){
      if(host!=='news.google.com'||(e as any).safeStatus!==429)throw e;
      await new Promise(r=>setTimeout(r,1000));
      body=await fetchText(url,4500);
    }
    return { ok: true, body };
  } catch (error) {
    const e = error as { name?: string; safeReason?: string; safeStatus?: number };
    const reason = e.name === "AbortError" || e.name === "TimeoutError" ? "timeout" : e.safeReason ?? "transport_error";
    if (gdelt && reason === "timeout") gdeltBlockedUntil = Date.now() + 60000;
    console.warn(JSON.stringify({ event: "news_source_failure", source: host, reason, ...(e.safeStatus ? { status: e.safeStatus } : {}) }));
    return { ok: false, body: "", failure_reason: reason };
  }
}

export function allDown(): never {
  throw upstreamUnavailable("NEWS_INDEXES_UNREACHABLE", `all named news sources failed (${INDEXES.join("; ")}); no answer is guessed`);
}
