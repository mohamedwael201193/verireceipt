import {describe,it,expect,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {makeBuyerFetch} from '../src/buyerTransport';import {makeBuyerPlan} from '../src/buyerPolicy';import {execute,followup} from '../src/buyerRuntime';
import {ENGINE_URL,NODE_URL} from '../src/constants';
const payer='0x'+'22'.repeat(20),p=()=>makeBuyerPlan({cik:'320193',year:2025});
const ask=(plan:ReturnType<typeof p>,paid=false):RequestInit=>({method:'POST',headers:paid?{'X-PAYMENT':'SYNTHETIC-NOT-A-SIGNATURE'}:{},body:JSON.stringify({intent:'REGULATORY_FILING_MONITOR_GENERAL',params:plan.params,max_budget_usdc:10000})});
const challenge=readFileSync(join(__dirname,'fixtures/challenge-774921.json'),'utf8').replaceAll('/v1/ask/774921','/v1/ask');
describe('bounded hosted ranked runtime (mock transport, no signature made)',()=>{
 it('permits one matching ranked challenge and paid POST, but no repeat paid POST',async()=>{
  const plan=p(),headers=vi.fn(async()=>{}),transport=vi.fn(async()=>Response.json({ok:true})),f=makeBuyerFetch(plan,payer,new AbortController().signal,headers,transport);
  await f(`${ENGINE_URL}/v1/ask`,ask(plan));await f(`${ENGINE_URL}/v1/ask`,ask(plan,true));expect(headers).toHaveBeenCalledOnce();await expect(f(`${ENGINE_URL}/v1/ask`,ask(plan,true))).rejects.toThrow('No hosted paid retries');expect(transport).toHaveBeenCalledTimes(2);
 });
 it('refuses direct miner calls, arbitrary SEC CIKs, redirects, custom destinations and request mutations',async()=>{
  const plan=p(),transport=vi.fn(async()=>Response.json({})),f=makeBuyerFetch(plan,payer,new AbortController().signal,async()=>{},transport);
  for(const u of [`${ENGINE_URL}/v1/ask/774921`,'https://data.sec.gov/submissions/CIK0001318605.json','https://example.invalid/','https://data.sec.gov/submissions/CIK0000320193.json?q=1'])await expect(f(u,ask(plan))).rejects.toThrow();
  await expect(f(`${ENGINE_URL}/v1/ask`,{...ask(plan),body:'{}'})).rejects.toThrow('binding');expect(transport).not.toHaveBeenCalled();
 });
 it('forbids any paid request in follow-up mode and refuses payment headers on evidence reads',async()=>{
  const plan=p(),transport=vi.fn(async()=>Response.json({})),f=makeBuyerFetch(plan,payer,new AbortController().signal,async()=>{},transport,true);
  await expect(f(`${ENGINE_URL}/v1/ask`,ask(plan,true))).rejects.toThrow();await expect(f(`${NODE_URL}/v1/blocks/40`,{headers:{'X-PAYMENT':'synthetic'}})).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
 });
 it('stops on 429/403 rather than retrying any source',async()=>{
  const plan=p(),transport=vi.fn(async()=>new Response('',{status:429})),f=makeBuyerFetch(plan,payer,new AbortController().signal,async()=>{},transport);
  await expect(f(`${NODE_URL}/v1/blocks/40`)).rejects.toThrow('paused');await expect(f(`${NODE_URL}/v1/blocks/40`)).rejects.toThrow('stopped');expect(transport).toHaveBeenCalledOnce();
 });
 it('durably records headers before touching an unbounded paid body',async()=>{
  const plan=p();let cancelled=false;const headers=vi.fn(async()=>{throw new Error('DB refused');});
  const transport=vi.fn(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})));
  const g=makeBuyerFetch(plan,payer,new AbortController().signal,headers,async(_u,init)=>new Headers(init?.headers).has('X-PAYMENT')?transport():Response.json({}));
  await g(`${ENGINE_URL}/v1/ask`,ask(plan));await expect(g(`${ENGINE_URL}/v1/ask`,ask(plan,true))).rejects.toThrow('DB refused');expect(cancelled).toBe(true);
 });
 it('bounds single evidence bodies and total request count',async()=>{
  const plan=p(),large=makeBuyerFetch(plan,payer,new AbortController().signal,async()=>{},async()=>new Response('a'.repeat(2000001)));
  await expect(large(`${NODE_URL}/v1/blocks/40`)).rejects.toThrow('bytes');
  const f=makeBuyerFetch(plan,payer,new AbortController().signal,async()=>{},async()=>Response.json({}));for(let n=0;n<120;n++)await f(`${NODE_URL}/v1/blocks/40`);await expect(f(`${NODE_URL}/v1/blocks/40`)).rejects.toThrow('budget');
 });
 it('cannot invoke a signer when the durable checkpoint rejects and clears scratch files',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'buyer-runtime-')),signMessage=vi.fn(async()=>{throw new Error('No signature made');});
  try{
   const result=await execute(p(),{scratchRoot:dir,signal:new AbortController().signal,beforeSign:async()=>{throw new Error('Durable authority refused');},recordHeaders:async()=>{},recordBody:async()=>{}},{payer:{address:payer,signMessage},transport:async url=>String(url).includes('/ledger/')?Response.json({available:'9999999'}):new Response(challenge,{status:402})});
   expect(signMessage).not.toHaveBeenCalled();expect(result.charge.status).toBe('not_signed');expect(result.record.outcome).toBe('HOLD');expect(readdirSync(dir)).toEqual([]);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('retains unknown exposure if the injected throw-only signer is invoked; never generates a signature',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'buyer-runtime-')),signMessage=vi.fn(async()=>{throw new Error('TEST SIGNER STOP: no signature made');}),beforeSign=vi.fn(async()=>{});
  try{
   const result=await execute(p(),{scratchRoot:dir,signal:new AbortController().signal,beforeSign,recordHeaders:async()=>{},recordBody:async()=>{}},{payer:{address:payer,signMessage},transport:async url=>String(url).includes('/ledger/')?Response.json({available:'9999999'}):new Response(challenge,{status:402})});
   expect(beforeSign).toHaveBeenCalledOnce();expect(signMessage).toHaveBeenCalledOnce();expect(result.charge.status).toBe('uncertain');expect(result.charge.amount_uusdc).toBeNull();expect(result.record.outcome).toBe('HOLD');expect(JSON.stringify(result)).not.toContain('signedMessage');
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('read-only followup verifies foreign-provider identity and epoch without signer or paid route',async()=>{
  const plan=p(),now=Math.floor(Date.now()/1000),hash='0x'+'ab'.repeat(32),result:any={plan_hash:plan.plan_hash,plan_id:plan.id,payer,charge:{status:'receipt'},receipt:{receipt_hash:hash,epoch_id:40,timestamp:now,payer,amount_uusdc:'10000',miner:'999'}};
  const transport=vi.fn(async url=>String(url).includes('/deliveries/')?Response.json({epoch_id:40,deliveries_root:'0x'+'cd'.repeat(32),proof:['0x'+'ef'.repeat(32)],delivery:{receipt_hash:hash,payer,miner_id:'999',intent:'REGULATORY_FILING_MONITOR_GENERAL',usdc:10000}}):Response.json({epoch_id:40,body:{window_from:new Date((now-1)*1000).toISOString(),window_to:new Date((now+1)*1000).toISOString()}}));
  const r:any=await followup(plan,result,new AbortController().signal,transport);expect(r.verified).toBe(true);expect(r.proof_walked).toBe(false);expect(r.settlement_finality).toBe(false);expect(transport.mock.calls.every(([u])=>!String(u).includes('/ask'))).toBe(true);
  result.receipt.miner='998';const mismatch:any=await followup(plan,result,new AbortController().signal,transport);expect(mismatch.verified).toBe(false);
 });
});
