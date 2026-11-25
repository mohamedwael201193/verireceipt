import {norm} from './eventOutcome';
import {eventBody} from './eventSource';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {unprocessable,upstreamUnavailable} from '../core/errors';
import {withAnswerClass} from '../core/answerClass';
const INTENT='EVENT_OUTCOME_RESOLUTION_GENERAL';
/** No arbitrary proposition or undated title can enter this resolver. */
export function wikidataTitle(event:string):string|null{
 if(!/^(?:who (?:won|wins)|won|winner of)\s+/i.test(event))return null;
 const title=event.replace(/^(?:who (?:won|wins)|won|winner of)\s+(?:the\s+)?/i,'').replace(/\?$/,'').trim();
 return title&&title.length<=120&&(/\b\d{4}\b/.test(title)||/\b[IVXLCDM]+\b/.test(title))?title:null;
}
function values(entity:any,property:string):any[]{
 const claims=entity?.claims?.[property];
 return Array.isArray(claims)?claims.filter(c=>c?.rank!=='deprecated'&&c?.mainsnak?.snaktype==='value').map(c=>c.mainsnak.datavalue?.value):[];
}
function completedAt(entity:any):string|null{
 const dates=(p:string)=>values(entity,p).map(v=>typeof v?.time==='string'?v.time.replace(/^\+/,''):null).filter((s):s is string=>!!s&&Number.isFinite(Date.parse(s)));
 const rawDates=['P585','P580','P582'].flatMap(p=>values(entity,p));
 if(rawDates.some(v=>typeof v?.time==='string'&&Number(/^\+?(\d{4})/.exec(v.time)?.[1])>new Date().getUTCFullYear()))return null;
 const point=dates('P585'),end=dates('P582'),start=dates('P580');
 // Starts alone cannot establish completion. All supplied bounds must be past.
 const completion=point.length?point:end;
 if(!completion.length||[...completion,...end,...start].some(s=>Date.parse(s)>=Date.now()))return null;
 return completion.slice().sort().at(-1)!;
}
export async function wikidataEventOutcome(event:string,primaryBody:string,primaryUrl:string,deadlineAt:number):Promise<Record<string,unknown>|null>{
 const title=wikidataTitle(event);if(!title)return null;
 const searchUrl='https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=5&search='+encodeURIComponent(title);
 const search=await eventBody(searchUrl,deadlineAt),found=JSON.parse(search.raw);
 if(!Array.isArray(found.search))throw upstreamUnavailable('WIKIDATA_BAD_PAYLOAD','structured search response is invalid');
 const hits=found.search.filter((h:any)=>typeof h.label==='string'&&norm(h.label)===norm(title));
 // Even identical winner claims do not disambiguate two exact event identities.
 if(hits.length>1)throw unprocessable('AMBIGUOUS_EVENT','several structured records have the exact event label');
 if(!hits.length)return null;
 if(!/^Q[1-9]\d*$/.test(hits[0].id))throw upstreamUnavailable('WIKIDATA_BAD_PAYLOAD','matched event identifier is invalid');
 const id=hits[0].id,entityUrl='https://www.wikidata.org/wiki/'+id;
 const dataUrl='https://www.wikidata.org/wiki/Special:EntityData/'+id+'.json';
 const data=await eventBody(dataUrl,deadlineAt),entity=JSON.parse(data.raw).entities?.[id];
 if(!entity||entity.id!==id||entity.type!=='item'||norm(entity.labels?.en?.value??'')!==norm(title))throw unprocessable('EVENT_RECORD_INCOMPLETE','matched structured event identity is incomplete');
 const resolvedAt=completedAt(entity);if(!resolvedAt)throw unprocessable('EVENT_NOT_RESOLVED','matched event has no completed past date or end date');
 const winners=[...new Set(values(entity,'P1346').map(v=>v?.id).filter(v=>typeof v==='string'&&/^Q[1-9]\d*$/.test(v)))];
 if(!winners.length)throw unprocessable('EVENT_RECORD_INCOMPLETE','matched event has no usable winner claim');
 if(winners.length>1)throw unprocessable('MULTIPLE_EVENT_WINNERS','matched event names several distinct winners');
 const winnerId=winners[0];
 const winnerUrl='https://www.wikidata.org/wiki/Special:EntityData/'+winnerId+'.json';
 const winnerBody=await eventBody(winnerUrl,deadlineAt),winnerEntity=JSON.parse(winnerBody.raw).entities?.[winnerId];
 const winner=winnerEntity?.labels?.en?.value;
 if(winnerEntity?.id!==winnerId||winnerEntity?.type!=='item'||typeof winner!=='string'||!winner.trim()||winner.length>200)throw unprocessable('EVENT_RECORD_INCOMPLETE','matched event winner has no usable English label');
 const sitelink=entity.sitelinks?.enwiki;
 if(typeof sitelink?.title!=='string'||typeof sitelink?.url!=='string')throw unprocessable('EVENT_RECORD_INCOMPLETE','matched event has no English reference link');
 let page:URL;try{page=new URL(sitelink.url);}catch{throw unprocessable('EVENT_RECORD_INCOMPLETE','matched event reference link is invalid');}
 if(page.origin!=='https://en.wikipedia.org'||!page.pathname.startsWith('/wiki/')||page.username||page.password)throw unprocessable('EVENT_RECORD_INCOMPLETE','matched event reference link is invalid');
 const summaryUrl='https://en.wikipedia.org/api/rest_v1/page/summary/'+encodeURIComponent(sitelink.title.replace(/ /g,'_'));
 const summaryBody=await eventBody(summaryUrl,deadlineAt),summary=JSON.parse(summaryBody.raw);
 const disclosure='single structured-data source (Wikidata), not independently corroborated';
 const evidence=JSON.stringify({event,winner,resolved_at:resolvedAt,sources:[entityUrl,page.href],source_policy:disclosure,
  raw_bodies:{primary:primaryBody,search:search.raw,entity:data.raw,winner:winnerBody.raw,summary:summaryBody.raw},
  source_urls:[primaryUrl,searchUrl,dataUrl,winnerUrl,summaryUrl],fetched_at:summaryBody.fetchedAt});
 const receipt=makeReceipt(INTENT,dataUrl,evidence,disclosure);receipt.fetched_at=summaryBody.fetchedAt;
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 return withAnswerClass(envelope(INTENT,{event,outcome:'yes',resolved_yes:true,winner,resolved_at:resolvedAt,sources:[entityUrl,page.href]},receipt,
  {answer:`${title}: ${winner} won. Wikidata names the winner; ${disclosure}. ${entityUrl} ${page.href}`,verdict:'verified',confidence:0.7,source:`Wikidata; Wikipedia reference link only; fetched ${summaryBody.fetchedAt}`}),INTENT,{outcome:'yes',source:'wikidata'});
}
