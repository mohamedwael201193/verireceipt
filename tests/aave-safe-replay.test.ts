import {afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {createWiredFinanceHandlers} from '../src/handlers/financeWired';
const capture=JSON.parse(readFileSync(join(__dirname,'fixtures/aave-yield/usdc-safe-20261125.json'),'utf8'));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
function replay(tamper?:'hash'|'timestamp'|'return'){
 vi.stubGlobal('fetch',async(url:unknown,init?:RequestInit)=>{
  const request=JSON.parse(String(init?.body));const leg=capture.results.find((l:any)=>l.endpoint===String(url));if(!leg)throw Error('captured leg unavailable');
  const row=leg.raw.find((r:any)=>r.method===request.method&&JSON.stringify(r.params)===JSON.stringify(request.params));if(!row)throw Error('uncaptured request');
  const parsed=JSON.parse(row.body);
  if(leg===capture.results[1]&&request.method==='eth_getBlockByNumber'&&tamper==='hash')parsed.result.hash='0x'+'00'.repeat(32);
  if(leg===capture.results[1]&&request.method==='eth_getBlockByNumber'&&tamper==='timestamp')parsed.result.timestamp='0x'+(parseInt(parsed.result.timestamp,16)+1).toString(16);
  if(leg===capture.results[1]&&request.method==='eth_call'&&tamper==='return')parsed.result=parsed.result.slice(0,-1)+(parsed.result.endsWith('0')?'1':'0');
  return new Response(tamper?JSON.stringify(parsed):row.body,{status:row.status});
 });
}
it('real safe-head capture replays with explicit weaker-finality disclosure and exact request pin',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(capture.fetched_at));replay();
 const out=await createWiredFinanceHandlers({}).yield({project:'aave-v3',symbol:'USDC',chain:'ethereum'});
 expect(out.supply_apy).toBe(269);expect(out.yield_components).toContain('safe-head observation, not finalized');expect(out.answer).toContain('reorganization remains possible');
 const call=vi.mocked(saveReceipt).mock.calls[0] as unknown as [unknown,string];const evidence=JSON.parse(call[1]);const raw=JSON.parse(evidence.raw_body);
 expect(raw.block_tag).toBe('safe');expect(raw.finality).toContain('not finalized');expect(raw.block_hash).toBe(capture.results[0].block_hash);expect(raw.rpc_quorum).toBe(2);
 for(const leg of capture.results){const kept=raw.raw_rpc_evidence.find((r:any)=>r.source_url===leg.endpoint);expect(JSON.parse(kept.raw_body).map((r:any)=>r.params)).toEqual(leg.raw.map((r:any)=>r.params));expect(JSON.parse(kept.raw_body).map((r:any)=>r.rawText)).toEqual(leg.raw.map((r:any)=>r.body));}
});
it.each(['hash','timestamp','return'] as const)('safe-head %s disagreement refuses without persistence',async tamper=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(capture.fetched_at));replay(tamper);
 await expect(createWiredFinanceHandlers({}).yield({project:'aave-v3',symbol:'USDC',chain:'ethereum'})).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});expect(saveReceipt).not.toHaveBeenCalled();
});
it('safe-head does not widen the15minute freshness limit',async()=>{
 vi.useFakeTimers();const blockTime=parseInt(capture.results[0].block_timestamp,16)*1000;vi.setSystemTime(blockTime+900001);replay();
 await expect(createWiredFinanceHandlers({}).yield({project:'aave-v3',symbol:'USDC',chain:'ethereum'})).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});expect(saveReceipt).not.toHaveBeenCalled();
});
