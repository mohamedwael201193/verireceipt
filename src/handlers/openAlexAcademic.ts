import {normalizeAcademicQuery} from './academicSourceCache';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {upstreamUnavailable} from '../core/errors';
interface Paper{title:string;doi:string;authors:string[];publication_year:number|null;venue:string|null;work_type:string|null;venue_type:string|null;openalex_citation_count:number|null}
const text=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():null;
export function parseOpenAlex(raw:string,year?:number):{total:number;papers:Paper[]}{
 const j=JSON.parse(raw);if(!Array.isArray(j?.results)||typeof j.meta?.count!=='number'||!Number.isSafeInteger(j.meta.count)||j.meta.count<0)throw Error('invalid works');
 const papers:Paper[]=[];
 for(const r of j.results){
  const title=text(r?.display_name),doi=text(r?.doi)?.replace(/^https:\/\/doi.org\//i,'');
  const y=Number.isInteger(r?.publication_year)&&r.publication_year>0&&r.publication_year<=9999?r.publication_year:null;
  const venue=text(r?.primary_location?.source?.display_name);
  if(!title||!doi||(!y&&!venue)||(year!==undefined&&y!==year))continue;
  papers.push({title,doi,publication_year:y,venue,work_type:text(r.type),venue_type:text(r.primary_location?.source?.type),authors:Array.isArray(r.authorships)?r.authorships.flatMap((a:any)=>text(a?.author?.display_name)?[text(a.author.display_name)!]:[]):[],openalex_citation_count:Number.isSafeInteger(r.cited_by_count)&&r.cited_by_count>=0?r.cited_by_count:null});
 }
 papers.sort((a,b)=>Number(!!b.publication_year&&!!b.venue&&(['journal','conference'].includes(b.venue_type??'')||b.work_type==='proceedings-article'))-Number(!!a.publication_year&&!!a.venue&&(['journal','conference'].includes(a.venue_type??'')||a.work_type==='proceedings-article')));
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
export async function openAlexAnswer(q:string,year?:number):Promise<Record<string,unknown>>{
 const url=`https://api.openalex.org/works?search=${encodeURIComponent(normalizeAcademicQuery(q))}&per-page=10${year?`&filter=publication_year:${year}`:''}`;
 const observation=await read(url);const {total,papers}=parseOpenAlex(observation.raw,year);
 const evidence=JSON.stringify({query:q,year_filter:year??null,papers,total_matches:total,raw_body:observation.raw,fetched_at:observation.at,source_policy:'OpenAlex keyless index; source citation counts, not quality or peer-review proof; records missing both year and venue omitted; journal/proceedings metadata preferred; DOI-bearing records only'});
 const receipt=makeReceipt('ACADEMIC_SEARCH_GENERAL',url,evidence,'OpenAlex index metadata, not a quality or peer-review verdict');receipt.fetched_at=observation.at;
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 const listing=papers.map(p=>`${p.title} (${p.publication_year??'year unavailable'}; ${p.venue??'venue unavailable'}; ${p.openalex_citation_count??'unknown'} OpenAlex citations; DOI ${p.doi})`).join('; ');
 return envelope('ACADEMIC_SEARCH_GENERAL',{papers,paper_titles:papers.map(p=>p.title),dois:papers.map(p=>p.doi),total_matches:total,brief:Array.from(`${papers.length} OpenAlex results: ${papers[0]?.title??'no eligible records'}`).slice(0,80).join(''),year_filter:year??null,as_of:observation.at,fetched_at:observation.at,age_seconds:Math.max(0,Math.floor((Date.now()-Date.parse(observation.at))/1000)),stale:false,metadata_scope:'OpenAlex indexed metadata and citation counts, not proof of peer review'},receipt,{answer:`OpenAlex index: ${total} query matches${year?` in ${year}`:''}; ${papers.length} eligible DOI-bearing records. ${listing}. Metadata and citation counts are OpenAlex-only, not quality or peer-review proof. Within returned results, journal/proceedings records with both year and venue are preferred. Records missing both year and venue omitted; named index only, not all scholarly papers. Acquired ${observation.at}, cache up to15minutes.`,verdict:'verified',confidence:0.85,source:url});
}
