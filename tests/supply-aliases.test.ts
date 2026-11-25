import {afterEach,expect,it,vi} from 'vitest';vi.mock('../src/core/storage',async original=>({...await original<typeof import('../src/core/storage')>(),saveReceipt:vi.fn(async()=>{})}));
import {readFileSync} from 'fs';import {join} from 'path';import {saveReceipt} from '../src/core/storage';
import {handleTokenSupply} from '../src/handlers/tokenSupply';import {buildServer} from '../src/server';
afterEach(()=>vi.unstubAllGlobals());
it.each(['query','q','input','symbol','asset'])('accepts %s alias before chain validation rather than missing-token refusal',async alias=>{const f=vi.fn();vi.stubGlobal('fetch',f);await expect(handleTokenSupply({[alias]:'USDC on wrong-chain'})).rejects.toMatchObject({code:'UNSUPPORTED_CHAIN'});expect(f).not.toHaveBeenCalled();});
it('rejects conflicting alias values instead of silently choosing a different token',async()=>{await expect(handleTokenSupply({token:'USDC on ethereum',symbol:'DAI on ethereum'})).rejects.toMatchObject({code:'TOKEN_INPUT_CONFLICT'});});
it('route accepts aliases, ignores unknown keys and refuses recognized duplicate raw query keys',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);const app=buildServer();try{expect((await app.inject({url:'/v1/token-supply?query=USDC%20on%20wrong-chain'})).json().code).toBe('UNSUPPORTED_CHAIN');expect((await app.inject({url:'/v1/token-supply?token=USDC&token=DAI'})).json().code).toBe('DUPLICATE_PARAM');expect((await app.inject({url:'/v1/token-supply?token=USDC%20on%20wrong-chain&private=value&private=again'})).json().code).toBe('UNSUPPORTED_CHAIN');expect(f).not.toHaveBeenCalled();}finally{await app.close();}});

it.each(['query','q','input','symbol','asset'])('successful %s alias preserves resolved input in evidence with padded blank token',async alias=>{
 const capture=JSON.parse(readFileSync(join(__dirname,'fixtures/token-chain-supply/usdc-finalized.json'),'utf8'));
 vi.stubGlobal('fetch',async(url:unknown,init?:{body?:unknown})=>{const request=JSON.parse(String(init?.body));const leg=capture.legs.find((l:any)=>l.url===String(url))??capture.legs[0];const response=leg.responses.find((r:any)=>r.request.params[0].data===request.params[0].data);return new Response(response.raw);});
 const out=await handleTokenSupply({token:'   ',[alias]:' USDC '});expect(out.chain).toBe('ethereum');expect(out.total_supply).toBeGreaterThan(0);
 const evidence=vi.mocked(saveReceipt).mock.calls.at(-1)![1] as string;expect(JSON.parse(evidence).chain_resolution.input).toBe('USDC');
});
it('identical mixed-case aliases are not conflicts',async()=>{await expect(handleTokenSupply({token:'USDC on wrong-chain',query:'usdc ON wrong-chain'})).rejects.toMatchObject({code:'UNSUPPORTED_CHAIN'});});

it.each(['token','chain','query','q','input','symbol','asset'])('rejects duplicate recognized %s keys even when equal',async key=>{const app=buildServer();try{expect((await app.inject({url:'/v1/token-supply?'+key+'=USDC&'+key+'=USDC'})).json().code).toBe('DUPLICATE_PARAM');}finally{await app.close();}});
