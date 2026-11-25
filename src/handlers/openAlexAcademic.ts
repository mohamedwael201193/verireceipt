import {normalizeAcademicQuery} from './academicSourceCache';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {upstreamUnavailable} from '../core/errors';
interface Paper{publication_date?:string;title:string;doi:string;authors:string[];publication_year:number|null;venue:string|null;work_type:string|null;venue_type:string|null;openalex_citation_count:number|null}
const text=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():null;
export function parseOpenAlex(raw:string,year?:number,recent?:{minYear:number;maxYear:number}):{total:number;papers:Paper[]}{
 const j=JSON.parse(raw);if(!Array.isArray(j?.results)||typeof j.meta?.count!=='number'||!Number.isSafeInteger(j.meta.count)||j.meta.count<0)throw Error('invalid works');
 const papers:Paper[]=[];
 for(const r of j.results){
  const title=text(r?.display_name),doi=text(r?.doi)?.replace(/^https:\/\/doi.org\//i,'');
  const y=Number.isInteger(r?.publication_year)&&r.publication_year>0&&r.publication_year<=9999?r.publication_year:null;
  const venue=text(r?.primary_location?.source?.display_name);
  if(!title||!doi||(!y&&!venue)||(year!==undefined&&y!==year)||(recent&&(!y||y<recent.minYear||y>recent.maxYear||!Number.isSafeInteger(r.cited_by_count)||r.cited_by_count<1)))continue;
  const date=typeof r.publication_date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(r.publication_date)&&Number.isFinite(Date.parse(r.publication_date))&&new Date(r.publication_date).toISOString().slice(0,10)===r.publication_date&&Number(r.publication_date.slice(0,4))===y?r.publication_date:String(y).padStart(4,'0')+'-01-01';
  papers.push({...(recent?{publication_date:date}:{}),title,doi,publication_year:y,venue,work_type:text(r.type),venue_type:text(r.primary_location?.source?.type),authors:Array.isArray(r.authorships)?r.authorships.flatMap((a:any)=>text(a?.author?.display_name)?[text(a.author.display_name)!]:[]):[],openalex_citation_count:Number.isSafeInteger(r.cited_by_count)&&r.cited_by_count>=0?r.cited_by_count:null});
 }
 if(recent){papers.sort((a,b)=>(b.publication_date??'').localeCompare(a.publication_date??'')||(b.openalex_citation_count??0)-(a.openalex_citation_count??0));}else papers.sort((a,b)=>Number(!!b.publication_year&&!!b.venue&&(['journal','conference'].includes(b.venue_type??'')||b.work_type==='proceedings-article'))-Number(!!a.publication_year&&!!a.venue&&(['journal','conference'].includes(a.venue_type??'')||a.work_type==='proceedings-article')));
 return{total:Math.min(j.meta.count,1e8),papers:papers.slice(0,5)};
}
const cache=new Map<string,{raw:string;at:string}>(),active=new Map<string,Promise<{raw:string;at:string}>>();
export function resetOpenAlexForTests(){cache.clear();active.clear();}
async function read(url:string){
 const prior=cache.get(url);if(prior&&Date.now()-Date.parse(prior.at)<900000)return prior;
 if(active.has(url))throw Error("OpenAlex same query in flight");
 if(active.size>=8)throw Error('OpenAlex capacity');
 const abort=new AbortController();
 const io=(async()=>{try{const response=await fetch(url,{signal:abort.signal,headers:{'User-Agent':'VeriReceipt/2.0 academic observer (+https://verireceipt.vercel.app)'}});if(!response.ok)throw Error('OpenAlex unavailable');const raw=await response.text();if(Buffer.byteLength(raw)>2000000)throw Error('OpenAlex body limit');parseOpenAlex(raw);const row={raw,at:new Date().toISOString()};if(!abort.signal.aborted){if(cache.size>=64)cache.delete(cache.keys().next().value!);cache.set(url,row);}return row;}finally{active.delete(url);}})();
 active.set(url,io);let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error('OpenAlex deadline'));},2500);})]);}finally{clearTimeout(timer);}
}
export function academicSearchTerms(q:string):string {
 const stripped=q.trim().replace(/^(?:(?:what|which) (?:are|is) (?:the )?(?:best |top |most cited |recent )?(?:papers|research|studies|articles)(?: (?:on|about|for))?|(?:can you |could you )?(?:find|show|list)(?: me)?(?: (?:the |some )?(?:papers|research|studies|articles))?(?: (?:on|about|for))?)\s+/i,'').replace(/\?$/,'').trim();
 return normalizeAcademicQuery(stripped||q);
}
export function academicLeadAuthor(authors:string[]):string {
 if(!authors.length)return 'authors unavailable';
 const first=authors[0];
 if(/\b(?:collaboration|consortium|group|team|committee|network)\b/i.test(first))return first+(authors.length>1?' et al.':'');
 const surname=first.split(/\s+/).at(-1)!;
 return surname+(authors.length>1?' et al.':'');
}
export async function openAlexAnswer(q:string,year?:number,recent?:{minYear:number;maxYear:number}):Promise<Record<string,unknown>>{
 const url=`https://api.openalex.org/works?search=${encodeURIComponent(academicSearchTerms(q))}&per-page=10&select=id,display_name,doi,publication_year,primary_location,type,authorships,cited_by_count${recent?',publication_date':''}${recent?`&filter=publication_year:${recent.minYear}-${recent.maxYear},cited_by_count:>0&sort=publication_date:desc,cited_by_count:desc`:year?`&filter=publication_year:${year}`:''}`;
 const observation=await read(url);const {total,papers}=parseOpenAlex(observation.raw,year,recent);
 const evidence=JSON.stringify({query:q,year_filter:year??null,...(recent?{recent_window:recent,citation_floor:1,sort:'publication date descending'}:{}),papers,total_matches:total,raw_body:observation.raw,fetched_at:observation.at,source_policy:'OpenAlex keyless index; source citation counts, not quality or peer-review proof; records missing both year and venue omitted; '+(recent?'publication date order after citation floor; ':'journal/proceedings metadata preferred; ')+'DOI-bearing records only'});
 const receipt=makeReceipt('ACADEMIC_SEARCH_GENERAL',url,evidence,'OpenAlex index metadata, not a quality or peer-review verdict');receipt.fetched_at=observation.at;
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 const details=(p:Paper,lead=false)=>`${p.title} (${lead?academicLeadAuthor(p.authors):(p.authors.slice(0,3).join(', ')||'authors unavailable')}, ${p.publication_year??'year unavailable'}, ${p.venue??'venue unavailable'}, ${p.openalex_citation_count??'unknown'} OpenAlex citations, DOI ${p.doi})`;
 const asked=Array.from(q).slice(0,80).join('');
 const lead=papers.length?`Top match for '${asked}': ${details(papers[0],true)}.`:`No eligible DOI-bearing records for '${asked}' in the returned sample.`;
 const also=papers.length>1?` Also relevant: ${papers.slice(1,5).map(p=>details(p)).join('; ')}.`:'';
 const answer=`${recent?`Recent publication window ${recent.minYear}-${recent.maxYear}; at least 1 OpenAlex citation; newest publication first. `:''}${lead}${also} Returned ${papers.length} eligible records from ${total} index matches${year?` in ${year}`:''}. Single named index: OpenAlex; citation counts are its own, not quality or peer-review proof; fetched ${observation.at}, cache up to15minutes.`;
 return envelope('ACADEMIC_SEARCH_GENERAL',{papers,paper_titles:papers.map(p=>p.title),dois:papers.map(p=>p.doi),total_matches:total,brief:Array.from(`${papers.length} OpenAlex results: ${papers[0]?.title??'no eligible records'}`).slice(0,80).join(''),year_filter:year??null,...(recent?{recent_window:recent,citation_floor:1,sort:'publication date descending'}:{}),as_of:observation.at,fetched_at:observation.at,age_seconds:Math.max(0,Math.floor((Date.now()-Date.parse(observation.at))/1000)),stale:false,metadata_scope:'OpenAlex indexed metadata and citation counts, not proof of peer review'},receipt,{answer,verdict:'verified',confidence:0.85,source:url});
}
