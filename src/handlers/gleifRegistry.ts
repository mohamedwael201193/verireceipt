import {badRequest,unprocessable,upstreamUnavailable} from '../core/errors';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {readPublicBody} from '../core/publicSource';
const TERMS='https://www.gleif.org/en/meta/lei-data-terms-of-use';
const cache=new Map<string,{raw:string;fetchedAt:string}>();
const flights=new Map<string,Promise<{raw:string;fetchedAt:string}>>();
let nextStart=0;let blocked=false;
export function resetGleifForTests():void{cache.clear();flights.clear();nextStart=0;blocked=false;}
export function gleifJurisdiction(input:string):string {
 const value=input.trim();if(/^[a-z]{2}(?:-[a-z0-9]{1,3})?$/i.test(value))return value.toUpperCase()==='UK'?'GB':value.toUpperCase();
 const aliases:Record<string,string>={'uk':'GB','united kingdom':'GB','great britain':'GB','england':'GB','usa':'US','united states of america':'US'};
 if(aliases[value.toLowerCase()])return aliases[value.toLowerCase()];
 const names=new Intl.DisplayNames(['en'],{type:'region'});
 for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){const code=String.fromCharCode(a,b);if(names.of(code)?.toLowerCase()===value.toLowerCase())return new Intl.Locale('und-'+code).maximize().region!;}
 throw badRequest('INVALID_JURISDICTION','supply an ISO jurisdiction code or an unambiguous English country name');
}
function creationDate(value:unknown):string|null {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value))return null;
 const day=value.slice(0,10),ms=Date.parse(day+'T00:00:00Z');
 return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===day&&Number.isFinite(Date.parse(value))?day:null;
}
const norm=(s:string)=>s.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function parseGleif(raw:string,company:string,jurisdiction:string):{entity:any;lei:string}|null {
 const body=JSON.parse(raw);if(!Array.isArray(body.data)||!Number.isInteger(body.meta?.pagination?.total)||body.meta.pagination.total<0||body.meta.pagination.total<body.data.length)throw new Error('malformed GLEIF result');
 const hits=body.data.filter((r:any)=>typeof r.attributes?.entity?.legalName?.name==='string' && norm(r.attributes.entity.legalName.name)===norm(company) && r.attributes.entity.jurisdiction===jurisdiction);
 if(hits.length>1)throw unprocessable('AMBIGUOUS_COMPANY','multiple exact GLEIF legal names in this jurisdiction; supply a more specific registered name');
 if(body.meta.pagination.total>body.data.length)throw unprocessable('AMBIGUOUS_COMPANY','search page incomplete; no company guessed');
 if(!hits.length)return null;
 const h=hits[0],e=h.attributes.entity;
 if(typeof h.attributes.lei!=='string'||!/^[A-Z0-9]{20}$/.test(h.attributes.lei)||!['ACTIVE','INACTIVE'].includes(e.status)||typeof e.registeredAs!=='string'||!e.registeredAs.trim()||!e.legalAddress||!Array.isArray(e.legalAddress.addressLines)||!e.legalAddress.addressLines.every((v:unknown)=>typeof v==='string')||typeof e.legalAddress.city!=='string'||typeof e.legalAddress.country!=='string')throw new Error('incomplete GLEIF legal entity');
 return {entity:e,lei:h.attributes.lei};
}
async function readGleif(url:string):Promise<{raw:string;fetchedAt:string}> {
 const prior=cache.get(url);if(prior&&Date.now()-Date.parse(prior.fetchedAt)>=0&&Date.now()-Date.parse(prior.fetchedAt)<3600000)return prior;
 const pending=flights.get(url);if(pending)return pending;
 if(blocked)throw new Error('GLEIF access halted');
 const wait=Math.max(0,nextStart-Date.now());if(wait>1500)throw new Error('GLEIF pacing busy');
 nextStart=Date.now()+wait+1100;
 const work=(async()=>{if(wait)await new Promise(r=>setTimeout(r,wait));if(blocked)throw new Error('GLEIF access halted');
  // readPublicBody refuses all non-200 responses without retries or proxying.
  try{let timer:ReturnType<typeof setTimeout>;
   const result=await Promise.race([readPublicBody(url,1000000,3000),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('GLEIF deadline')),3100);})]).finally(()=>clearTimeout(timer!));
   cache.set(url,result);if(cache.size>100)cache.delete(cache.keys().next().value!);return result;}catch(e){blocked=true;throw e;}
 })();flights.set(url,work);try{return await work;}finally{flights.delete(url);}
}
export async function handleGleifRegistry(company:string,jurisdictionRaw:string):Promise<Record<string,unknown>> {
 const jurisdiction=gleifJurisdiction(jurisdictionRaw);
 const url=new URL('https://api.gleif.org/api/v1/lei-records');url.searchParams.set('filter[entity.legalName]',company);url.searchParams.set('filter[entity.jurisdiction]',jurisdiction);url.searchParams.set('page[size]','100');
 let body:{raw:string;fetchedAt:string};let match:ReturnType<typeof parseGleif>;
 try{body=await readGleif(url.toString());match=parseGleif(body.raw,company,jurisdiction);}catch(e){if(e&&typeof e==='object'&&'status'in e&&(e as {status:number}).status===422)throw e;throw upstreamUnavailable('GLEIF_UNAVAILABLE','GLEIF lookup unavailable or incomplete; no entity facts guessed');}
 const e=match?.entity;
 const address=e?[...e.legalAddress.addressLines,e.legalAddress.city,e.legalAddress.region,e.legalAddress.postalCode,e.legalAddress.country].filter((s:unknown)=>typeof s==='string'&&s).join(', '):null;
 const creation=creationDate(e?.creationDate);
 const fields={legal_name:e?.legalName.name??null,registration_id:e?.registeredAs??null,active:e?e.status==='ACTIVE':null,jurisdiction,registered_address:address,incorporated:creation,lei:match?.lei??null,lookup_status:match?'found':'not_found'};
 const notice='GLEIF LEI reference data; coverage is incomplete. No match does not prove nonexistence. Active is entity.status, not LEI renewal status or legal good standing. Incorporated is registry-reported entity creationDate when present, never LEI initial registration. No affiliation with or endorsement by GLEIF.';
 const evidence=JSON.stringify({company,requested_jurisdiction:jurisdictionRaw,...fields,source_policy:notice,terms:{url:TERMS,checked_at:'2026-11-24',licence:'CC0 1.0',commercial_use:true,redistribution:true},raw_body:body.raw,source_url:url.toString(),fetched_at:body.fetchedAt});
 const receipt=makeReceipt('CORPORATE_REGISTRY_LOOKUP_GENERAL',url.toString(),evidence,'GLEIF LEI reference data, incomplete coverage');receipt.fetched_at=body.fetchedAt;
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','registry evidence could not be stored');}
 const answer=match?`${fields.legal_name}, registration ${fields.registration_id}, jurisdiction ${jurisdiction}, entity status ${e.status}; registered address ${address}; entity creation date ${creation??'not supplied'}. ${notice}`:`No exact legal-name match for ${company} in ${jurisdiction} in GLEIF. ${notice}`;
 return envelope('CORPORATE_REGISTRY_LOOKUP_GENERAL',fields,receipt,{answer,verdict:match?'verified':'not_found',confidence:match?0.85:0,source:url.toString()});
}

/** Global name search for vendor research, not an assertion of legal identity. */
export async function searchGleifVendor(company:string):Promise<Record<string,unknown>> {
 const url=new URL('https://api.gleif.org/api/v1/lei-records');url.searchParams.set('filter[entity.legalName]',company);url.searchParams.set('page[size]','100');
 const body=await readGleif(url.toString());const data=JSON.parse(body.raw);
 if(!Array.isArray(data.data)||!Number.isInteger(data.meta?.pagination?.total)||data.meta.pagination.total<data.data.length)throw Error('invalid GLEIF vendor search');
 const candidates=data.data.filter((r:any)=>typeof r.attributes?.entity?.legalName?.name==='string'&&typeof r.attributes?.lei==='string'&&/^[A-Z0-9]{20}$/.test(r.attributes.lei)).map((r:any)=>({legal_name:r.attributes.entity.legalName.name,lei:r.attributes.lei,jurisdiction:r.attributes.entity.jurisdiction??null,status:r.attributes.entity.status??null,exact_name:norm(r.attributes.entity.legalName.name)===norm(company)}));
 return {status:'completed',source_url:url.toString(),raw_body:body.raw,fetched_at:body.fetchedAt,total:data.meta.pagination.total,page_complete:data.meta.pagination.total===data.data.length,candidates:candidates.slice(0,20),exact_name_candidates:candidates.filter((r:any)=>r.exact_name).slice(0,20),scope:'GLEIF name search only, not identity confirmation. LEI coverage is incomplete; a miss does not prove nonexistence and a name match does not validate VAT.'};
}
