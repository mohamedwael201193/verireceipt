// SEC financial inputs only. Exact bodies/time, bounded TTL, no stale fallback.
import {PublicBodyCache} from '../core/publicSource';
export interface SecObservation{body:string;fetchedAt:string}
let active=0;const draining=new Set<string>();
let indexCache=new PublicBodyCache(1,3600_000,()=>Date.now()),sharesCache=new PublicBodyCache(128,900_000,()=>Date.now()),factsCache=new PublicBodyCache(128,900_000,()=>Date.now());
export function resetSecFinancialCacheForTests(){active=0;draining.clear();indexCache=new PublicBodyCache(1,3600_000,()=>Date.now());sharesCache=new PublicBodyCache(128,900_000,()=>Date.now());factsCache=new PublicBodyCache(128,900_000,()=>Date.now());}
export async function cachedSecFinancial(kind:'index'|'shares'|'facts',key:string,load:()=>Promise<string>,validate:(body:string)=>void):Promise<SecObservation>{
 if(kind==='index'&&key!=='company_tickers'||kind==='shares'&&!/^\d{10}$/.test(key)||kind==='facts'&&!/^\d{10}:(RevenueFromContractWithCustomerExcludingAssessedTax|RevenueFromContractWithCustomerIncludingAssessedTax|Revenues|SalesRevenueNet|NetIncomeLoss|Assets)$/.test(key))throw Error('invalid SEC cache key');
 const got=await(kind==='index'?indexCache:kind==='shares'?sharesCache:factsCache).get(key,async()=>{const identity=kind+':'+key;
  if(draining.has(identity)||active>=4)throw Error('SEC source capacity unavailable; no request made');
  active++;let settled=false,timedOut=false,timer:ReturnType<typeof setTimeout>;
  const io=Promise.resolve().then(load).finally(()=>{settled=true;active--;draining.delete(identity);});
  try{
   const body=await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;if(!settled)draining.add(identity);reject(Error('SEC source total deadline exceeded'));},10000);})]);
   if(timedOut)throw Error('SEC source total deadline exceeded');
   validate(body);return{url:key,raw:body,fetchedAt:new Date().toISOString()};
  }finally{clearTimeout(timer!);}
 });
 validate(got.raw);return{body:got.raw,fetchedAt:got.fetchedAt};
}
