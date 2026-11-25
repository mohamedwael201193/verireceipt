import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {geckoPoolLiquiditySource,resetGeckoPoolBudgetForTests} from '../src/handlers/geckoPoolLiquidity';
import {createWiredFinanceHandlers,DEXSCREENER_POOLS,GECKOTERMINAL_APPROVAL} from '../src/handlers/financeWired';
const raw=readFileSync('tests/fixtures/gecko-pool-bound.json','utf8');
const address=JSON.parse(raw).data.attributes.address;
const query={pool:address,chain:'ethereum'};
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();resetGeckoPoolBudgetForTests();});
it('real exact-pool source returns numeric reserves and preserves exact raw bytes',async()=>{
 const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);
 const s=geckoPoolLiquiditySource([],GECKOTERMINAL_APPROVAL);const r=await s.read(query,new AbortController().signal);
 expect(r.value.liquidityUsd).toBe(68820142.6838);expect(typeof r.value.liquidityUsd).toBe('number');expect(JSON.parse(r.rawBody).source_raw_body).toBe(raw);expect(r.rawBody).toContain('retrieval time');expect(r.observedAt).toBe(r.fetchedAt);
 expect(String(f.mock.calls[0][0])).toBe('https://api.geckoterminal.com/api/v2/networks/eth/pools/'+address);
});
it.each(['id','address','type','network','negative','huge','null','nan'])('rejects mutated %s without claiming observation',async mode=>{
 const j=JSON.parse(raw);if(mode==='id')j.data.id+='0';if(mode==='address')j.data.attributes.address='0x'+'1'.repeat(40);if(mode==='type')j.data.type='token';if(mode==='network')j.data.id='base_'+address;if(mode==='negative')j.data.attributes.reserve_in_usd='-1';if(mode==='huge')j.data.attributes.reserve_in_usd='1000000000001';if(mode==='null')j.data.attributes.reserve_in_usd=null;if(mode==='nan')j.data.attributes.reserve_in_usd='NaN';
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(j)));await expect(geckoPoolLiquiditySource([],GECKOTERMINAL_APPROVAL).read(query,new AbortController().signal)).rejects.toThrow();
});
it('independent fallback after primary403 makes one call per provider and no retry',async()=>{
 const f=vi.fn(async(u:unknown)=>String(u).includes('api.geckoterminal.com')?new Response(raw):new Response('blocked',{status:403}));vi.stubGlobal('fetch',f);
 const out=await createWiredFinanceHandlers({}).liquidity(query);
 expect(out.liquidity_usd).toBe(68820142.6838);expect(out.source).toContain('GeckoTerminal');expect(out.answer).toContain('not executable depth');expect(f).toHaveBeenCalledTimes(2);
 const evidence=JSON.parse(String(vi.mocked(saveReceipt).mock.calls[0][1]));expect(evidence.provider).toContain('GeckoTerminal');expect(evidence.raw_body).toContain(JSON.stringify(raw).slice(1,-1));expect(evidence.prior_sources).toEqual(['DEX Screener named pool reserve liquidity:unavailable']);
});
it('primary success stops fallback and never averages conflicting source values',async()=>{
 const primary=readFileSync('tests/fixtures/dexscreener-bound-pool.json','utf8');const f=vi.fn(async(u:unknown)=>new Response(String(u).includes('api.geckoterminal.com')?raw:primary));vi.stubGlobal('fetch',f);
 const out=await createWiredFinanceHandlers({}).liquidity(query);expect(out.liquidity_usd).toBe(JSON.parse(primary).pairs[0].liquidity.usd);expect(f).toHaveBeenCalledTimes(1);expect(out.source).toContain('DEX Screener');expect(out.source).not.toContain('GeckoTerminal');
});
it('fallback403 stops with no alternate route or receipt',async()=>{
 const f=vi.fn(async()=>new Response('blocked',{status:403}));vi.stubGlobal('fetch',f);
 await expect(createWiredFinanceHandlers({}).liquidity(query)).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});expect(f).toHaveBeenCalledTimes(2);expect(saveReceipt).not.toHaveBeenCalled();
});
it('ambiguous name never selects a pool in either provider',async()=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);await expect(geckoPoolLiquiditySource(DEXSCREENER_POOLS,GECKOTERMINAL_APPROVAL).read({pool:'UNKNOWN/USDC',chain:'ethereum'},new AbortController().signal)).rejects.toThrow();expect(f).not.toHaveBeenCalled();
});

it.each([68820142,'6.882e7',' 68820142.6838 '])('rejects noncanonical reserve type/format %s',async reserve=>{
 const j=JSON.parse(raw);j.data.attributes.reserve_in_usd=reserve;vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(j)));
 await expect(geckoPoolLiquiditySource([],GECKOTERMINAL_APPROVAL).read(query,new AbortController().signal)).rejects.toThrow('invalid reserve');
});
it('spends at most25source starts per minute and the26th performs no fetch',async()=>{
 resetGeckoPoolBudgetForTests();const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);const s=geckoPoolLiquiditySource([],GECKOTERMINAL_APPROVAL);
 for(let i=0;i<25;i++)await s.read(query,new AbortController().signal);
 await expect(s.read(query,new AbortController().signal)).rejects.toThrow('start budget');expect(f).toHaveBeenCalledTimes(25);
});
