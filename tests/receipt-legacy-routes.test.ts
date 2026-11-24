import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleCrossChainState} from '../src/handlers/crossChainState';
import {handleTransactionRisk} from '../src/handlers/transactionRisk';
const capture=JSON.parse(readFileSync('tests/fixtures/receipt-legacy/ethereum-providers.json','utf8'));
const first=JSON.parse(capture.providers[0].body).result;
const sdn=readFileSync('tests/fixtures/transaction-risk/sdn-excerpt.csv','utf8');
function transport(reverse=false):void {
 vi.stubGlobal('fetch',async(u:unknown,o:any)=>{
  const url=String(u);
  if(url.includes('ofac.treas.gov'))return new Response(sdn);
  const q=JSON.parse(o.body);
  if(q.method==='eth_getTransactionReceipt'){
   const i=capture.providers.findIndex((p:any)=>p.url===url);
   if(i<0)return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:null}));
   return new Response(capture.providers[reverse?2-i:i].body);
  }
  // Synthetic transaction wrapper uses captured receipt identities; value is a
  // synthetic zero control, not a claim about the historical transaction value.
  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{hash:capture.tx,from:first.from,to:first.to,value:'0x0',blockNumber:first.blockNumber}}));
 });
}
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
describe('legacy representation through both shipped handlers',()=>{
 it.each([false,true])('risk hash case and selected raw shape, reverse=%s',async reverse=>{
  transport(reverse);
  const out=await handleTransactionRisk({transaction:capture.tx.toUpperCase()});
  expect(out.risk_score).toBe(0.1); // synthetic zero value and zero captured logs
  expect((out.signals as string[]).join(' ')).not.toContain('TX_REVERTED');
  const evidence=JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1] as string);
  expect(evidence.reverted).toBe(false);
  const expected=capture.providers.map((p:any)=>p.body);
  expect(Object.values(evidence.raw_bodies.receipt)).toEqual(reverse?expected.reverse():expected);
 });
 it('cross-chain real captured ethereum success plus synthetic base absence is complete',async()=>{
  transport();const out=await handleCrossChainState({reference:capture.tx,chains:'ethereum,base'});
  expect(out.complete).toBe(true);expect(out.consistent).toBe(false);
  expect((out.per_chain as any[])[0]).toMatchObject({chain:'ethereum',found:true,status:1});
  const evidence=JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1] as string);
  for(const p of capture.providers)expect(evidence.raw_bodies['ethereum:attempt1:'+p.url]).toBe(p.body);
 });
});
