import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {assetSupply} from '../src/handlers/tokenAssetSupply';
const raw=(n:string)=>readFileSync(join(__dirname,'fixtures/token-aggregate',n.toLowerCase()+'.json'),'utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it.each(['USDC','USDT','DAI'])('validates exact captured %s asset, timestamp, contract binding and terms-risk fields',async(symbol)=>{
 const text=raw(symbol),j=JSON.parse(text);vi.useFakeTimers();vi.setSystemTime(new Date(j.last_updated));vi.stubGlobal('fetch',async()=>new Response(text));
 const out=await assetSupply(symbol);expect(out.total_supply).toBe(j.market_data.total_supply);expect(out.raw_body).toBe(text);expect(out.source_updated_at).toBe(j.last_updated);expect(out.terms.commercial_use_confirmed).toBe(false);expect(out.terms.redistribution_confirmed).toBe(false);expect(out.scope).toContain('not an independently summed');expect(out.terms.source_reference).toBe('owner-risk-acceptance-2026-11-23');expect(out.terms.accepted_at).toBe('2026-11-22T22:27:23.000Z');expect(Object.keys(out.terms)).not.toContain(['source','message','id'].join('_'));
});
it('rejects wrong identity, symbol, platform, null/invalid supply and stale provider time',async()=>{
 const j=JSON.parse(raw('USDC'));vi.useFakeTimers();vi.setSystemTime(new Date(j.last_updated));
 for(const changed of [{...j,id:'other'},{...j,symbol:'other'},{...j,platforms:{ethereum:'0x'+'1'.repeat(40)}},{...j,market_data:{total_supply:null}},{...j,market_data:{total_supply:-1}},{...j,last_updated:'2000-01-01T00:00:00Z'}]){
  vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(changed)));await expect(assetSupply('USDC')).rejects.toThrow();
 }
});
it.each([403,429])('does not retry or bypass HTTP %s',async(status)=>{
 const f=vi.fn(async()=>new Response('blocked',{status}));vi.stubGlobal('fetch',f);await expect(assetSupply('USDC')).rejects.toThrow();expect(f).toHaveBeenCalledTimes(1);
});
