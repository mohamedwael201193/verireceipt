import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { escrowAskAuto } from '../src/client';
import { runGate, spendLedgerFromFiles } from '../src/gate';
import { policyObjectHash, type GatePolicy } from '../src/gatePolicy';
const challenge=readFileSync(join(__dirname,'fixtures/challenge-774921.json'),'utf8').replaceAll('/v1/ask/774921','/v1/ask');
const payer=()=>({address:'0x'+'11'.repeat(20),signMessage:vi.fn(async()=>{throw new Error('TEST SIGNER STOP: no signature made');})});
const transport=()=>vi.fn(async(url:RequestInfo|URL)=>String(url).includes('/ledger/account/')?Response.json({available:'1000000'}):new Response(challenge,{status:402}));
const body={intent:'TVL_LOOKUP_GENERAL',params:{protocol:'aave-v3'}};
describe('awaited durable pre-sign checkpoint',()=>{
 it('does not reach a signer when an async durable guard refuses',async()=>{
  const p=payer(),f=transport();
  await expect(escrowAskAuto(body,p,{f,spentTodayUusdc:0n,dailyCapUusdc:2_000_000n,onBeforeSign:async()=>{await Promise.resolve();throw new Error('durable write refused');}})).rejects.toThrow('durable write refused');
  expect(p.signMessage).not.toHaveBeenCalled();
 });
 it('waits for durable commit before even invoking the signer',async()=>{
  const p=payer(),f=transport();let ready!:()=>void;const committed=new Promise<void>(resolve=>{ready=resolve;});const guard=vi.fn(()=>committed);
  const pending=escrowAskAuto(body,p,{f,spentTodayUusdc:0n,dailyCapUusdc:2_000_000n,onBeforeSign:guard});
  await vi.waitFor(()=>expect(guard).toHaveBeenCalledOnce());expect(p.signMessage).not.toHaveBeenCalled();ready();
  await expect(pending).rejects.toThrow('TEST SIGNER STOP');expect(p.signMessage).toHaveBeenCalledOnce();
 });
 it('Gate cannot bypass an external durable guard, and retains its conservative local reservation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gate-durable-'));
  try{
   const policy:GatePolicy={version:'gate-policy-v1',committed_at:'2026-11-22T18:47:11Z',network:'eip155:11155111',rail:'escrow',routing:'auto',max_call_uusdc:'10000',note:'synthetic',tasks:[{id:'synthetic',mission:'M13',title:'synthetic',intent:body.intent,value_field:'tvl_usd',fixed_params:body.params,accepts_params:[],rule:{op:'>=',value:1,units:'USD',label:'synthetic'}}]};
   const p=payer(),guard=vi.fn(async()=>{throw new Error('durable guard failed');});
   const r=await runGate('synthetic',p,{policy,policyHash:policyObjectHash(policy),ledgerFile:join(dir,'gate.jsonl'),spend:spendLedgerFromFiles({reservationsFile:join(dir,'reserved.jsonl'),lockFile:join(dir,'lock'),runLedgerFiles:[]}),f:transport(),durableBeforeSign:guard} as any);
   expect(guard).toHaveBeenCalledOnce();expect(p.signMessage).not.toHaveBeenCalled();expect(r.outcome).toBe('HOLD');expect(r.purchase.worst_case_uusdc).toBe('10000');
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
});
