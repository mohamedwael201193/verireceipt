import {resetYahooTransportForTests} from './yahooTransport';
// Exact quote bodies only. Shared Yahoo cooldown is not bypassed via search or another ticker.
const FRESH_MS=5*60_000,MAX_AGE_MS=15*60_000,MAX_ENTRIES=128;
export interface EquityObservation {body:string;fetchedAt:string;staleReason?:string}
const cache=new Map<string,EquityObservation>();
const inFlight=new Map<string,Promise<EquityObservation>>();
let blockedUntil=0;
export function resetEquityCacheForTests():void{resetYahooTransportForTests();cache.clear();inFlight.clear();blockedUntil=0;}
export function assertYahooAllowed():void{if(Date.now()<blockedUntil)throw Object.assign(new Error('Yahoo HTTP429 cooldown; no request made'),{status:429});}
export function noteYahooRateLimit(retryAfter:string|null):void{
 const delay=retryAfter&&/^\d+$/.test(retryAfter.trim())?Number(retryAfter)*1000:retryAfter?Date.parse(retryAfter)-Date.now():0;
 blockedUntil=Math.max(blockedUntil,Date.now()+Math.max(60_000,Number.isFinite(delay)?delay:0));
}
export async function cachedEquityQuote(ticker:string,load:()=>Promise<string>,validate:(body:string)=>void):Promise<EquityObservation>{
 return cachedYahooBody(`quote:${ticker.toUpperCase().replace(".","-")}`,load,validate);
}
export async function cachedYahooSearch(asset:string,load:()=>Promise<string>,validate:(body:string)=>void):Promise<EquityObservation>{
 return cachedYahooBody(`search:${asset.trim().toLowerCase().replace(/\s+/g," ")}`,load,validate);
}
async function cachedYahooBody(ticker:string,load:()=>Promise<string>,validate:(body:string)=>void):Promise<EquityObservation>{
 const prior=cache.get(ticker),age=prior?Date.now()-Date.parse(prior.fetchedAt):Infinity;
 if(prior&&age>=0&&age<FRESH_MS){validate(prior.body);return prior;}
 const pending=inFlight.get(ticker);if(pending){const result=await pending;validate(result.body);return result;}
 const work=(async()=>{
  let body:string;
  try{assertYahooAllowed();body=await load();}
  catch(e){
   const status=(e as {status?:number})?.status;
   if(prior&&!(e as any)?.localCapacity&&((e as any)?.timeout||status===429||status!==undefined&&status>=500&&status<=599)){
    validate(prior.body);const nowAge=Date.now()-Date.parse(prior.fetchedAt);
    if(nowAge>=0&&nowAge<MAX_AGE_MS)return{...prior,staleReason:(e as any)?.timeout?'Yahoo source timeout':status===429?'Yahoo HTTP429 or active cooldown':'Yahoo server failure'};
   }
   throw e;
  }
  validate(body); // Invalid success must not turn into a stale pass or poison cache.
  const observation={body,fetchedAt:new Date().toISOString()};
  if(cache.size>=MAX_ENTRIES)cache.delete(cache.keys().next().value!);
  cache.set(ticker,observation);return observation;
 })();inFlight.set(ticker,work);
 try{return await work;}finally{inFlight.delete(ticker);}
}
