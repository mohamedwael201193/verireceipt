import {cachedSecFinancial} from './secFinancialCache';

// SEC companyconcept data is optional enrichment. Failure must not invent a
// metric or invalidate a separately evidenced price-times-shares observation.
export function annualUsdFact(raw:string,cik:string,tag:string,annualAnchors:Record<string,unknown>[]=[]):Record<string,unknown>|null {
 const data=JSON.parse(raw);
 if(data.cik!==Number(cik)||data.taxonomy!=='us-gaap'||data.tag!==tag||!Array.isArray(data.units?.USD)) {
  throw Error('SEC concept identity/unit mismatch');
 }
 const realDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
 const today=new Date().toISOString().slice(0,10);
 const rows=data.units.USD.filter((row:any)=>{
  if(!['10-K','10-K/A'].includes(row.form)||row.fp!=='FY'||!realDate(row.end)||!realDate(row.filed)||row.end>today||row.filed>today||row.filed<row.end||typeof row.val!=='number'||!Number.isFinite(row.val)||!/^\d{10}-\d{2}-\d{6}$/.test(row.accn))return false;
  if(tag!=='NetIncomeLoss'&&row.val<0)return false;
  if(tag==='Assets')return row.start===undefined&&annualAnchors.some(anchor=>anchor.period_end===row.end&&anchor.accession===row.accn&&anchor.filed===row.filed);
  if(!realDate(row.start))return false;
  const days=(Date.parse(row.end)-Date.parse(row.start))/86400000;
  return days>=335&&days<=395;
 });
 // fy is the filing's fiscal year, not necessarily the reported fact's period.
 // Period end first, then the newest filing, includes later restatements.
 rows.sort((a:any,b:any)=>b.end.localeCompare(a.end)||b.filed.localeCompare(a.filed));
 const row=rows[0];if(!row)return null;
 const peers=rows.filter((r:any)=>r.end===row.end&&r.filed===row.filed);
 if(peers.some((r:any)=>r.val!==row.val||r.start!==row.start))throw Error('conflicting same-period SEC facts');
 return {value_usd:row.val,period_start:row.start??null,period_end:row.end,filed:row.filed,accession:row.accn,form:row.form,concept:tag,source_unit:'USD'};
}

export async function annualFinancialMetrics(cik:string,ua:string,fetchText:(url:string,ua:string)=>Promise<string>):Promise<Record<string,unknown>> {
 const deadline=Date.now()+10000;
 const revenueTags=['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet','RevenueFromContractWithCustomerIncludingAssessedTax'];
 const read=async(tag:string)=>{
  const url=`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
   const observation=await Promise.race([cachedSecFinancial('facts',cik+':'+tag,()=>fetchText(url,ua),raw=>{annualUsdFact(raw,cik,tag);}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('annual enrichment deadline')),Math.max(0,deadline-Date.now()));})]);
   const fact=annualUsdFact(observation.body,cik,tag);
   return {status:fact?'reported':'no_annual_fact',fact,source_url:url,fetched_at:observation.fetchedAt,raw_body:observation.body};
  } catch {
   return {status:'unavailable',fact:null,attempted_source_url:url,raw_body:null};
  }finally{clearTimeout(timer);}
 };
 // At most three concurrent SEC calls. Revenue concepts are checked in order,
 // not raced past the shared source capacity guard.
 const [revenues,income,totalAssets]=await Promise.all([(async()=>{const rows=[];for(const tag of revenueTags){if(Date.now()>=deadline)break;rows.push(await read(tag));}return rows;})(),read('NetIncomeLoss'),read('Assets')]);
 const available=revenues.filter(row=>row.fact).sort((a,b)=>String(b.fact!.period_end).localeCompare(String(a.fact!.period_end))||String(b.fact!.filed).localeCompare(String(a.fact!.filed)));
 const selected=available[0]??revenues[0];
 const metrics:Record<string,any>={annual_revenue:{...selected,selection_method:'latest annual period end across revenue concepts, then latest filing, then stated concept order; including/excluding tax meanings are not equated',candidate_observations:revenues},annual_net_income:income,annual_total_assets:totalAssets};
 const anchors=['annual_revenue','annual_net_income'].map(key=>metrics[key].fact).filter(Boolean) as Record<string,unknown>[];
 const assets=metrics.annual_total_assets;
 if(assets.raw_body){
  try{assets.fact=annualUsdFact(assets.raw_body,cik,'Assets',anchors);assets.status=assets.fact?'reported':'no_annual_fact';if(assets.fact)assets.fact.annual_period_evidence=anchors.filter(anchor=>anchor.period_end===assets.fact!.period_end&&anchor.accession===assets.fact!.accession&&anchor.filed===assets.fact!.filed);}
  catch{assets.fact=null;assets.status='unavailable';}
 }
 const periods=Object.values(metrics).map((m:any)=>m.fact?.period_end).filter(Boolean);
 const aligned=new Set(periods).size<=1;
 for(const metric of Object.values(metrics))metric.period_alignment=aligned?'reported annual periods align':'mixed annual period ends; compare each disclosed period, not one fiscal year';
 return metrics;
}
