import {afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {dexScreenerLiquiditySource} from '../src/handlers/marketSourceAdapters';
import {DEXSCREENER_POOLS,DEXSCREENER_APPROVAL} from '../src/handlers/financeWired';
const raw=readFileSync(join(__dirname,'fixtures/liquidity-address/ethereum-usdc-weth.json'),'utf8');
const binding=DEXSCREENER_POOLS[0];
afterEach(()=>vi.unstubAllGlobals());
it('known pool exact address is equivalent to its verified label, preserving raw source and query identity',async()=>{
 const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);
 const s=dexScreenerLiquiditySource(DEXSCREENER_POOLS,DEXSCREENER_APPROVAL);
 const out=await s.read({pool:binding.address,chain:'ethereum'},new AbortController().signal);
 expect(out.value.liquidityUsd).toBe(JSON.parse(raw).pairs[0].liquidity.usd);
 expect(out.identity).toBe(JSON.stringify(['ethereum',binding.address.toLowerCase()]));
 expect(JSON.parse(out.rawBody).source_raw_body).toBe(raw);
 expect(f.mock.calls).toHaveLength(1);
});
it('refuses unsupported chain and malformed address before network',async()=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const s=dexScreenerLiquiditySource(DEXSCREENER_POOLS,DEXSCREENER_APPROVAL);
 await expect(s.read({pool:binding.address,chain:'unsupported'},new AbortController().signal)).rejects.toThrow('binding');
 await expect(s.read({pool:binding.address.slice(0,-1),chain:'ethereum'},new AbortController().signal)).rejects.toThrow('binding');expect(f).not.toHaveBeenCalled();
});
it('refuses wrong-address response even when name/address request resolves',async()=>{
 const changed=JSON.parse(raw);changed.pairs[0].pairAddress='0x'+'1'.repeat(40);
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(changed)));
 const s=dexScreenerLiquiditySource(DEXSCREENER_POOLS,DEXSCREENER_APPROVAL);
 await expect(s.read({pool:binding.address,chain:'ethereum'},new AbortController().signal)).rejects.toThrow('identity');
});

it('supported alternative chain and exact near-match address require exact returned identity, not a name binding',async()=>{
 const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);const s=dexScreenerLiquiditySource(DEXSCREENER_POOLS,DEXSCREENER_APPROVAL);
 await expect(s.read({pool:binding.address,chain:'arbitrum'},new AbortController().signal)).rejects.toThrow('identity');
 await expect(s.read({pool:binding.address.slice(0,-1)+'1',chain:'ethereum'},new AbortController().signal)).rejects.toThrow('identity');
 expect(f).toHaveBeenCalledTimes(2);
});
