import {PublicBodyCache,StartBudget,readPublicBody} from '../core/publicSource';
const KEV='https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
let cache=new PublicBodyCache(129,3600000,()=>Date.now()),budget=new StartBudget(30,60000,()=>Date.now()),active=0;
export function resetTriageSignalsForTests(){cache=new PublicBodyCache(129,3600000,()=>Date.now());budget=new StartBudget(30,60000,()=>Date.now());active=0;}
const validDate=(s:unknown):s is string=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
export function parseKev(raw:string,id:string,now=Date.now()){
 const d=JSON.parse(raw),released=Date.parse(d.dateReleased);
 if(!Array.isArray(d.vulnerabilities)||!d.vulnerabilities.length||d.count!==d.vulnerabilities.length||!Number.isFinite(released)||released>now+60000||now-released>7*86400000||d.vulnerabilities.some((r:any)=>!/^CVE-\d{4}-\d{4,19}$/.test(r.cveID)||!validDate(r.dateAdded)||typeof r.requiredAction!=='string'||!r.requiredAction.trim()))throw Error('invalid KEV catalog');
 const matches=d.vulnerabilities.filter((r:any)=>r.cveID===id);if(matches.length>1)throw Error('duplicate KEV entry');const r=matches[0];return{kev_listed:!!r,kev_date_added:r?.dateAdded??null,kev_required_action:r?.requiredAction??null,kev_catalog_released:d.dateReleased,kev_status:'available'};
}
export function parseEpss(raw:string,id:string,now=Date.now()){
 const d=JSON.parse(raw);if(d.status!=='OK'||d['status-code']!==200||!Array.isArray(d.data)||d.data.length!==1||d.data[0].cve!==id)throw Error('EPSS identity missing');const r=d.data[0];const parse=(v:unknown)=>{if(typeof v!=='string'||! /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(v))throw Error('invalid probability');return Number(v);};if(!validDate(r.date)||Date.parse(r.date)>now+60000||now-Date.parse(r.date)>3*86400000)throw Error('EPSS stale date');return{epss_probability:parse(r.epss),epss_percentile:parse(r.percentile),epss_date:r.date,epss_status:'available'};
}
async function source(url:string,max:number,validate:(raw:string)=>unknown){return cache.get(url,async()=>{if(active>=3||!budget.take())throw Error('triage capacity');active++;let timer:ReturnType<typeof setTimeout>|undefined;
 const io=readPublicBody(url,max,2500).finally(()=>active--);
 try{const body=await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('triage hard deadline')),2600);})]);validate(body.raw);return body;}finally{clearTimeout(timer);}});}

export async function triageSignals(id:string){
 const epssUrl='https://api.first.org/data/v1/epss?cve='+id;
 const [kev,epss]=await Promise.all([source(KEV,4000000,r=>parseKev(r,id)).then(o=>({...parseKev(o.raw,id),source_url:KEV,fetched_at:o.fetchedAt,raw_body:o.raw})).catch(()=>({kev_listed:null,kev_date_added:null,kev_required_action:null,kev_catalog_released:null,kev_status:'unavailable',source_url:KEV,raw_body:null})),source(epssUrl,65536,r=>parseEpss(r,id)).then(o=>({...parseEpss(o.raw,id),source_url:epssUrl,fetched_at:o.fetchedAt,raw_body:o.raw})).catch(()=>({epss_probability:null,epss_percentile:null,epss_date:null,epss_status:'unavailable',source_url:epssUrl,raw_body:null}))]);return{kev,epss};
}
export function triagePriority(cvss:number,kev:boolean|null,epss:number|null){return kev===true?'critical':epss!==null&&epss>=.1||cvss>=9?'high':cvss>=7?'high':cvss>=4?'medium':cvss>0?'low':'none';}
export const PRIORITY_RULE='Derived priority: critical if CISA KEV-listed; otherwise high if EPSS probability>=0.1 or CVSS>=7 (including CVSS>=9); medium if CVSS>=4; low if CVSS>0; none if0. Missing KEV/EPSS stays unknown; priority may be incomplete. Not an environment-specific risk assessment.';
