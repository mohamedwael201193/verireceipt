// Local CLI adapter only. Hosted mode has no route to this module.
import {appendFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {executeVerifiedPurchase,type SpendLedger} from './gate.js';
import type {Fetch,Payer,RawResponse} from './client.js';
import {ENGINE_URL,VERIRECEIPT_ONCHAIN_MINER_IDS} from './constants.js';
import {decimal,factHash,hash,observationFailures,type FactSpec,type Observation,type Layer} from './researchDesk.js';
import type {ResearchAdapter,Acquisition,RunStore} from './researchDeskRunner.js';
import snapshot from '../policy/m13-intents.snapshot.json';
import {verifyResearchPrimary} from './researchPrimary.js';
const layer=(ok:boolean,name:string,detail:string):Layer=>({status:ok?'passed':'failed',checks:[{name,ok,detail}]});
export interface LiveOptions {payer:Payer;spend:SpendLedger;evidence_dir:string;run_ledger:string;f?:Fetch;now?:()=>Date;secUserAgent?:string}
interface SchemaCheck {ok:boolean;checks:Layer['checks'];schema_hash:string}
export async function validateLiveFact(fact:FactSpec,f:Fetch=fetch):Promise<SchemaCheck>{
 const response=await f(`${ENGINE_URL}/v1/intents/${encodeURIComponent(fact.intent)}`,{redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(`live schema HTTP ${response.status}`);const raw=await response.text();const j=JSON.parse(raw);
 const params=j.request?.params,fields=j.response?.fields;
 const checks:Layer['checks']=[];const add=(name:string,ok:boolean,detail:string)=>checks.push({name,ok,detail});
 add('active exact intent',j.intent_name===fact.intent&&j.lifecycle?.state==='active',fact.intent);
 add('request/response schemas present',Array.isArray(params)&&Array.isArray(fields),'null schemas cannot buy');
 if(Array.isArray(params)){
  add('required params',params.every((p:any)=>!p.required||Object.hasOwn(fact.params,p.name)),'exact live required names');
  add('no undeclared params',Object.keys(fact.params).every(key=>params.some((p:any)=>p.name===key)),'reject unknown params');
  for(const p of params){const value=fact.params[p.name];if(value===undefined)continue;
   add(`param ${p.name}`,typeof value==='string'&&value.trim().length>0&&(!Array.isArray(p.allowed)||p.allowed.includes(p.type==='integer'?Number(value):value))&&(p.type!=='integer'||(/^-?\d+$/.test(value)&&Number.isSafeInteger(Number(value))&&(p.min===undefined||Number(value)>=p.min)&&(p.max===undefined||Number(value)<=p.max))),`type ${String(p.type)}`);
  }
 }
 const field=Array.isArray(fields)?fields.find((x:any)=>x.name===fact.field):null;
 add('numeric response contract',field?.type==='number'&&field.scored===true,'numeric scored field required');
 const frozen=snapshot.schemas.find(s=>s.intent_name===fact.intent);
 add('response contract unchanged',!!frozen&&hash(field??null)===hash(frozen.response.fields.find(x=>x.name===fact.field)??null),'fail closed on field/unit/range revision');
 add('request contract unchanged',!!frozen&&hash(j.request)===hash(frozen.request),'fail closed on parameter/selector revision');
 return {ok:checks.every(c=>c.ok),checks,schema_hash:hash(j)};
}
export function localResearchStore(directory:string):RunStore {
 mkdirSync(directory,{recursive:true});
 return {freeze:async(spec,spec_hash)=>{writeFileSync(join(directory,'frozen-spec.json'),JSON.stringify({spec,spec_hash},null,2),{flag:'wx'});},append:async(a)=>{appendFileSync(join(directory,'acquisitions.jsonl'),JSON.stringify(a)+'\n');},finish:async(packet)=>{writeFileSync(join(directory,'research-packet.json'),JSON.stringify(packet,null,2),{flag:'wx'});}};
}
export function liveResearchAdapter(options:LiveOptions):ResearchAdapter {
 const f=options.f??fetch,now=options.now??(()=>new Date());mkdirSync(options.evidence_dir,{recursive:true});
 // Each successful buy stores its public proof inputs for read-only revalidation.
 return {
  allowEscalation:false,
  buy:async(fact,context):Promise<Acquisition>=>{
   if(context.escalation)throw new Error('distinct-provider ranked escalation not enabled; no retry signed');
   const schema=await validateLiveFact(fact,f);if(!schema.ok)throw new Error('live schema contract failed before purchase');
   const rawFile=join(options.evidence_dir,`${fact.id}-paid-response.json`);
   let reserved=0n;let rawCapture:RawResponse|undefined;
   const result=await executeVerifiedPurchase({intent:fact.intent,params:fact.params,valueField:fact.field,kind:'research-desk'},options.payer,{
    spend:options.spend,f,now,secUserAgent:options.secUserAgent,
    durableBeforeSign:async notice=>{
      if(notice.amountUusdc>BigInt(context.remaining_uusdc))throw new Error('quote exceeds frozen note remainder');
      // Gate already wrote the shared reservation. This write binds the note
      // commitment and quote before the signer is reached. Failure refuses sign.
      writeFileSync(join(options.evidence_dir,`${fact.id}-reservation.json`),JSON.stringify({spec_hash:context.spec_hash,fact_hash:factHash(fact),nonce:notice.authorization.nonce,amount_uusdc:notice.amountUusdc.toString()}),{flag:'wx'});reserved=notice.amountUusdc;
    },
    onRawResponse:async raw=>{writeFileSync(rawFile,JSON.stringify(raw,null,2),{flag:'wx'});rawCapture=raw;},
   });
   // The shared Gate ledger shape counts this exact charge/reservation and nonce.
   appendFileSync(options.run_ledger,JSON.stringify({evaluated_at:now().toISOString(),purchase:result.purchase,spec_hash:context.spec_hash,fact_hash:factHash(fact)})+'\n');
   writeFileSync(join(options.evidence_dir,`${fact.id}-gate.json`),JSON.stringify(result,null,2),{flag:'wx'});
   const p=result.purchase;
   if(!p.nonce||reserved===0n)throw new Error('purchase refused before signing; no adapter retry');
   const expense:Acquisition['expense']={fact_id:fact.id,attempt:0,nonce:p.nonce,reserved_uusdc:reserved.toString(),reported_charge_uusdc:p.paid_uusdc,settled_uusdc:null,status:p.paid_uusdc===null?'reserved-uncertain':'receipted-unsettled',receipt_hash:p.receipt_hash,useful:false};
   const no=(failure:string):Acquisition=>({expense,observation:null,failure});
   if(!result.evidenceOk||!p.receipt_hash||!result.signal_hash||!rawCapture)return no(result.reasons.join('; ')||'node/receipt verification failed');
   let value:string;try{if(typeof result.value!=='number'||!Number.isFinite(result.value))throw new Error('numeric field unavailable');value=String(result.value);decimal(value);}catch{return no('numeric value unavailable or not plain decimal');}
   const primary=await verifyResearchPrimary(fact,value,{f,now,secUserAgent:options.secUserAgent});
   if(!primary.ok||!primary.source||!primary.as_of)return no(primary.reasons.join('; '));
   const observation:Observation={fact_id:fact.id,request_hash:factHash(fact),value,unit:fact.unit,as_of:primary.as_of,acquired_at:now().toISOString(),receipt_hash:p.receipt_hash,signal_hash:result.signal_hash,serving_registration:p.serving_miner!,supply:VERIRECEIPT_ONCHAIN_MINER_IDS.includes(p.serving_miner!)?'own':'external',acquisition_cost_uusdc:reserved.toString(),integrity_level:result.miner_chain==='passed'?'L2_RAW_BYTES':'L1_SIGNAL_ONLY',reuse:'fresh-purchase',layers:{schema:{status:'passed',checks:schema.checks},receipt:{status:'passed',checks:result.node_checks},semantics:layer(true,'independent exact-selector source match',primary.source.parser),primary:layer(true,'independent primary read',primary.source.url)},source:primary.source};
   const failures=observationFailures(fact,observation,now().toISOString());if(failures.length)return no(failures.join('; '));
   expense.useful=true;
   return {expense,observation,failure:null};
  },
  revalidate:async()=>{
   // Reuse is intentionally disabled until public receipt replay is attached.
   // A paid adapter must never endorse self-reported cached checks.
   return null;
  },
 };
}
