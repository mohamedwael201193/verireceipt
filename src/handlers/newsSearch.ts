// NEWS_SEARCH_GENERAL — GET /v1/news-search?query=<q>
//
// Zero-LLM. A deterministic digest of what the two NAMED indexes in
// newsSources.ts carry for a query, with a SHA-256 receipt over the
// exact upstream bodies. Never "all news".
//
// Intent contract (read 2026-11-22): request query (string); response
// brief (scored, max 256 bytes); off-chain answer, result_count,
// sources.
//
// No window: the HN Algolia search runs in its default relevance order
// over the whole story index; the BBC side searches only its current
// World RSS feed (about 35 items) — both scopes are named in the brief.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { BBC_INDEX, HN_INDEX, INDEXES, NewsItem, bothDown, fetchIndex, hnSearchUrl, parseBbcRss, parseHn, topicMatches } from "./newsSources";

const BBC_URL = "https://feeds.bbci.co.uk/news/world/rss.xml";
const BRIEF_MAX = 256;

export const INTENT = "NEWS_SEARCH_GENERAL";

export function buildBrief(hn: NewsItem[], bbc: NewsItem[], failed: string[]): string {
  const parts: string[] = [];
  parts.push(hn.length ? `HN: ${hn.length} stories, top "${hn[0].title}"${hn[0].points !== null ? ` (${hn[0].points} pts)` : ""}` : "HN: no matching stories");
  parts.push(bbc.length ? `BBC World current feed: ${bbc.length} items, top "${bbc[0].title}"` : "BBC World current feed: no matching items");
  let brief = parts.join("; ") + ". Named indexes only.";
  if (failed.length) brief += ` Degraded: ${failed.join(", ")} unavailable.`;
  if (brief.length > BRIEF_MAX) brief = `${brief.slice(0, BRIEF_MAX - 1)}…`;
  return brief;
}

export async function handleNewsSearch(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const q = query.query?.trim();
  if (!q) throw badRequest("MISSING_PARAM", "query is required");
  if (q.length > 120) throw badRequest("QUERY_TOO_LONG", "query must be at most 120 characters");
  const fetchedAt = new Date().toISOString();
  const hnUrl = hnSearchUrl(q, null);
  const [hnRes, bbcRes] = await Promise.all([fetchIndex(hnUrl), fetchIndex(BBC_URL)]);
  if (!hnRes.ok && !bbcRes.ok) bothDown();
  // HN: Algolia relevance order as returned. BBC: title+description token match over the current feed.
  const hn = (hnRes.ok ? parseHn(hnRes.body) : []).filter((i) => topicMatches(q, i.title));
  const bbc = (bbcRes.ok ? parseBbcRss(bbcRes.body) : [])
    .filter((i) => topicMatches(q, `${i.title} ${(i as NewsItem & { description?: string }).description ?? ""}`));
  const failed = [!hnRes.ok ? HN_INDEX : null, !bbcRes.ok ? BBC_INDEX : null].filter(Boolean) as string[];
  if (hn.length === 0 && bbc.length === 0) {
    throw unprocessable("NO_RESULTS", `nothing matching "${q}" in the named indexes (${INDEXES.join("; ")})${failed.length ? `; unavailable: ${failed.join(", ")}` : ""}`);
  }
  const brief = buildBrief(hn, bbc, failed);
  const resultCount = hn.length + bbc.length;
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ query: q, as_of: asOf, indexes: INDEXES, unavailable_indexes: failed,
    hn_matches: hn, bbc_matches: bbc,
    source_policy: "two named indexes only (HN Algolia story index, whole index, relevance order; BBC News World current RSS feed); never comprehensive news coverage",
    raw_bodies: { hn: hnRes.body, bbc: bbcRes.body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, hnUrl, evidence, "two named indexes only (HN Algolia + BBC World RSS), honestly scoped");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const fmt = (i: NewsItem) => `"${i.title}"${i.points !== null ? ` (${i.points} pts, ${i.published.slice(0, 10)})` : ` (${i.published.slice(0, 10)})`}`;
  const answer = `${brief} ` +
    (hn.length ? `HN top: ${hn.slice(0, 3).map(fmt).join("; ")}. ` : "") +
    (bbc.length ? `BBC World: ${bbc.slice(0, 3).map(fmt).join("; ")}. ` : "") +
    `Coverage: ${INDEXES.join(" and ")} only — named indexes, never comprehensive news coverage.`;
  // `answer` is an envelope-reserved key; the digest travels there.
  return envelope(INTENT, {
    brief,
    result_count: resultCount,
    sources: INDEXES,
  }, receipt, { answer, verdict: "verified", confidence: 0.8,
    source: `${hnUrl} + ${BBC_URL}; two named indexes only; fetched ${fetchedAt}` });
}
