// Named-source query search with explicitly disclosed closest-match fallback.
import {badRequest,upstreamUnavailable} from '../core/errors';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {withinNewsDeadline,NewsItem,fetchIndex,hnSearchUrl,parseBbcRss,parseHn,parsedSource,rankHn,rankRecent,topicMatches} from './newsSources';
import {BBC_CATEGORIES,headlineFeed,headlineKeywords,anyHeadlineKeyword} from './newsHeadlineFeeds';
import {relaxedSearchHn,referenceSearchUrl,parseReferenceSearch,REFERENCE_INDEX,DISPATCH_INDEX} from './newsSearchFallback';
export const INTENT='NEWS_SEARCH_GENERAL';
export function capBytes(text:string,maxBytes:number):string{
 const enc=new TextEncoder();if(enc.encode(text).length<=maxBytes)return text;
 return new TextDecoder().decode(enc.encode(text).slice(0,Math.max(0,maxBytes-3))).replace(/\uFFFD+$/,'')+'…';
}
export interface BriefGroup{label:string;items:NewsItem[]}
export function buildBrief(groups:BriefGroup[],maxBytes=256):string{
 const counts=groups.map(g=>`${g.label}: ${g.items.length}`).join(', '),suffix='. Named sources only.',top=groups.flatMap(g=>g.items)[0];let mid='';
 if(top){const pts=top.points!==null?` (${top.points} pts)`:'',fixed=new TextEncoder().encode(`${counts}. Top: ""${pts}${suffix}`).length,budget=maxBytes-fixed;if(budget>0)mid=`. Top: "${capBytes(top.title,budget)}"${pts}`;}
 return capBytes(counts+mid+suffix,maxBytes);
}
const FEED_INDEX='Current news feeds';
const SEARCH_INDEX='Story search';
export async function handleNewsSearch(query:Record<string,string|undefined>):Promise<Record<string,unknown>>{
 const started=Date.now(),hnDeadline=started+2500,sourceDeadline=started+4500;
 const q=query.query?.trim();if(!q)throw badRequest('MISSING_PARAM','query is required');if(q.length>120)throw badRequest('QUERY_TOO_LONG','query must be at most120characters');
 console.info(JSON.stringify({event:'news_search_query',query_length:q.length}));
 const now=Date.now(),fetchedAt=new Date(now).toISOString(),words=headlineKeywords(q),cutoff=new Date(now-365*86400000).toISOString();
 const strictUrl=hnSearchUrl(q,Math.floor(now/1000)-7*86400),referenceUrl=referenceSearchUrl(q),dispatchUrl=referenceSearchUrl(q,true);
 // Retry story search within its own2.5s budget while feeds and reference searches run.
 const [stories,reference,dispatch,feeds]=await Promise.all([
  relaxedSearchHn(q,strictUrl,hnDeadline,now),
  fetchIndex(referenceUrl,sourceDeadline),fetchIndex(dispatchUrl,sourceDeadline),
  Promise.all(BBC_CATEGORIES.map(async category=>({category,...await headlineFeed(category,sourceDeadline)}))),
 ]);
 const referenceItems=parsedSource(reference,r=>parseReferenceSearch(r)),dispatchItems=parsedSource(dispatch,r=>parseReferenceSearch(r,true));
 const feedCaptures=feeds.map(f=>({...f,items:parsedSource(f.result,parseBbcRss)}));
 const eligible=(i:NewsItem)=>Number.isFinite(Date.parse(i.published))&&i.published>=cutoff&&Date.parse(i.published)<=now&&/^https?:\/\//.test(i.url);
 const feedItems=feedCaptures.flatMap(f=>(f.items??[]).map(i=>({...i,index:FEED_INDEX}))).filter(eligible);
 const refs=(referenceItems??[]).filter(eligible),dispatches=(dispatchItems??[]).filter(eligible);
 const exactOther=rankRecent([...feedItems,...dispatches].filter(i=>topicMatches(q,i.title)));
 const exact=[...stories.exact.map(i=>({...i,index:SEARCH_INDEX})),...exactOther];
 const unique=(items:NewsItem[])=>{const seen=new Set<string>();return items.filter(i=>{if(seen.has(i.url))return false;seen.add(i.url);return true;});};
 let selected=unique(exact),scope='exact title keyword match in named sources';
 if(!selected.length){
  const storyClosest=rankHn(stories.closest.filter(eligible)).map(i=>({...i,index:SEARCH_INDEX}));
  const overlap=rankRecent([...feedItems,...dispatches,...refs].filter(i=>anyHeadlineKeyword(words,i.title)));
  selected=unique([...storyClosest,...overlap]).slice(0,10);scope='closest match only: any query keyword, story search widened to365days and ranked by points; current feeds and reference pages by date. Not an exact match';
 }
 const storyOk=stories.captures.some(c=>parsedSource(c.result,parseHn)!==null);
 if(!storyOk&&referenceItems===null&&dispatchItems===null&&!feedCaptures.some(f=>f.items!==null))throw upstreamUnavailable('NEWS_INDEXES_UNREACHABLE','all named search sources failed; no answer is guessed');
 const unavailable=[...(!storyOk?[SEARCH_INDEX]:[]),...(referenceItems===null?[REFERENCE_INDEX]:[]),...(dispatchItems===null?[DISPATCH_INDEX]:[]),...feedCaptures.filter(f=>f.items===null).map(f=>FEED_INDEX+': '+f.category)];
 const indexes=[SEARCH_INDEX,REFERENCE_INDEX,DISPATCH_INDEX,FEED_INDEX];
 const briefBase=selected.length&&exact.length===0?'Closest match only. ':'';
 const brief=capBytes(briefBase+buildBrief([{label:'Stories',items:selected.filter(i=>i.points!==null)},{label:'Other named sources',items:selected.filter(i=>i.points===null)}],256-new TextEncoder().encode(briefBase).length),256);
 const asOf=new Date().toISOString();
 const evidence=JSON.stringify({query:q,query_length:q.length,as_of:asOf,fetched_at:fetchedAt,indexes,unavailable_indexes:unavailable,match_scope:scope,hn_window_days:stories.captures.length>1?365:7,hn_matches:stories.exact,closest_hn_matches:stories.closest,reference_matches:refs,dispatch_matches:dispatches,selected_items:selected,story_captures:stories.captures,reference_capture:{url:referenceUrl,...reference},dispatch_capture:{url:dispatchUrl,...dispatch},feed_captures:feeds.map(f=>({category:f.category,acquired_at:f.acquiredAt,body:f.result.body})),source_policy:'Named sources only; current feeds may be cached60seconds; reference timestamps are page revision times, not news publication. Closest matches do not verify the whole query. No comprehensive news claim.'});
 const receipt=makeReceipt(INTENT,strictUrl,evidence,'named-source search with disclosed closest matches');receipt.fetched_at=fetchedAt;
 try{await withinNewsDeadline(saveReceipt(receipt,evidence),sourceDeadline+450);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 const details=selected.map(i=>({title:i.title,url:i.url,date:i.published,date_kind:(i as NewsItem&{date_kind?:string}).date_kind??'source publication time',source:i.points!==null?SEARCH_INDEX:i.index,points:i.points}));
 const lead=selected.length?(exact.length?'Exact title keyword matches. ':'Closest match only, not an exact answer to the full query. ')+details.slice(0,3).map(i=>`"${i.title}" (${i.date}, ${i.source}, ${i.date_kind}) ${i.url}`).join('; '):'No usable keyword match found in the named sources. Sources searched: '+indexes.join('; ')+'; zero matches.';
 const answer=lead+' Scope: '+scope+'. Reference pages are background, not news articles. Feed cache up to60seconds; original acquisition times retained in receipt. Named sources only, never comprehensive news coverage.'+(unavailable.length?' Degraded: '+unavailable.join('; ')+' unavailable.':'');
 return envelope(INTENT,{brief,result_count:selected.length,hn_window_days:stories.captures.length>1?365:7,sources:indexes,match_scope:scope,results:details,urls:details.map(i=>i.url)},receipt,{answer,verdict:'verified',confidence:exact.length?0.8:0.5,source:indexes.join(' + ')});
}
