// NEWS_HEADLINES_GENERAL — GET /v1/news-headlines?topic=<t>&window_hours=<h>
//
// Zero-LLM. Top headline for a topic from the four NAMED keyless sources in
// newsSources.ts (Hacker News via Algolia, Google News RSS search, GDELT
// DOC 2.0, current BBC News World RSS), with a SHA-256 receipt over the
// exact upstream bodies. Never "all news".
//
// Intent contract (read 2026-11-22): request topic (string); response
// top_headline (scored); off-chain topic, headlines, urls, window.
// window_hours defaults to 24, bounded 1..720.
//
// top_headline rule (deterministic, disclosed): the highest-points
// Hacker News story matching the topic inside the window; if none, the most
// recent matching item across Google News, GDELT and BBC World (ties by
// source priority, then title). HN, Google News and GDELT are upstream
// full-text searches for the topic; BBC is its current feed matched locally
// by topic tokens.
//
// A topic with zero matches is an honest 200 with top_headline null and an
// answer naming the window, the sources searched and the zero match count —
// never a stale or invented headline, never a refusal for a well-formed
// topic. A 502 only when every named source is unreachable.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { BBC_INDEX, GDELT_INDEX, GNEWS_INDEX, HN_INDEX, INDEXES, NewsItem, allDown, fetchIndex, gdeltSearchUrl, gnewsSearchUrl, hnSearchUrl, inWindow, parseBbcRss, parseGdelt, parseGnewsRss, parseHn, parsedSource, rankHn, rankRecent, topicMatches } from "./newsSources";

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
  const gnewsUrl = gnewsSearchUrl(topic);
  const gdeltUrl = gdeltSearchUrl(topic, { windowHours, sort: "datedesc" });
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
  // The HN and GDELT requests are window-filtered upstream; Google News and
  // the BBC feed are filtered here by pubDate/seendate. HN hits are
  // additionally topic-filtered locally on the title because Algolia
  // relevance can return loose matches; Google News and GDELT are upstream
  // full-text searches, so their items are topic matches by construction.
  const hn = rankHn(hnAll.filter((i) => topicMatches(topic, i.title) && inWindow(i, cutoffIso)));
  const gnews = rankRecent(gnewsAll.filter((i) => inWindow(i, cutoffIso)));
  const gdelt = rankRecent(gdeltAll.filter((i) => inWindow(i, cutoffIso)));
  const bbc = rankRecent(bbcAll
    .filter((i) => topicMatches(topic, `${i.title} ${(i as NewsItem & { description?: string }).description ?? ""}`) && inWindow(i, cutoffIso)));
  const failed = [
    !hnOk ? HN_INDEX : null,
    !gnewsOk ? GNEWS_INDEX : null,
    !gdeltOk ? GDELT_INDEX : null,
    !bbcOk ? BBC_INDEX : null,
  ].filter(Boolean) as string[];
  const searched = [
    ...(hnOk ? [HN_INDEX] : []),
    ...(gnewsOk ? [GNEWS_INDEX] : []),
    ...(gdeltOk ? [GDELT_INDEX] : []),
    ...(bbcOk ? [BBC_INDEX] : []),
  ];
  const recent = rankRecent([...gnews, ...gdelt, ...bbc]);
  const top: NewsItem | null = hn[0] ?? recent[0] ?? null;
  const headlines = [...hn.slice(0, 10), ...gnews.slice(0, 10), ...gdelt.slice(0, 10), ...bbc.slice(0, 10)];
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ topic, window_hours: windowHours, cutoff: cutoffIso, as_of: asOf,
    indexes: INDEXES, unavailable_indexes: failed,
    top_rule: "highest-points HN story in window, else most recent match across Google News RSS search, GDELT DOC 2.0 and BBC World current feed; ties by source priority then title",
    hn_matches: hn, gnews_matches: gnews, gdelt_matches: gdelt, bbc_matches: bbc,
    source_policy: "four named keyless sources (HN Algolia story index; Google News RSS search; GDELT DOC 2.0 artlist; BBC News World current RSS feed); never represented as comprehensive news coverage",
    raw_bodies: { hn: hnRes.body, gnews: gnewsRes.body, gdelt: gdeltRes.body, bbc: bbcRes.body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, hnUrl, evidence, "four named keyless sources (HN Algolia + Google News RSS + GDELT DOC 2.0 + BBC World RSS), honestly scoped");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const degraded = failed.length ? `. Degraded: ${failed.join(", ")} unavailable` : "";
  if (!top) {
    const answer =
      `No headline matching "${topic}" found in the last ${windowHours}h. ` +
      `Sources searched: ${searched.join("; ")} — zero matches${degraded}. ` +
      `Coverage: named sources only, never comprehensive news coverage.`;
    return envelope(INTENT, {
      topic, top_headline: null,
      headlines: [] as string[],
      urls: [] as string[],
      window: `${windowHours}h`,
    }, receipt, { answer, verdict: "verified", confidence: 0.5,
      source: `${searched.join(" + ") || "no source reachable"}; named sources only; fetched ${fetchedAt}` });
  }
  const answer =
    `Top headline for "${topic}" (last ${windowHours}h): "${top.title}" — ${top.index}` +
    `${top.outlet ? ` (${top.outlet})` : ""}` +
    `${top.points !== null ? `, ${top.points} points` : ""}, published ${top.published}. ` +
    `${headlines.length - 1} other matching headline(s) across the named sources. ` +
    `Coverage: ${INDEXES.join("; ")} — named sources, never comprehensive news coverage` +
    `${degraded}.`;
  return envelope(INTENT, {
    topic, top_headline: top.title,
    headlines: headlines.map((h) => h.title),
    urls: headlines.map((h) => h.url),
    window: `${windowHours}h`,
  }, receipt, { answer, verdict: "verified", confidence: 0.8,
    source: `${hnUrl} + ${gnewsUrl} + ${gdeltUrl} + ${BBC_URL}; named sources only; fetched ${fetchedAt}` });
}
