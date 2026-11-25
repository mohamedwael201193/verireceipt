// All records here are explicit UNIT FIXTURES, never live evidence or demos.
import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {buildPacket,decimal,expenseSummary,factHash,hash,replayPacket,validateSpec,type ThesisSpec,type Observation,type Expense,type Claim} from '../src/researchDesk.js';
const at='2026-11-23T01:00:00.000Z';
function fixture(){
 const spec:ThesisSpec={version:'research-desk-v1',network:'eip155:11155111',template:'onchain-valuation',question:'UNIT FIXTURE: compare implied FDV to analyst threshold',frozen_at:at,facts:[{id:'price',intent:'CRYPTO_PRICE_USD',params:{symbol:'UNIT'},field:'price_usd',unit:'USD/token',max_age_seconds:300},{id:'supply',intent:'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL',params:{token:'UNIT on ethereum'},field:'total_supply',unit:'token',max_age_seconds:300}],assumptions:[{id:'threshold',value:'200',unit:'USD',rationale:'UNIT FIXTURE analyst threshold'}],calculations:[{id:'implied_fdv',op:'multiply',left:'price',right:'supply',unit:'USD'}],budget_uusdc:'30000',max_call_uusdc:'10000',max_escalations:1};
 const observations:Observation[]=spec.facts.map((f,i)=>{const value=i?'100':'1.5';const layer={status:'passed' as const,checks:[{name:'UNIT FIXTURE',ok:true,detail:'not live verification'}]};const raw=JSON.stringify({fixture:true,value});return {fact_id:f.id,request_hash:factHash(f),value,unit:f.unit,as_of:at,acquired_at:at,receipt_hash:String(i+1).repeat(64),signal_hash:'0x'+'a'.repeat(64),serving_registration:'UNIT_FIXTURE_ONLY',supply:'external',acquisition_cost_uusdc:'10000',integrity_level:'L1_SIGNAL_ONLY',reuse:'fresh-purchase',layers:{schema:layer,receipt:layer,semantics:layer,primary:layer},source:{url:'https://example.invalid/unit-fixture',content_sha256:createHash('sha256').update(raw).digest('hex'),raw_text:raw,observed_at:at,scope_hash:factHash(f),value,parser:'unit-fixture-only'}};});
 const expenses:Expense[]=observations.map((o,i)=>({fact_id:o.fact_id,attempt:0,nonce:`unit-${i}`,reserved_uusdc:'10000',reported_charge_uusdc:'10000',settled_uusdc:null,status:'receipted-unsettled',receipt_hash:o.receipt_hash,useful:true}));
 const claims:Claim[]=[{id:'valuation_test',fact_refs:['price','supply'],assumption_refs:['threshold'],calculation_ref:'implied_fdv',predicate:{left:'implied_fdv',op:'<',right:'threshold'}}];
 return {spec,observations,expenses,claims};
}
function packet(){const f=fixture();return buildPacket(f.spec,f.observations,f.expenses,f.claims,at);}
describe('Research Desk pure packet core, unit fixtures only',()=>{
 it('template G equality claim evaluates end to end through buildPacket',async()=>{
  const {researchTemplate}=await import('../src/researchTemplates.js');
  const {spec,claims}=researchTemplate('G',at,'291');
  const makeObs=(balance:string):Observation[]=>{const values:Record<string,string>={holders:'432070',liquidity:'10496122.08',supply:'1000000000',contract_balance:balance};return spec.facts.map((f,i)=>{const value=values[f.id];const layer={status:'passed' as const,checks:[{name:'UNIT FIXTURE',ok:true,detail:'not live verification'}]};const raw=JSON.stringify({fixture:true,value});return {fact_id:f.id,request_hash:factHash(f),value,unit:f.unit,as_of:at,acquired_at:at,receipt_hash:String(i+1).repeat(64),signal_hash:'0x'+'a'.repeat(64),serving_registration:'UNIT_FIXTURE_ONLY',supply:'external',acquisition_cost_uusdc:'10000',integrity_level:'L1_SIGNAL_ONLY',reuse:'fresh-purchase',layers:{schema:layer,receipt:layer,semantics:layer,primary:layer},source:{url:'https://example.invalid/unit-fixture',content_sha256:createHash('sha256').update(raw).digest('hex'),raw_text:raw,observed_at:at,scope_hash:factHash(f),value,parser:'unit-fixture-only'}};});};
  const observations=makeObs('0');
  const expenses:Expense[]=observations.map((o,i)=>({fact_id:o.fact_id,attempt:0,nonce:`unit-g-${i}`,reserved_uusdc:'10000',reported_charge_uusdc:'10000',settled_uusdc:null,status:'receipted-unsettled',receipt_hash:o.receipt_hash,useful:true}));
  const p=buildPacket(spec,observations,expenses,claims,at);
  expect(p.outcome).toBe('READY');
  expect(p.claim_results.balance_matches_declared).toBe('SUPPORTED');
  expect(p.claim_results.holders_above_floor).toBe('SUPPORTED');
  expect(p.claim_results.liquidity_above_floor).toBe('SUPPORTED');
  const p2=buildPacket(spec,makeObs('0.000000001'),expenses,claims,at);
  expect(p2.claim_results.balance_matches_declared).toBe('NOT_SUPPORTED');
 });
 it('exact calculation and supported threshold',()=>{const p=packet();expect(p.outcome).toBe('READY');expect(p.calculations.implied_fdv).toEqual({numerator:'150',denominator:'1',unit:'USD'});expect(p.claim_results.valuation_test).toBe('SUPPORTED');expect(replayPacket(p).ok).toBe(true);});
 it('changed source invalidates replay',()=>{const p=packet();p.observations[0].source!.raw_text+='x';expect(replayPacket(p).ok).toBe(false);expect(buildPacket(p.spec,p.observations,p.expenses,p.claims,at).outcome).toBe('HOLD');});
 it('unavailable observation does not invent zero',()=>{const f=fixture();f.observations[0].value=null;const p=buildPacket(f.spec,f.observations,f.expenses,f.claims,at);expect(p.outcome).toBe('HOLD');expect(p.calculations.implied_fdv).toBeUndefined();expect(p.claim_results.valuation_test).toBe('UNKNOWN');});
 it('invented assertion is NOT_SUPPORTED without changing evidence',()=>{const f=fixture();f.spec.assumptions[0].value='100';const p=buildPacket(f.spec,f.observations,f.expenses,f.claims,at);expect(p.outcome).toBe('READY');expect(p.claim_results.valuation_test).toBe('NOT_SUPPORTED');});
 it('revised assumption keeps receipts and zero incremental charges',()=>{const old=packet();const revised=structuredClone(old.spec);revised.assumptions[0].value='100';const obs=old.observations.map(o=>({...o,reuse:'fresh-receipt-reuse' as const}));const p=buildPacket(revised,obs,[],old.claims,at);expect(p.spec_hash).not.toBe(old.spec_hash);expect(p.observations.map(o=>o.signal_hash)).toEqual(old.observations.map(o=>o.signal_hash));expect(p.accounting.worst_case_uusdc).toBe('0');expect(p.claim_results.valuation_test).toBe('NOT_SUPPORTED');});
 it('roundtrips exact decimals beyond safe IEEE integer',()=>expect(decimal('9007199254740993.01')).toEqual({n:900719925474099301n,d:100n}));
 it('refuses exponent and malformed decimals',()=>{for(const x of ['1e3','NaN','Infinity','01','-0x2'])expect(()=>decimal(x)).toThrow();});
 it('does not label implied FDV circulating market cap',()=>{const f=fixture();f.spec.calculations[0].id='market_cap';expect(()=>validateSpec(f.spec)).toThrow();});
 it('rejects mainnet',()=>{const f=fixture();(f.spec as any).network='eip155:1';expect(()=>validateSpec(f.spec)).toThrow();});
 it('rejects non-enum macro indicator before purchase',()=>{const f=fixture();f.spec.facts.push({id:'inflation',intent:'MACRO_ECONOMIC_INDICATOR_GENERAL',params:{indicator:'inflation',country:'EG'},field:'rate_pct',unit:'percent',max_age_seconds:86400});expect(()=>validateSpec(f.spec)).toThrow('unemployment');});
 it('rejects pretending liquidity is slippage',()=>{const f=fixture();f.spec.facts.push({id:'depth',intent:'LIQUIDITY_DEPTH_VERIFY_GENERAL',params:{pool:'unit',chain:'ethereum'},field:'slippage',unit:'percent',max_age_seconds:60});expect(()=>validateSpec(f.spec)).toThrow();});
 it('requires explicit total supply chain',()=>{const f=fixture();f.spec.facts[1].params.token='UNIT';expect(()=>validateSpec(f.spec)).toThrow('chain');});
 it('stale receipt is HOLD',()=>{const f=fixture();const p=buildPacket(f.spec,f.observations,f.expenses,f.claims,'2026-11-23T01:06:00Z');expect(p.outcome).toBe('HOLD');});
 it('wrong scope is HOLD',()=>{const f=fixture();f.observations[0].request_hash='b'.repeat(64);expect(buildPacket(f.spec,f.observations,f.expenses,f.claims,at).outcome).toBe('HOLD');});
 it('signal-only does not imply primary verification',()=>{const f=fixture();f.observations[0].layers.primary.status='unavailable';expect(buildPacket(f.spec,f.observations,f.expenses,f.claims,at).outcome).toBe('HOLD');});
 it('unsettled reported charge is not called settled',()=>{const p=packet();expect(p.accounting.settled_uusdc).toBe('0');expect(p.accounting.reported_charge_uusdc).toBe('20000');expect(p.accounting.worst_case_uusdc).toBe('20000');});
 it('unknown signature exposure counts fully as wasted and uncertain',()=>{const f=fixture();const e:Expense={...f.expenses[0],status:'reserved-uncertain',receipt_hash:null,reported_charge_uusdc:null,useful:false};const a=expenseSummary([e]);expect(a.uncertain_uusdc).toBe('10000');expect(a.wasted_uusdc).toBe('10000');expect(a.worst_case_uusdc).toBe('10000');});
 it('unknown signed outcome cannot escalate',()=>{const f=fixture();f.expenses[0]={...f.expenses[0],status:'reserved-uncertain',receipt_hash:null,reported_charge_uusdc:null,useful:false};f.expenses.push({...f.expenses[1],fact_id:'price',attempt:1,nonce:'unit-escalation'});expect(()=>buildPacket(f.spec,f.observations,f.expenses,f.claims,at)).toThrow('known failed');});
 it('duplicate nonce cannot undercount expense',()=>{const f=fixture();f.expenses[1].nonce=f.expenses[0].nonce;expect(()=>expenseSummary(f.expenses)).toThrow('duplicate');});
 it('budget includes all unsettled exposure',()=>{const f=fixture();f.spec.budget_uusdc='10000';expect(buildPacket(f.spec,f.observations,f.expenses,f.claims,at).outcome).toBe('HOLD');});
 it('invented claim reference is refused',()=>{const f=fixture();f.claims[0].fact_refs.push('made_up');expect(()=>buildPacket(f.spec,f.observations,f.expenses,f.claims,at)).toThrow('invented');});
 it('tampered calculation is rejected by replay',()=>{const p=packet();p.calculations.implied_fdv.numerator='1';expect(replayPacket(p).ok).toBe(false);});
 it('canonical hash is stable across property order',()=>expect(hash({b:2,a:1})).toBe(hash({a:1,b:2})));
});

describe('Research Desk orchestration with explicitly injected unit adapters',()=>{
 it('freezes before buying and writes packet after both receipts',async()=>{
  const {runResearchDesk}=await import('../src/researchDeskRunner.js');const f=fixture();const events:string[]=[];
  const p=await runResearchDesk(f.spec,f.claims,{buy:async fact=>{events.push('buy');const i=f.spec.facts.findIndex(x=>x.id===fact.id);return {observation:f.observations[i],expense:f.expenses[i],failure:null};},revalidate:async()=>null},{freeze:async()=>{events.push('freeze');},append:async()=>{events.push('append');},finish:async()=>{events.push('finish');}},[],()=>new Date(at));
  expect(events).toEqual(['freeze','buy','append','buy','append','finish']);expect(p.outcome).toBe('READY');
 });
 it('refuses invalid predicate before any adapter call',async()=>{
  const {runResearchDesk}=await import('../src/researchDeskRunner.js');const f=fixture();f.claims[0].predicate!.right='made_up';let bought=false;
  await expect(runResearchDesk(f.spec,f.claims,{buy:async()=>{bought=true;throw new Error('should not run');},revalidate:async()=>null},{freeze:async()=>{},append:async()=>{},finish:async()=>{}},[],()=>new Date(at))).rejects.toThrow();expect(bought).toBe(false);
 });
 it('never retries thrown adapter uncertainty',async()=>{
  const {runResearchDesk}=await import('../src/researchDeskRunner.js');const f=fixture();let calls=0;
  await expect(runResearchDesk(f.spec,f.claims,{buy:async()=>{calls++;throw new Error('unknown signed outcome');},revalidate:async()=>null},{freeze:async()=>{},append:async()=>{},finish:async()=>{}},[],()=>new Date(at))).rejects.toThrow('unknown');expect(calls).toBe(1);
 });
 it('uses cache only after adapter revalidation, with zero incremental expense',async()=>{
  const {runResearchDesk}=await import('../src/researchDeskRunner.js');const f=fixture();let calls=0;
  const p=await runResearchDesk(f.spec,f.claims,{buy:async()=>{throw new Error('must not buy');},revalidate:async o=>{calls++;return o;}},{freeze:async()=>{},append:async()=>{},finish:async()=>{}},f.observations,()=>new Date(at));
  expect(calls).toBe(2);expect(p.accounting.worst_case_uusdc).toBe('0');expect(p.metrics.reused_acquisition_cost_uusdc).toBe('20000');expect(p.observations.every(o=>o.reuse==='fresh-receipt-reuse')).toBe(true);
 });
});

describe('reviewer regression pins',()=>{
 it('store cannot mutate the frozen spec or desynchronize adapter hash',async()=>{
  const {runResearchDesk}=await import('../src/researchDeskRunner.js');const f=fixture();const original=hash(f.spec);const seen:string[]=[];
  const p=await runResearchDesk(f.spec,f.claims,{buy:async(fact,context)=>{seen.push(context.spec_hash);const i=f.spec.facts.findIndex(x=>x.id===fact.id);return {observation:f.observations[i],expense:f.expenses[i],failure:null};},revalidate:async()=>null},{freeze:async(spec)=>{spec.assumptions[0].value='1';},append:async()=>{},finish:async()=>{}},[],()=>new Date(at));
  expect(seen).toEqual([original,original]);expect(p.spec_hash).toBe(original);expect(p.spec.assumptions[0].value).toBe('200');
 });
 it('calculation claim is UNKNOWN when division is undefined',()=>{
  const f=fixture();f.spec.assumptions.push({id:'zero',value:'0',unit:'USD',rationale:'UNIT zero denominator'});f.spec.calculations.push({id:'ratio',op:'divide',left:'implied_fdv',right:'zero',unit:'ratio'});f.claims=[{id:'ratio_claim',fact_refs:['price','supply'],assumption_refs:['zero'],calculation_ref:'ratio'}];
  const p=buildPacket(f.spec,f.observations,f.expenses,f.claims,at);expect(p.outcome).toBe('HOLD');expect(p.claim_results.ratio_claim).toBe('UNKNOWN');
 });
});

describe('immediate acquisition validation',()=>{
 it.each(['negative','zero','too-large','duplicate-nonce','missing-settlement','wrong-fact','wrong-receipt','invalid-useful','invalid-status'])('refuses %s before append or a subsequent buy',async(kind)=>{
  const {runResearchDesk}=await import('../src/researchDeskRunner.js');const f=fixture();let buys=0,appends=0;
  const adapter={buy:async(fact:any)=>{const i=f.spec.facts.findIndex(x=>x.id===fact.id);buys++;const expense=structuredClone(f.expenses[i]);const observation=structuredClone(f.observations[i]);
   if(kind==='negative')expense.reserved_uusdc='-1';if(kind==='zero')expense.reserved_uusdc='0';if(kind==='too-large')expense.reserved_uusdc='10001';if(kind==='duplicate-nonce')expense.nonce='same-unit-nonce';if(kind==='missing-settlement')expense.status='settled';if(kind==='wrong-fact')expense.fact_id='wrong';if(kind==='wrong-receipt')observation.receipt_hash='f'.repeat(64);if(kind==='invalid-useful')(expense as any).useful='yes';if(kind==='invalid-status')(expense as any).status='invented';
   return {observation,expense,failure:null};},revalidate:async()=>null};
  await expect(runResearchDesk(f.spec,f.claims,adapter,{freeze:async()=>{},append:async()=>{appends++;},finish:async()=>{}},[],()=>new Date(at))).rejects.toThrow();
  expect(buys).toBe(kind==='duplicate-nonce'?2:1);expect(appends).toBe(kind==='duplicate-nonce'?1:0);
 });
});


it('raw numeric diagnostics cannot clear HOLD or feed calculations',()=>{const f=fixture();const o=f.observations[0];const primary={...o.source!,value:'1.501'};const diagnostic={fact_id:'price',label:'raw-value observation' as const,status:'REJECTED_SHAPED_MISMATCH' as const,request_hash:o.request_hash,provider_value:'1.501',shaped_value:'1.5',unit:o.unit,signal_hash:o.signal_hash,receipt_hash:o.receipt_hash,source:primary,failed_check:{name:'engine value equals provider answer' as const,ok:false as const,detail:'UNIT mismatch'},usable_for_calculations:false as const};f.expenses[0].useful=false;const p=buildPacket(f.spec,[f.observations[1]],f.expenses,f.claims,at,[diagnostic]);expect(p.outcome).toBe('HOLD');expect(p.calculations.implied_fdv).toBeUndefined();expect(p.claim_results.valuation_test).toBe('UNKNOWN');expect(p.rejected_raw_observations?.[0].failed_check.ok).toBe(false);expect(replayPacket(p).ok).toBe(false);});
