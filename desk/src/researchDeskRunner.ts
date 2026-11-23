// Orchestration only: adapters own purchases and source validation. No signer
// or key import here. Persist the frozen spec before invoking any paid adapter.
import {buildPacket,expenseSummary,factHash,hash,observationFailures,validateSpec,type ThesisSpec,type FactSpec,type Observation,type Expense,type Claim,type ResearchPacket} from './researchDesk.js';
export interface Acquisition { observation:Observation|null; expense:Expense; failure:string|null }
export interface ResearchAdapter {
  // Must reserve against both this note and the shared daily ledger BEFORE signing.
  // escalation=true permits a distinct ranked provider, never unknown-charge retry.
  buy(fact:FactSpec,context:{spec_hash:string;remaining_uusdc:string;escalation:boolean}):Promise<Acquisition>;
  // Revalidation must verify source/receipt integrity, not trust cached booleans.
  revalidate(cached:Observation,fact:FactSpec,at:string):Promise<Observation|null>;
}
export interface RunStore {
  freeze(spec:ThesisSpec,specHash:string):Promise<void>;
  append(acquisition:Acquisition):Promise<void>;
  finish(packet:ResearchPacket):Promise<void>;
}
export async function runResearchDesk(spec:ThesisSpec,claims:Claim[],adapter:ResearchAdapter,store:RunStore,cache:Observation[]=[],now=()=>new Date()):Promise<ResearchPacket>{
  validateSpec(spec);
  // Copy before await: a caller cannot revise the frozen plan while a buy runs.
  spec=structuredClone(spec);claims=structuredClone(claims);const spec_hash=hash(spec);
  // Validate every predicate/reference before the first external purchase.
  buildPacket(spec,[],[],claims,spec.frozen_at);
  await store.freeze(structuredClone(spec),spec_hash);
  if(hash(spec)!==spec_hash)throw new Error('frozen spec changed');
  const observations:Observation[]=[],expenses:Expense[]=[];
  let escalated=false;
  const remaining=()=>BigInt(spec.budget_uusdc)-expenses.reduce((n,e)=>n+BigInt(e.settled_uusdc??e.reserved_uusdc),0n);
  const buy=async(f:FactSpec,escalation:boolean)=>{
    if(remaining()<BigInt(spec.max_call_uusdc))return null;
    // A thrown adapter error is deliberately not retried. It may have signed.
    const a=structuredClone(await adapter.buy(structuredClone(f),{spec_hash,remaining_uusdc:remaining().toString(),escalation}));
    if(a.failure!==null&&typeof a.failure!=='string')throw new Error('malformed acquisition failure');
    if(a.expense.fact_id!==f.id||a.expense.attempt!==(escalation?1:0))throw new Error('adapter acquisition binding mismatch');
    // Full validation, including negative amounts and duplicate nonces, precedes
    // append and any later adapter call. Invalid rows never increase authority.
    expenseSummary([...expenses,a.expense]);
    if(BigInt(a.expense.reserved_uusdc)>BigInt(spec.max_call_uusdc)||BigInt(a.expense.reserved_uusdc)>remaining())throw new Error('adapter exceeded reserved note authority');
    if(a.observation&&(a.observation.fact_id!==f.id||a.observation.request_hash!==factHash(f)||a.observation.receipt_hash!==a.expense.receipt_hash))throw new Error('observation/expense binding mismatch');
    const escalationAllowed=!a.expense.useful;
    if(a.failure!==null||!a.observation||observationFailures(f,a.observation,now().toISOString()).length){a.observation=null;a.expense.useful=false;}
    await store.append(structuredClone(a));expenses.push(structuredClone(a.expense));return {...structuredClone(a),escalationAllowed};
  };
  for(const f of spec.facts){
    const cached=cache.find(o=>o.request_hash===factHash(f)&&!observationFailures(f,{...o,fact_id:f.id},now().toISOString()).length);
    if(cached){const validated=structuredClone(await adapter.revalidate(structuredClone(cached),structuredClone(f),now().toISOString()));if(validated&&!observationFailures(f,validated,now().toISOString()).length){observations.push({...validated,reuse:'fresh-receipt-reuse'});continue;}}
    let a=await buy(f,false);
    if(!a)continue;
    const valid=(x:Acquisition)=>x.failure===null&&x.observation!==null&&!observationFailures(f,x.observation,now().toISOString()).length;
    if(!valid(a)&&!escalated&&a.expense.status!=='reserved-uncertain'&&a.escalationAllowed){
      escalated=true;const second=await buy(f,true);if(second)a=second;
    }
    if(a.observation)observations.push(a.observation);
  }
  if(hash(spec)!==spec_hash)throw new Error('frozen spec changed during acquisition');
  const packet=buildPacket(spec,observations,expenses,claims,now().toISOString());
  if(packet.spec_hash!==spec_hash)throw new Error('packet spec hash differs from pre-purchase commitment');
  await store.finish(structuredClone(packet));return packet;
}
