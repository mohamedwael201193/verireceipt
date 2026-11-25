import{getReceiptEvidence}from'../core/storage';
import{sha256Hex}from'../core/receipt';
/** Bounded successful-observation cache. Reuse never changes receipt/source time. */
export class TenMinuteObservation{
 constructor(private verify: (result:Record<string,unknown>)=>Promise<boolean>=async result=>{
  const receipt=result.receipt as {receipt_id?:string;raw_response_sha256?:string}|undefined;
  if(!receipt?.receipt_id)return false;
  try{const saved=await getReceiptEvidence(receipt.receipt_id);return Boolean(saved.found&&saved.evidence?.length&&sha256Hex(saved.evidence)===receipt.raw_response_sha256);}catch{return false;}
 }){}
 private rows=new Map<string,{result:Record<string,unknown>;at:number;until:number}>();
 private pending=new Map<string,Promise<Record<string,unknown>>>();
 clear(){this.rows.clear();this.pending.clear();}
 async get(key:string,load:()=>Promise<Record<string,unknown>>,boundary?:(result:Record<string,unknown>)=>number):Promise<Record<string,unknown>>{
  const now=Date.now(),prior=this.rows.get(key);
  if(prior&&now>=prior.at&&now<prior.until&&await this.verify(prior.result))return this.describe(prior.result,prior.at,true);
  if(this.pending.has(key)){const shared=structuredClone(await this.pending.get(key)!);return{...shared,observation_cached:true,observation_shared_inflight:true,answer:'SHARED IN-FLIGHT OBSERVATION, not a separate source check. '+String(shared.answer??'')};}
  if(this.pending.size>=128)throw Error('observation cache capacity');
  const work=(async()=>{
   const result=await load(),at=Date.now(),until=Math.min(at+600000,boundary?.(result)??Infinity);
   if(this.rows.size>=128)this.rows.delete(this.rows.keys().next().value!);
   this.rows.set(key,{result:structuredClone(result),at,until});
   return this.describe(result,at,false);
  })();this.pending.set(key,work);
  try{return await work;}finally{this.pending.delete(key);}
 }
 private describe(result:Record<string,unknown>,at:number,cached:boolean){return{...structuredClone(result),observation_cached:cached,cache_observed_at:new Date(at).toISOString(),cache_age_seconds:Math.floor((Date.now()-at)/1000),cache_ttl_seconds:600,answer:(cached?'CACHED OBSERVATION, not a new source check. ':'')+String(result.answer??'')};}
}
