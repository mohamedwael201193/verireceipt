import {afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {createWiredFinanceHandlers} from '../src/handlers/financeWired';
const capture=JSON.parse(readFileSync(join(__dirname,'fixtures/aave-yield/usdc-finalized-20261123.json'),'utf8'));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it('real two-leg capture replays through the handler with quorum bytes and pinned-block observation time',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(capture.fetched_at));
 const f=vi.fn(async(url:unknown,init:RequestInit)=>{
  const request=JSON.parse(String(init.body));const leg=capture.evidence.find((l:any)=>l.endpoint===url);if(!leg)throw Error('unexpected endpoint');
  const row=leg.raw.find((r:any)=>r.method===request.method);if(!row)throw Error('unexpected method');
  return new Response(row.body,{status:row.http_status});
 });vi.stubGlobal('fetch',f);
 const out=await createWiredFinanceHandlers({} as NodeJS.ProcessEnv).yield({project:'aave-v3',symbol:'USDC',chain:'ethereum'});
 expect(out.supply_apy).toBe(267);const e=JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1]);const raw=JSON.parse(e.raw_body);
 expect(e.observed_at).toBe(raw.block_timestamp);expect(raw.raw_rpc_evidence).toHaveLength(2);expect(raw.last_update_timestamp).toBe(1795470143);
 for(const leg of capture.evidence){const kept=raw.raw_rpc_evidence.find((r:any)=>r.source_url===leg.endpoint);expect(JSON.parse(kept.raw_body).find((r:any)=>r.method==='eth_call').rawText).toBe(leg.raw[2].body);}
});
