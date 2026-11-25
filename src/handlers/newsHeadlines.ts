// NEWS_HEADLINES_GENERAL — GET /v1/news-headlines?topic=<t>&window_hours=<h>
//
// Zero-LLM. Top headline for a topic from the NAMED keyless sources plus mapped topical BBC RSS in
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
export function topicFeed(topic:string):{url:string;label:string}|null{
 const words=topic.toLowerCase().split(/[^a-z0-9]+/);
 const categories:[string,string[]][]=[['technology',['technology','tech','ai','openai','software','computing','cybersecurity']],['business',['business','economy','economic','finance','markets','banking']],['science_and_environment',['science','climate','environment','space']],['health',['health','medicine','medical']]];
 const matches=categories.filter(([,keys])=>words.some(w=>keys.includes(w)));
 if(matches.length!==1)return null;
 return{url:`https://feeds.bbci.co.uk/news/${matches[0][0]}/rss.xml`,label:`BBC ${matches[0][0]} current RSS`};
}

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
  const feed=topicFeed(topic);
  const [hnRes, gnewsRes, gdeltRes, bbcRes,topicRes] = await Promise.all([
    fetchIndex(hnUrl), fetchIndex(gnewsUrl), fetchIndex(gdeltUrl), fetchIndex(BBC_URL),feed?fetchIndex(feed.url):Promise.resolve(null),
  ]);

  // A transport-level 200 is not evidence of a valid search result.
  const topicParsed=topicRes?parsedSource(topicRes,parseBbcRss):null;
  const topicItems=rankRecent((topicParsed??[]).filter(i=>inWindow(i,cutoffIso)&&Date.parse(i.published)<=now).map(i=>({...i,index:feed!.label,outlet:feed!.label})));
  const hnParsed = parsedSource(hnRes, parseHn);
  const gnewsParsed = parsedSource(gnewsRes, parseGnewsRss);
  const gdeltParsed = parsedSource(gdeltRes, parseGdelt);
  const bbcParsed = parsedSource(bbcRes, parseBbcRss);
  const hnOk = hnParsed !== null;
  const gnewsOk = gnewsParsed !== null;
  const gdeltOk = gdeltParsed !== null;
  const bbcOk = bbcParsed !== null;
  if (!hnOk && !gnewsOk && !gdeltOk && !bbcOk && topicParsed===null) allDown();
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
  const indexes=[...INDEXES,...(feed?[feed.label]:[])];
  const failed = [
    feed&&topicParsed===null?feed.label:null,
    !hnOk ? HN_INDEX : null,
    !gnewsOk ? GNEWS_INDEX : null,
    !gdeltOk ? GDELT_INDEX : null,
    !bbcOk ? BBC_INDEX : null,
  ].filter(Boolean) as string[];
  const searched = [
    ...(feed&&topicParsed!==null?[feed.label]:[]),
    ...(hnOk ? [HN_INDEX] : []),
    ...(gnewsOk ? [GNEWS_INDEX] : []),
    ...(gdeltOk ? [GDELT_INDEX] : []),
    ...(bbcOk ? [BBC_INDEX] : []),
  ];
  const recent = rankRecent([...gnews, ...gdelt, ...bbc]);
  const top: NewsItem | null = topicItems[0] ?? hn[0] ?? recent[0] ?? null;
  const headlines = [...topicItems.slice(0,10),...hn.slice(0, 10), ...gnews.slice(0, 10), ...gdelt.slice(0, 10), ...bbc.slice(0, 10)];
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ topic, window_hours: windowHours, cutoff: cutoffIso, as_of: asOf,
    indexes, unavailable_indexes: failed,topic_feed:feed,topic_feed_items:topicItems,topic_feed_available:topicParsed!==null,
    top_rule: "most recent item from explicitly mapped topical outlet feed, else highest-points HN story in window, else most recent match across Google News RSS search, GDELT DOC 2.0 and BBC World current feed; ties by source priority then title",
    hn_matches: hn, gnews_matches: gnews, gdelt_matches: gdelt, bbc_matches: bbc,
    source_policy: "named keyless sources (HN Algolia story index; Google News RSS search; GDELT DOC 2.0 artlist; BBC News World current RSS feed; mapped BBC topic category feed when available); never represented as comprehensive news coverage",
    raw_bodies: { topic_feed:topicRes?.body??null,hn: hnRes.body, gnews: gnewsRes.body, gdelt: gdeltRes.body, bbc: bbcRes.body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, hnUrl, evidence, "named keyless sources (HN Algolia + Google News RSS + GDELT DOC 2.0 + BBC World RSS + mapped BBC topical RSS when available), honestly scoped");
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
  // The contract defines top_headline as the first headline listed. Keep
  // each title paired with its URL when the cross-source top is not in the
  // first source group, including when a per-source cap omitted it.
  const orderedHeadlines = [top, ...headlines.filter(h => h !== top)];
  const seen = new Set<string>();
  const leadItems = orderedHeadlines.filter(h => {
    const key=h.url || h.title.toLowerCase();
    if(seen.has(key))return false;seen.add(key);return true;
  }).slice(0,10);
  const lead=leadItems.map(h=>`"${h.title}" (${h.outlet ?? h.index}, ${h.published}).`).join(' ');
  const answer = lead + ` Topic "${topic}", last ${windowHours}h. ` +
    `Top rule: mapped topical BBC feed by recency when available, else highest-points matching HN story, else most recent named-source match. Topic mapping is category coverage, not an exact keyword search. ` +
    `Coverage: ${indexes.join('; ')}; named sources, never comprehensive news coverage${degraded}.`;
  return envelope(INTENT, {
    topic, top_headline: top.title,topic_feed:feed,
    headlines: orderedHeadlines.map((h) => h.title),
    headline_details: leadItems.map(h=>({title:h.title,outlet:h.outlet??h.index,published:h.published,url:h.url})),
    urls: orderedHeadlines.map((h) => h.url),
    window: `${windowHours}h`,
  }, receipt, { answer, verdict: "verified", confidence: 0.8,
    source: `${hnUrl} + ${gnewsUrl} + ${gdeltUrl} + ${BBC_URL}${feed?" + "+feed.url:""}; named sources only; fetched ${fetchedAt}` });
}
