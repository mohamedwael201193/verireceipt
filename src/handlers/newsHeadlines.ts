// NEWS_HEADLINES_GENERAL: exact requested-window match first. Empty strict
// results relax in order:7day any-keyword HN, BBC title overlap, closest
// unambiguous mapped category. Relaxed answers are explicitly not exact.
// BBC bodies cache60seconds with original acquisition time in evidence.
// GDELT is omitted from this hot path; NEWS_SEARCH_GENERAL is unchanged.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { withinNewsDeadline, BBC_INDEX, GNEWS_INDEX, HN_INDEX, NewsItem, fetchIndex, gnewsSearchUrl, hnSearchUrl, inWindow, parseBbcRss, parseGnewsRss, parseHn, parsedSource, rankHn, rankRecent, topicMatches } from "./newsSources";

import {BBC_CATEGORIES,headlineFeed,headlineKeywords,anyHeadlineKeyword} from './newsHeadlineFeeds';
const BBC_URL = "https://feeds.bbci.co.uk/news/world/rss.xml";

export const INTENT = "NEWS_HEADLINES_GENERAL";
export function topicFeed(topic:string):{url:string;label:string}|null{
 const words=topic.toLowerCase().split(/[^a-z0-9]+/);
 const categories:[string,string[]][]=[['technology',['technology','tech','ai','openai','software','computing','cybersecurity']],['business',['business','economy','economic','finance','markets','banking','crypto']],['science_and_environment',['science','climate','environment','space','astronomy','nasa','mars','energy']],['health',['health','medicine','medical']]];
 const matches=categories.filter(([,keys])=>words.some(w=>keys.includes(w)));
 if(matches.length!==1)return null;
 return{url:`https://feeds.bbci.co.uk/news/${matches[0][0]}/rss.xml`,label:`BBC ${matches[0][0]} current RSS`};
}

export async function handleNewsHeadlines(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const sourceDeadline=Date.now()+2500;
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
  const feed=topicFeed(topic);
  const keywords=headlineKeywords(topic);
  const wideCutoff=new Date(now-7*86400000).toISOString();
  const wideUrl=hnSearchUrl(keywords.join(' '),Math.floor(now/1000)-7*86400)+'&optionalWords='+encodeURIComponent(JSON.stringify(keywords));
  const wide:{result:{ok:boolean;body:string}|null}={result:null};
  // Start the fallback HN query only after strict HN is empty, while other
  // concurrent sources finish, so a slow RSS search cannot consume its budget.
  const hnWork=(async()=>{const result=await fetchIndex(hnUrl,sourceDeadline);const parsed=parsedSource(result,parseHn);if(!parsed?.some(i=>topicMatches(topic,i.title)&&inWindow(i,cutoffIso)&&Date.parse(i.published)<=now)&&keywords.length&&Date.now()<sourceDeadline)wide.result=await fetchIndex(wideUrl,sourceDeadline);return result;})();
  const [hnRes,gnewsRes,feedResults]=await Promise.all([hnWork,fetchIndex(gnewsUrl,sourceDeadline),Promise.all(BBC_CATEGORIES.map(async category=>({category,...await headlineFeed(category,sourceDeadline)})))]);
  const bbcRes=feedResults.find(f=>f.category==='world')!.result;
  const topicRes=feed?feedResults.find(f=>feed.url.includes('/'+f.category+'/'))!.result:null;
  const gdeltRes={ok:false,body:''}; // GDELT omitted from headlines hot path, search handler unchanged.
  // A transport-level 200 is not evidence of a valid search result.
  const topicParsed=topicRes?parsedSource(topicRes,parseBbcRss):null;
  const topicItems=rankRecent((topicParsed??[]).filter(i=>inWindow(i,cutoffIso)&&Date.parse(i.published)<=now).map(i=>({...i,index:feed!.label,outlet:feed!.label})));
  const hnParsed = parsedSource(hnRes, parseHn);
  const gnewsParsed = parsedSource(gnewsRes, parseGnewsRss);
  const bbcParsed = parsedSource(bbcRes, parseBbcRss);
  const hnOk = hnParsed !== null;
  const gnewsOk = gnewsParsed !== null;
  const bbcOk = bbcParsed !== null;
  if (!hnOk && !gnewsOk && !bbcOk && !(wide.result&&parsedSource(wide.result,parseHn)!==null) && !feedResults.some(f=>parsedSource(f.result,parseBbcRss)!==null)) throw upstreamUnavailable("NEWS_INDEXES_UNREACHABLE", `all named headlines sources failed (${[HN_INDEX,GNEWS_INDEX,...BBC_CATEGORIES.map(c=>`BBC ${c} current RSS`)].join("; ")}); no answer is guessed`);
  const hnAll = hnParsed ?? [];
  const gnewsAll = gnewsParsed ?? [];
  const bbcAll = bbcParsed ?? [];
  // HN exact title tokens, Google upstream search, local BBC title+description.
  const hn = rankHn(hnAll.filter((i) => topicMatches(topic, i.title) && inWindow(i, cutoffIso)&&Date.parse(i.published)<=now));
  const gnews = rankRecent(gnewsAll.filter((i) => inWindow(i, cutoffIso)&&Date.parse(i.published)<=now));
  const gdelt:NewsItem[]=[];
  const bbc = rankRecent(bbcAll
    .filter((i) => topicMatches(topic, `${i.title} ${(i as NewsItem & { description?: string }).description ?? ""}`) && inWindow(i, cutoffIso)&&Date.parse(i.published)<=now));
  const indexes=[HN_INDEX,GNEWS_INDEX,...BBC_CATEGORIES.map(c=>`BBC ${c} current RSS`)];
  const failed = [
    ...feedResults.filter(f=>parsedSource(f.result,parseBbcRss)===null).map(f=>`BBC ${f.category} current RSS`),
    !hnOk ? HN_INDEX : null,
    !gnewsOk ? GNEWS_INDEX : null,

    !bbcOk ? BBC_INDEX : null,
  ].filter(Boolean) as string[];
  const searched = [
    ...feedResults.filter(f=>parsedSource(f.result,parseBbcRss)!==null).map(f=>`BBC ${f.category} current RSS`),
    ...(hnOk ? [HN_INDEX] : []),
    ...(gnewsOk ? [GNEWS_INDEX] : []),
    ...(bbcOk ? [BBC_INDEX] : []),
  ];
  const recent = rankRecent([...gnews, ...gdelt, ...bbc]);
  // Preserve broad category queries, but a niche phrase is not an exact
  // match merely because its category feed has a recent unrelated article.
  const categoryOnly=keywords.length===1&&feed!==null;
  const exactTopic=categoryOnly?topicItems:topicItems.filter(i=>topicMatches(topic,i.title));
  let top: NewsItem | null = exactTopic[0] ?? hn[0] ?? recent[0] ?? null;
  let relaxed:string|null=null;
  const feedItems=feedResults.flatMap(f=>(parsedSource(f.result,parseBbcRss)??[]).map(i=>({...i,index:`BBC ${f.category} current RSS`,outlet:`BBC ${f.category} current RSS`,category:f.category}))).filter(i=>Number.isFinite(Date.parse(i.published))&&Date.parse(i.published)<=now&&inWindow(i,wideCutoff));
  if(!top){const widened=rankHn((wide.result?parsedSource(wide.result,parseHn)??[]:[]).filter(i=>anyHeadlineKeyword(keywords,i.title)&&inWindow(i,wideCutoff)&&Date.parse(i.published)<=now));top=widened[0]??null;if(top)relaxed='HN Algolia any-keyword match in the widened 7 days window';}
  if(!top){top=rankRecent(feedItems.filter(i=>anyHeadlineKeyword(keywords,i.title)))[0]??null;if(top)relaxed='BBC title keyword overlap across the science, technology, world, business and health feeds, last 7 days';}
  if(!top&&feed){top=rankRecent(feedItems.filter(i=>feed.url.includes('/'+i.category+'/')))[0]??null;if(top)relaxed=`most recent item in closest mapped category feed ${feed.label}, last 7 days`;}

  const headlines = [...exactTopic.slice(0,10),...hn.slice(0, 10), ...gnews.slice(0, 10), ...gdelt.slice(0, 10), ...bbc.slice(0, 10)];
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ topic, window_hours: windowHours, cutoff: cutoffIso, as_of: asOf,
    indexes, unavailable_indexes: failed,topic_feed:feed,topic_feed_items:topicItems,topic_feed_available:topicParsed!==null,
    top_rule: "most recent item from explicitly mapped topical outlet feed, else highest-points HN story in window, else most recent match across Google News RSS search and BBC World current feed; then disclosed7dayHNanykeyword, BBCtitleoverlap, mappedcategory fallback; ties by source priority then title",
    hn_matches: hn, gnews_matches: gnews, gdelt_matches: gdelt, bbc_matches: bbc,
    omitted_indexes:["GDELT omitted from headlines hot path to avoid rate pressure"],
    source_policy: "HN Algolia story index; Google News RSS search; five named BBC current feeds. GDELT not requested; never comprehensive coverage",
    relaxed_match:relaxed,wide_hn_url:wideUrl,wide_hn_raw:wide.result?.body??null,bbc_feed_captures:feedResults.map(f=>({category:f.category,acquired_at:f.acquiredAt,raw:f.result.body})),
    raw_bodies: { topic_feed:topicRes?.body??null,hn: hnRes.body, gnews: gnewsRes.body, gdelt: gdeltRes.body, bbc: bbcRes.body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, hnUrl, evidence, "named keyless sources (HN Algolia + Google News RSS + five BBC RSS feeds); GDELT omitted, honestly scoped");
  receipt.fetched_at = fetchedAt;
  try {
    await withinNewsDeadline(saveReceipt(receipt, evidence),sourceDeadline+450);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const degraded = failed.length ? `. Degraded: ${failed.join(", ")} unavailable` : "";
  if (!top) {
    const answer =
      `No headline matching "${topic}" found in the last ${windowHours}h. ` +
      `Sources searched: ${searched.join("; ")} - zero matches${degraded}. Widened HN7day any-keyword and BBC closest-match fallbacks also yielded no usable item. ` +
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
  const orderedHeadlines = relaxed ? [top] : [top, ...headlines.filter(h => h !== top)];
  const seen = new Set<string>();
  const leadItems = orderedHeadlines.filter(h => {
    const key=h.url || h.title.toLowerCase();
    if(seen.has(key))return false;seen.add(key);return true;
  }).slice(0,10);
  const lead=leadItems.map(h=>`"${h.title}" (${h.outlet ?? h.index}, ${h.published}).`).join(' ');
  const answer = (relaxed ? `Closest match only: no exact ${windowHours}h match exists for "${topic}" in the named sources. Used ${relaxed}. Not an exact match. ` : "") + lead + (relaxed ? ` Topic "${topic}", closest-match scope as stated. ` : ` Topic "${topic}", last ${windowHours}h. `) +
    `Top rule: mapped topical BBC feed by recency when available, else highest-points matching HN story, else most recent named-source match. Topic mapping is category coverage, not an exact keyword search. ` +
    `Coverage: ${indexes.join('; ')}; named sources, never comprehensive news coverage; BBC feeds may be cached up to60seconds, original acquisition times retained in receipt${degraded}.`;
  return envelope(INTENT, {
    topic, top_headline: top.title,topic_feed:feed,match_scope:relaxed??"requested window",
    headlines: orderedHeadlines.map((h) => h.title),
    headline_details: leadItems.map(h=>({title:h.title,outlet:h.outlet??h.index,published:h.published,url:h.url})),
    urls: orderedHeadlines.map((h) => h.url),
    window: `${windowHours}h`,
  }, receipt, { answer, verdict: "verified", confidence: relaxed ? 0.5 : 0.8,
    source: `${hnUrl} + ${gnewsUrl} + ${BBC_CATEGORIES.map(c=>`https://feeds.bbci.co.uk/news/${c}/rss.xml`).join(" + ")}${relaxed?" + "+wideUrl:""}; named sources only; fetched ${fetchedAt}` });
}
