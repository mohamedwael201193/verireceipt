// NEWS_HEADLINES_GENERAL — GET /v1/news-headlines?topic=<t>&window_hours=<h>
//
// Zero-LLM. Top headline for a topic from the two NAMED indexes in
// newsSources.ts (Hacker News via Algolia, current BBC News World RSS),
// with a SHA-256 receipt over the exact upstream bodies. Never "all news".
//
// Intent contract (read 2026-11-22): request topic (string); response
// top_headline (scored); off-chain topic, headlines, urls, window.
// window_hours defaults to 24, bounded 1..720.
//
// top_headline rule (deterministic, disclosed): the highest-points
// Hacker News story matching the topic inside the window; if none, the
// most recent matching BBC World item; if none at all, an honest 422 —
// never a stale or invented headline.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { BBC_INDEX, HN_INDEX, INDEXES, NewsItem, bothDown, fetchIndex, hnSearchUrl, inWindow, parseBbcRss, parseHn, rankHn, topicMatches } from "./newsSources";

const BBC_URL = "https://feeds.bbci.co.uk/news/world/rss.xml";

export const INTENT = "NEWS_HEADLINES_GENERAL";

export async function handleNewsHeadlines(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const topic = query.topic?.trim();
  if (!topic) throw badRequest("MISSING_PARAM", "topic is required");
  if (topic.length > 120) throw badRequest("TOPIC_TOO_LONG", "topic must be at most 120 characters");
  let windowHours = 24;
  if (query.window_hours !== undefined && query.window_hours.trim() !== "") {
    const w = Number(query.window_hours);
    if (!Number.isInteger(w) || w < 1 || w > 720) throw badRequest("BAD_WINDOW", "window_hours must be an integer in [1, 720]");
    windowHours = w;
  }
  const now = Date.now();
  const cutoffUnix = Math.floor(now / 1000) - windowHours * 3600;
  const cutoffIso = new Date(cutoffUnix * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const hnUrl = hnSearchUrl(topic, cutoffUnix);
  const [hnRes, bbcRes] = await Promise.all([fetchIndex(hnUrl), fetchIndex(BBC_URL)]);
  if (!hnRes.ok && !bbcRes.ok) bothDown();
  const hnAll = hnRes.ok ? parseHn(hnRes.body) : [];
  const bbcAll = bbcRes.ok ? parseBbcRss(bbcRes.body) : [];
  // The HN request is window-filtered upstream; the BBC feed is filtered
  // here by pubDate and topic. HN hits are additionally topic-filtered
  // locally on the title because Algolia relevance can return loose matches.
  const hn = rankHn(hnAll.filter((i) => topicMatches(topic, i.title)));
  const bbc = bbcAll
    .filter((i) => topicMatches(topic, `${i.title} ${(i as NewsItem & { description?: string }).description ?? ""}`) && inWindow(i, cutoffIso))
    .sort((a, b) => b.published.localeCompare(a.published));
  const failed = [!hnRes.ok ? HN_INDEX : null, !bbcRes.ok ? BBC_INDEX : null].filter(Boolean);
  let top: NewsItem | null = hn[0] ?? bbc[0] ?? null;
  if (!top) {
    throw unprocessable("NO_HEADLINES_IN_WINDOW",
      `no headline matching "${topic}" in the last ${windowHours}h in the named indexes (${[...(!hnRes.ok ? [] : [HN_INDEX]), ...(!bbcRes.ok ? [] : [BBC_INDEX])].join("; ")})${failed.length ? `; unavailable: ${failed.join(", ")}` : ""}`);
  }
  const headlines = [...hn.slice(0, 10), ...bbc.slice(0, 10)];
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ topic, window_hours: windowHours, cutoff: cutoffIso, as_of: asOf,
    indexes: INDEXES, unavailable_indexes: failed,
    top_rule: "highest-points HN story in window, else most recent BBC World match; ties by recency then title",
    hn_matches: hn, bbc_matches: bbc,
    source_policy: "two named indexes only (HN Algolia story index; BBC News World current RSS feed); never represented as comprehensive news coverage",
    raw_bodies: { hn: hnRes.body, bbc: bbcRes.body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, hnUrl, evidence, "two named indexes only (HN Algolia + BBC World RSS), honestly scoped");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer =
    `Top headline for "${topic}" (last ${windowHours}h): "${top.title}" — ${top.index}` +
    `${top.points !== null ? `, ${top.points} points` : ""}, published ${top.published}. ` +
    `${headlines.length - 1} other matching headline(s) across the named indexes. ` +
    `Coverage: ${INDEXES.join(" and ")} only — named indexes, never comprehensive news coverage` +
    `${failed.length ? `. Degraded: ${failed.join(", ")} unavailable` : ""}.`;
  return envelope(INTENT, {
    topic, top_headline: top.title,
    headlines: headlines.map((h) => h.title),
    urls: headlines.map((h) => h.url),
    window: `${windowHours}h`,
  }, receipt, { answer, verdict: "verified", confidence: 0.8,
    source: `${hnUrl} + ${BBC_URL}; two named indexes only; fetched ${fetchedAt}` });
}
