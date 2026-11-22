import { describe, expect, it } from 'vitest';
import { assertDedicatedBuyer, buyerInput, buyerPlanHash, validateBuyerPlan } from '../../src/buyer/contracts';
import { BUYER_POLICY_HASH, hostedBuyerPolicy, makeBuyerPlan } from '../src/buyerPolicy';
import { policyObjectHash } from '../src/gatePolicy';
const now=new Date('2026-11-22T18:52:02Z'),input={cik:'320193',year:2025};
describe('narrow sponsored filing buyer contracts',()=>{
 it('freezes an exact input, fixed criterion, quote and ranked testnet task before payment',()=>{
  const p=makeBuyerPlan(input,now);expect(()=>validateBuyerPlan(p,now)).not.toThrow();expect(p.minimum_count).toBe(3);expect(p.form).toBe('10-Q');expect(p.call_uusdc).toBe('10000');
  expect(p.policy_hash).toBe(BUYER_POLICY_HASH);expect(p.task_hash).toBe(policyObjectHash(hostedBuyerPolicy().tasks[0]));
 });
 it.each([{...input,form:'8-K'},{...input,minimum_count:1},{...input,key:'secret'},{...input,network:'mainnet'},{...input,miner:'123'},{...input,year:2026},{...input,cik:'0320193'},{...input,year:1993}])('refuses unsupported or widened visitor inputs %j',value=>expect(()=>buyerInput(value,now)).toThrow());
 it.each([{policy_hash:'0'.repeat(64)},{task_hash:'1'.repeat(64)},{rule:{op:'>=',value:3,units:'filings',label:'A misleading easier criterion'}}])('rejects a self-consistent hash with unrelated policy/task/rule identity %j',extra=>{
  const p={...makeBuyerPlan(input,now),...extra} as ReturnType<typeof makeBuyerPlan>;p.plan_hash=buyerPlanHash(p);expect(()=>validateBuyerPlan(p,now)).toThrow();
 });
 it('does not expose a mutable policy singleton',()=>{
  const p=hostedBuyerPolicy();p.tasks[0].rule.value=0;expect(hostedBuyerPolicy().tasks[0].rule.value).toBe(3);expect(policyObjectHash(hostedBuyerPolicy())).toBe(BUYER_POLICY_HASH);
 });
 it('rejects altered binding, terms, expired plans and invalid plan IDs',()=>{
  const p=makeBuyerPlan(input,now);
  for(const extra of [{network:'eip155:1'},{call_uusdc:'20000'},{minimum_count:0},{id:'../anything'},{params:{...p.params,entity:'different issuer'}}]){
   const changed={...p,...extra} as typeof p;changed.plan_hash=buyerPlanHash(changed);expect(()=>validateBuyerPlan(changed,now)).toThrow();
  }
  expect(()=>validateBuyerPlan(p,new Date(now.getTime()+601000))).toThrow();
 });
 it('requires complete nonempty explicit exclusion sets before accepting a sponsor',()=>{
  for(const exclusions of [undefined,{cli:[],research:[]},{cli:['0x'+'33'.repeat(20)],research:[]}])expect(()=>assertDedicatedBuyer('0x'+'22'.repeat(20),exclusions as any)).toThrow();
 });
 it('refuses existing CLI/research owner wallets for the dedicated sponsor role',()=>{
  expect(()=>assertDedicatedBuyer('0xf76e6b0920e9332ff4410f6dd53f01722abc71a3',{cli:['0x'+'33'.repeat(20)],research:['0x'+'44'.repeat(20)]})).toThrow();
  expect(()=>assertDedicatedBuyer('0x'+'11'.repeat(20),{cli:['0x'+'11'.repeat(20)],research:['0x'+'44'.repeat(20)]})).toThrow();
  expect(assertDedicatedBuyer('0x'+'22'.repeat(20),{cli:['0x'+'33'.repeat(20)],research:['0x'+'44'.repeat(20)]})).toBe('0x'+'22'.repeat(20));
 });
});
