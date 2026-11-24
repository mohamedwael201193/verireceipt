// Wallet-free replay: primary bytes are reparsed locally; only public node
// and our receipt-origin GET endpoints may be contacted for proof rechecks.
import {createHash} from 'node:crypto';
import {replayPacket,type ResearchPacket,type FactSpec,type Observation} from './researchDesk.js';
import {verifyFilingSource} from './filingSource.js';
import {reconcilePrimaryAnswer} from './sourceTypes.js';
import {verifyResearchPrimary} from './researchPrimary.js';
import {verifyNodeLevel} from './gate.js';
import {decodeReceipt} from './escrow.js';
import {evidenceGet} from './judgeReplay.js';
import {verifyPurchase} from './verify.js';
import {VERIRECEIPT_ONCHAIN_MINER_IDS} from './constants.js';
import type {RawResponse,Fetch} from './client.js';
export async function replayPrimaryBytes(fact:FactSpec,o:Observation,historical_at:string):Promise<boolean>{
 try{
  if(!o.source||o.value===null||createHash('sha256').update(o.source.raw_text).digest('hex')!==o.source.content_sha256)return false;
  const reads=JSON.parse(o.source.raw_text);if(!Array.isArray(reads)||!reads.length)return false;let cursor=0;
  const f:Fetch=async(input,init)=>{
   const r=reads[cursor++];const url=String(input);if(!r||r.url!==url||(r.method??'GET')!==(init?.method??'GET')||(r.body??null)!==(init?.body??null))throw new Error('stored primary request does not match parser request');
   if(typeof r.raw_text!=='string'||!Number.isFinite(Date.parse(r.observed_at))||Date.parse(r.observed_at)>Date.parse(historical_at))throw new Error('stored bytes/time missing or future');return new Response(r.raw_text,{status:200});
  };
  const result=await verifyResearchPrimary(fact,o.value,{f,now:()=>new Date(reads[Math.max(0,cursor-1)]?.observed_at??historical_at),secUserAgent:'Historical replay replay@example.invalid'});
  return result.ok&&result.as_of===o.as_of&&Number.isFinite(Date.parse(o.as_of))&&Date.parse(o.as_of)<=Date.parse(historical_at)&&Date.parse(historical_at)-Date.parse(o.as_of)<=fact.max_age_seconds*1000&&JSON.stringify(result.source)===JSON.stringify(o.source)&&cursor===reads.length;
 }catch{return false;}
}
// Re-evaluate provider assertions against fixed stored SEC bytes, never a paid fetch.
export async function replayFilingAssertionsBytes(fact:FactSpec,o:Observation,answer:Record<string,unknown>,completed_at:string,providerResult?:Record<string,unknown>):Promise<boolean>{
 try{
  if(!o.source||createHash('sha256').update(o.source.raw_text).digest('hex')!==o.source.content_sha256)return false;
  const reads=JSON.parse(o.source.raw_text);if(!Array.isArray(reads)||!reads.length)return false;let cursor=0;
  const stored:Fetch=async(input,init)=>{const row=reads[cursor++];if(!row||row.url!==String(input)||(row.method??'GET')!==(init?.method??'GET')||!Number.isFinite(Date.parse(row.observed_at))||Date.parse(row.observed_at)>Date.parse(completed_at))throw new Error('SEC assertion replay source mismatch');return new Response(row.raw_text,{status:200});};
  const source=await verifyFilingSource({params:fact.params,result:answer,providerResult},{f:stored,now:new Date(completed_at),secUserAgent:'Historical replay replay@example.invalid'});
  return source.status==='verified'&&cursor===reads.length;
 }catch{return false;}
}
export async function replayResearchDeskPublic(packet:ResearchPacket,expected_spec_hash:string,loadRaw:(factId:string)=>RawResponse,f:Fetch=fetch):Promise<{ok:boolean;checks:{name:string;ok:boolean;detail:string}[]}>{
 const checks:{name:string;ok:boolean;detail:string}[]=[];const add=(name:string,ok:boolean,detail:string)=>checks.push({name,ok,detail});
 const core=replayPacket(packet,expected_spec_hash);add('offline packet/spec replay',core.ok,core.reasons.join('; ')||'exact calculations and stored digests agree');
 if(!core.ok)return {ok:false,checks};
 const publicGet=evidenceGet(f);
 for(const fact of packet.spec.facts){
  const o=packet.observations.find(x=>x.fact_id===fact.id)!;
  try{
   add(`${fact.id}: independently reparse stored primary bytes`,await replayPrimaryBytes(fact,o,packet.completed_at),'Replayed exact source selectors, no paid/provider call');
   const raw=loadRaw(fact.id);const auth=raw.authorization;
   if(raw.status!==200||auth.from.toLowerCase()===''||auth.value!==o.acquisition_cost_uusdc)throw new Error('saved paid response/authorization shape mismatch');
   const receipt=decodeReceipt(raw.headers['x-payment-response']??null,{payer:auth.from,amountUusdc:auth.value});
   if(receipt.receipt_hash!==o.receipt_hash||String(receipt.miner)!==o.serving_registration)throw new Error('saved receipt binding mismatch');
   const body=JSON.parse(raw.bodyText);
   if(body.signal_hash!==o.signal_hash||String(body.result?.[fact.field])!==o.value)throw new Error('saved signal/value binding mismatch');
   const verified=await verifyNodeLevel({exactNumericTransport:true,payer:auth.from,signalHash:o.signal_hash,intent:fact.intent,askedParams:fact.params,valueField:fact.field,engineResult:body.result??{},fieldStatus:body.field_status,receipt:{receipt_hash:receipt.receipt_hash,amount_uusdc:receipt.amount_uusdc,epoch_id:receipt.epoch_id,timestamp:receipt.timestamp,miner:String(receipt.miner)},runStartedMs:Date.parse(packet.spec.frozen_at),verifiedAtMs:Date.parse(packet.completed_at)},publicGet);
   add(`${fact.id}: current public node proof`,verified.ok,verified.checks.filter(x=>!x.ok).map(x=>x.name).join('; ')||'signal rederived, payer/intent/params/value/delivery/epoch match');
   if(fact.intent==='REGULATORY_FILING_MONITOR_GENERAL'){
    if(!verified.ok||!verified.providerResponse)throw new Error('SEC assertion replay needs verified provider bytes');
    const answer=reconcilePrimaryAnswer(fact.intent,body.result??{},body.field_status??{},verified.providerResponse,true).result;
    add(`${fact.id}: provider filing assertions replay`,await replayFilingAssertionsBytes(fact,o,answer,packet.completed_at,verified.providerResponse),'Rechecked complete provider assertions against stored primary rows with distinct filing and report dates');
   }

   const own=VERIRECEIPT_ONCHAIN_MINER_IDS.includes(String(receipt.miner));
   add(`${fact.id}: supply label`,o.supply===(own?'own':'external'),'serving registration controls own/external label');
   if(o.integrity_level==='L2_RAW_BYTES'){
    if(!own)throw new Error('unknown raw receipt origin for external L2 claim');
    const v=await verifyPurchase({payer:auth.from,minerSlug:'verireceipt',signalHash:o.signal_hash,intent:fact.intent,valueField:fact.field,engineResult:body.result,fieldStatus:body.field_status},publicGet);
    add(`${fact.id}: raw byte receipt chain`,v.verified,'current stored provider receipt/raw digest match');
   }
  }catch(e){add(`${fact.id}: replay error`,false,e instanceof Error?e.message:String(e));}
 }
 return {ok:checks.length>0&&checks.every(c=>c.ok),checks};
}
