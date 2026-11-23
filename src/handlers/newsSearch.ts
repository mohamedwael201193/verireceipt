// NEWS_SEARCH_GENERAL — GET /v1/news-search?query=<q>
//
// Zero-LLM. A deterministic digest of what the four NAMED keyless sources in
// newsSources.ts carry for a query, with a SHA-256 receipt over the exact
// upstream bodies. Never "all news".
//
// Intent contract (read 2026-11-22): request query (string); response
// brief (scored, max 256 bytes); off-chain answer, result_count,
// sources.
//
// No window: the HN Algolia search runs in its default relevance order over
// the whole story index; Google News RSS and GDELT DOC 2.0 search their own
// current indexes (GDELT artlist in hybrid relevance order); the BBC side
// searches only its current World RSS feed (about 35 items) — every scope
// is named in the brief.
//
// A query with zero matches is an honest 200 with result_count 0 and a
// brief naming the sources searched — never a refusal for a well-formed
// query. A 502 only when every named source is unreachable.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { BBC_INDEX, GDELT_INDEX, GNEWS_INDEX, HN_INDEX, INDEXES, NewsItem, allDown, fetchIndex, gdeltSearchUrl, gnewsSearchUrl, hnSearchUrl, parseBbcRss, parseGdelt, parseGnewsRss, parseHn, parsedSource, topicMatches } from "./newsSources";

const BBC_URL = "https://feeds.bbci.co.uk/news/world/rss.xml";
// The contract budget is BYTES (response brief max_bytes 256), not
// characters: multi-byte titles must never overflow it.
const BRIEF_MAX_BYTES = 256;

export const INTENT = "NEWS_SEARCH_GENERAL";

/** Truncate to at most maxBytes UTF-8 bytes, ending with an ellipsis and never splitting a multi-byte character. */
export function capBytes(text: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return text;
  const ellipsis = "…"; // 3 UTF-8 bytes
  const budget = maxBytes - enc.encode(ellipsis).length;
  const truncated = new TextDecoder("utf-8").decode(enc.encode(text).slice(0, budget));
  // The tolerant decoder maps a split code point to U+FFFD; drop any trailing partial.
  return truncated.replace(/\uFFFD+$/, "") + ellipsis;
}

export interface BriefGroup {
  label: string;
  items: NewsItem[];
}

/**
 * Deterministic 256-byte digest: per-source match counts, the single top
 * item (first non-empty group in source-priority order), and the scope
 * suffix. The title is capped to whatever budget the fixed parts leave so
 * the suffix is never truncated away.
 */
export function buildBrief(groups: BriefGroup[]): string {
  const counts = groups.map((g) => `${g.label}: ${g.items.length}`).join(", ");
  const suffix = ". Named sources only.";
  const topItem = groups.flatMap((g) => g.items)[0];
  let mid = "";
  if (topItem) {
    const pts = topItem.points !== null ? ` (${topItem.points} pts)` : "";
    const fixed = new TextEncoder().encode(`${counts}. Top: ""${pts}${suffix}`).length;
    const budget = BRIEF_MAX_BYTES - fixed;
    if (budget > 0) mid = `. Top: "${capBytes(topItem.title, budget)}"${pts}`;
  }
  const brief = counts + mid + suffix;
  // Safety net: the fixed parts alone can never exceed the budget, but
  // never ship a brief over 256 bytes whatever the inputs.
  return capBytes(brief, BRIEF_MAX_BYTES);
}

export async function handleNewsSearch(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const q = query.query?.trim();
  if (!q) throw badRequest("MISSING_PARAM", "query is required");
  if (q.length > 120) throw badRequest("QUERY_TOO_LONG", "query must be at most 120 characters");
  const fetchedAt = new Date().toISOString();
  const hnUrl = hnSearchUrl(q, null);
  const gnewsUrl = gnewsSearchUrl(q);
  const gdeltUrl = gdeltSearchUrl(q, { sort: "hybridrel" });
  const [hnRes, gnewsRes, gdeltRes, bbcRes] = await Promise.all([
    fetchIndex(hnUrl), fetchIndex(gnewsUrl), fetchIndex(gdeltUrl), fetchIndex(BBC_URL),
  ]);

  // A transport-level 200 is not evidence of a valid search result.
  const hnParsed = parsedSource(hnRes, parseHn);
  const gnewsParsed = parsedSource(gnewsRes, parseGnewsRss);
  const gdeltParsed = parsedSource(gdeltRes, parseGdelt);
  const bbcParsed = parsedSource(bbcRes, parseBbcRss);
  const hnOk = hnParsed !== null;
  const gnewsOk = gnewsParsed !== null;
  const gdeltOk = gdeltParsed !== null;
  const bbcOk = bbcParsed !== null;
  if (!hnOk && !gnewsOk && !gdeltOk && !bbcOk) allDown();
  const hnAll = hnParsed ?? [];
  const gnewsAll = gnewsParsed ?? [];
  const gdeltAll = gdeltParsed ?? [];
  const bbcAll = bbcParsed ?? [];
  // HN: Algolia relevance order as returned, title token-filtered locally.
  // Google News and GDELT: upstream full-text searches, matches by
  // construction, order as returned. BBC: title+description token match
  // over the current feed.
  const hn = hnAll.filter((i) => topicMatches(q, i.title));
  const gnews = gnewsAll;
  const gdelt = gdeltAll;
  const bbc = bbcAll
    .filter((i) => topicMatches(q, `${i.title} ${(i as NewsItem & { description?: string }).description ?? ""}`));
  const failed = [
    !hnOk ? HN_INDEX : null,
    !gnewsOk ? GNEWS_INDEX : null,
    !gdeltOk ? GDELT_INDEX : null,
    !bbcOk ? BBC_INDEX : null,
  ].filter(Boolean) as string[];
  const searched = [hnOk ? HN_INDEX : null, gnewsOk ? GNEWS_INDEX : null, gdeltOk ? GDELT_INDEX : null, bbcOk ? BBC_INDEX : null].filter(Boolean);
  const groups: BriefGroup[] = [
    { label: "HN", items: hn },
    { label: "Google News", items: gnews },
    { label: "GDELT", items: gdelt },
    { label: "BBC World current feed", items: bbc },
  ];
  const brief = buildBrief(groups);
  const resultCount = hn.length + gnews.length + gdelt.length + bbc.length;
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ query: q, as_of: asOf, indexes: INDEXES, unavailable_indexes: failed,
    hn_matches: hn, gnews_matches: gnews, gdelt_matches: gdelt, bbc_matches: bbc,
    source_policy: "four named keyless sources (HN Algolia story index, whole index, relevance order; Google News RSS search; GDELT DOC 2.0 artlist, hybrid relevance; BBC News World current RSS feed); never comprehensive news coverage",
    raw_bodies: { hn: hnRes.body, gnews: gnewsRes.body, gdelt: gdeltRes.body, bbc: bbcRes.body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, hnUrl, evidence, "four named keyless sources (HN Algolia + Google News RSS + GDELT DOC 2.0 + BBC World RSS), honestly scoped");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const fmt = (i: NewsItem) => `"${i.title}"${i.points !== null ? ` (${i.points} pts, ${i.published.slice(0, 10)})` : ` (${i.published.slice(0, 10)})`}`;
  const top = groups.flatMap(g => g.items).slice(0, 3);
  const lead = top.length ? top.map(i => `"${i.title}" (${i.published.slice(0, 10)}, ${i.outlet ?? i.index}).`).join(" ") + " " : "No matching headlines found in the named sources. ";
  const answer = lead + `${brief} ` +
    (hn.length ? `HN top: ${hn.slice(0, 3).map(fmt).join("; ")}. ` : "") +
    (gnews.length ? `Google News: ${gnews.slice(0, 3).map(fmt).join("; ")}. ` : "") +
    (gdelt.length ? `GDELT: ${gdelt.slice(0, 3).map(fmt).join("; ")}. ` : "") +
    (bbc.length ? `BBC World: ${bbc.slice(0, 3).map(fmt).join("; ")}. ` : "") +
    (resultCount === 0 ? `Sources searched: ${searched.join("; ")} — zero matches. ` : "") +
    (failed.length ? `Degraded: ${failed.join(", ")} unavailable. ` : "") +
    `Coverage: ${INDEXES.join("; ")} — named sources, never comprehensive news coverage.`;
  // `answer` is an envelope-reserved key; the digest travels there.
  return envelope(INTENT, {
    brief,
    result_count: resultCount,
    sources: INDEXES,
  }, receipt, { answer, verdict: "verified", confidence: resultCount === 0 ? 0.5 : 0.8,
    source: `${hnUrl} + ${gnewsUrl} + ${gdeltUrl} + ${BBC_URL}; named sources only; fetched ${fetchedAt}` });
}
