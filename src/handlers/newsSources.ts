// Named news indexes shared by NEWS_HEADLINES_GENERAL and NEWS_SEARCH_GENERAL.
//
// NAMED INDEXES ONLY (maintainer ruling 2026-11-23): the coverage is exactly
// two named indexes, always named in every answer — the Hacker News story
// index via the Algolia API (hn.algolia.com, keyless) and the current BBC
// News World RSS feed (feeds.bbci.co.uk, keyless). The BBC "index" is only
// its current feed file (about 35 items), and every answer says so. This is
// never represented as comprehensive news coverage.
import { upstreamUnavailable } from "../core/errors";

const SOURCE_TIMEOUT_MS = 6000;
const UA = "VeriReceipt/2.0 news observer (+https://verireceipt.vercel.app)";

export const HN_INDEX = "Hacker News story index (Algolia API)";
export const BBC_INDEX = "BBC News World RSS (current feed only)";
export const INDEXES = [HN_INDEX, BBC_INDEX];

export interface NewsItem {
  index: string; title: string; url: string;
  points: number | null; published: string; // ISO
}

export async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "*/*" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function hnSearchUrl(query: string, cutoffUnix: number | null): string {
  const base = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`;
  return cutoffUnix === null ? base : `${base}&numericFilters=${encodeURIComponent(`created_at_i>${cutoffUnix}`)}`;
}

export function parseHn(raw: string): NewsItem[] {
  const d = JSON.parse(raw) as { hits?: unknown };
  if (!Array.isArray(d.hits)) return [];
  const out: NewsItem[] = [];
  for (const h of d.hits as Record<string, unknown>[]) {
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

export function parseBbcRss(raw: string): NewsItem[] {
  const out: NewsItem[] = [];
  const items = raw.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const it of items) {
    const t = /<title>([\s\S]*?)<\/title>/.exec(it);
    const l = /<link>([\s\S]*?)<\/link>/.exec(it);
    const p = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(it);
    const dsc = /<description>([\s\S]*?)<\/description>/.exec(it);
    const title = t ? cdata(t[1]) : "";
    if (!title) continue;
    const pub = p ? new Date(cdata(p[1])) : null;
    out.push({
      index: BBC_INDEX, title,
      url: l ? cdata(l[1]) : "",
      points: null,
      published: pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : "",
      // description retained only for topic matching via the raw block
      ...(dsc ? { description: cdata(dsc[1]) } : {}),
    } as NewsItem);
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

export function inWindow(item: NewsItem, cutoffIso: string): boolean {
  return item.published !== "" && item.published >= cutoffIso;
}

export async function fetchIndex(url: string): Promise<{ ok: boolean; body: string }> {
  try {
    return { ok: true, body: await fetchText(url) };
  } catch {
    return { ok: false, body: "" };
  }
}

export function bothDown(): never {
  throw upstreamUnavailable("NEWS_INDEXES_UNREACHABLE", `both named indexes failed (${INDEXES.join("; ")}); no answer is guessed`);
}
