import {afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{}),storageBackend:()=> 'postgres'}));
import {buildServer} from '../src/server';
import {getUpstreamsSnapshot,resetUpstreamsForTests,recordUpstreamOkFromReceipt} from '../src/core/upstreams';
const capture=JSON.parse(readFileSync('tests/fixtures/aave-yield/usdc-safe-20261125.json','utf8'));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();resetUpstreamsForTests();});
it('unbound yield input retains refusal status but cannot poison RPC health',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);const app=buildServer();try{for(const tail of['?project=compound&symbol=USDC&chain=ethereum','?project=aave-v3&symbol=WBTC&chain=ethereum','?project=aave-v3&symbol=USDC&chain=base','?symbol=USDC&chain=ethereum']){const r=await app.inject({method:'GET',url:'/v1/yield'+tail});expect(r.statusCode).toBe(tail.startsWith('?symbol')?400:502);}expect(f).not.toHaveBeenCalled();expect(getUpstreamsSnapshot()).toEqual({});}finally{await app.close();}});
it('real supported source failure still records the yield service error',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('unavailable',{status:503})));const app=buildServer();try{expect((await app.inject({method:'GET',url:'/v1/yield?project=aave-v3&symbol=USDC&chain=ethereum'})).statusCode).toBe(502);expect(getUpstreamsSnapshot()['aave-v3-evm-rpc']).toMatchObject({last_ok:null,last_error:'APPROVED_SOURCES_UNAVAILABLE'});}finally{await app.close();}});
it('recorded safe yield success updates same yield service key at receipt fetch time',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(capture.fetched_at));vi.stubGlobal('fetch',async(url:unknown,init?:RequestInit)=>{const q=JSON.parse(String(init?.body));const leg=capture.results.find((l:any)=>l.endpoint===String(url));const row=leg?.raw.find((r:any)=>r.method===q.method&&JSON.stringify(r.params)===JSON.stringify(q.params));if(!row)throw Error('uncaptured request');return new Response(row.body,{status:row.status});});const app=buildServer();try{const r=await app.inject({method:'GET',url:'/v1/yield?project=%20AAVE-V3%20&symbol=usdc&chain=Ethereum'});expect(r.statusCode).toBe(200);expect(getUpstreamsSnapshot()['aave-v3-evm-rpc']).toMatchObject({last_ok:r.json().receipt.fetched_at,last_err:null});expect(getUpstreamsSnapshot()['evm-rpc']).toBeUndefined();}finally{await app.close();}
});
it('generic receipt service mapping unchanged and missing receipts or stale-disclosed cannot mark OK',()=>{recordUpstreamOkFromReceipt({upstream_url:'https://rpc.mevblocker.io',fetched_at:'2026-11-25T00:00:00Z'});expect(getUpstreamsSnapshot()['evm-rpc'].last_ok).toBe('2026-11-25T00:00:00.000Z');recordUpstreamOkFromReceipt(undefined,'aave-v3-evm-rpc');recordUpstreamOkFromReceipt({upstream_url:'https://rpc.mevblocker.io',quorum_votes:'STALE DISCLOSED'},'aave-v3-evm-rpc');expect(getUpstreamsSnapshot()['aave-v3-evm-rpc']).toBeUndefined();});
it.each([
 '?project=%20AaVe-V3%20&symbol=USDC&chain=ethereum',
 '?project=aave-v3&symbol=%20uSdC%20&chain=ethereum',
 '?project=aave-v3&symbol=USDC&chain=%20EtHeReUm%20',
])('supported outage with isolated normalized input still records upstream failure %s',async tail=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('unavailable',{status:503})));const app=buildServer();try{expect((await app.inject({method:'GET',url:'/v1/yield'+tail})).statusCode).toBe(502);expect(getUpstreamsSnapshot()['aave-v3-evm-rpc']).toMatchObject({last_ok:null,last_error:'APPROVED_SOURCES_UNAVAILABLE'});}finally{await app.close();}
});
