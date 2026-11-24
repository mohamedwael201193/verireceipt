import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {createWiredFinanceHandlers} from '../src/handlers/financeWired';
import {answerDiagnostics,sanitizeAnswerClass} from '../src/core/answerClass';
const query={pool:'USDC/WETH 0.05%',chain:'ethereum'};
const diagnostics=(e:unknown)=>answerDiagnostics('LIQUIDITY_DEPTH_VERIFY_GENERAL',e).answerClass;
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it.each([[403,'http_403'],[429,'http_429'],[404,'http_4xx'],[503,'http_5xx'],[302,'http_other']])('keeps public refusal and safe HTTP%s leg class only',async(status,category)=>{
 const f=vi.fn(async()=>new Response('PRIVATE_SOURCE',{status:status as number}));vi.stubGlobal('fetch',f);
 const e=await createWiredFinanceHandlers({}).liquidity(query).catch(e=>e);
 expect(e.code).toBe('APPROVED_SOURCES_UNAVAILABLE');expect(e.status).toBe(502);expect(diagnostics(e)).toEqual({dexscreener_failure:category});expect(JSON.stringify(e)).not.toContain('PRIVATE');expect(saveReceipt).not.toHaveBeenCalled();expect(f).toHaveBeenCalledTimes(1);
});
it.each(['transport','body_read','malformed','identity_or_value','binding'])('closed %s classification never exposes input or arbitrary errors',async category=>{
 const bad=Object.defineProperty(Error('PRIVATE'),'status',{get(){throw Error('must not inspect');}});
 vi.stubGlobal('fetch',async()=>{if(category==='transport')throw bad;if(category==='body_read')return {ok:true,headers:new Headers(),body:new ReadableStream({start(c){c.error(bad);}})};if(category==='malformed')return new Response('{PRIVATE');return new Response(JSON.stringify({pairs:[]}));});
 const e=await createWiredFinanceHandlers({}).liquidity(category==='binding'?{pool:'PRIVATE',chain:'ethereum'}:query).catch(e=>e);
 expect(e.code).toBe('APPROVED_SOURCES_UNAVAILABLE');expect(diagnostics(e)).toEqual({dexscreener_failure:category});expect(JSON.stringify(diagnostics(e))).not.toContain('PRIVATE');
});
it.each([false,true])('bounded diagnostic timeout, ignoring abort=%s, unchanged runner deadline and no late receipt',async ignores=>{
 vi.useFakeTimers();let release:(r:Response)=>void=()=>{};
 vi.stubGlobal('fetch',async(_u:unknown,init:RequestInit)=>new Promise<Response>((resolve,reject)=>{release=resolve;if(!ignores)init.signal?.addEventListener('abort',()=>reject(Error('PRIVATE')));}));
 const pending=createWiredFinanceHandlers({}).liquidity(query).catch(e=>e);await vi.advanceTimersByTimeAsync(ignores?3000:2500);const e=await pending;
 expect(e.code).toBe('APPROVED_SOURCES_UNAVAILABLE');expect(diagnostics(e)).toEqual({dexscreener_failure:'timeout'});expect(saveReceipt).not.toHaveBeenCalled();release(new Response('{}'));await vi.advanceTimersByTimeAsync(1);expect(saveReceipt).not.toHaveBeenCalled();
});
it('rejects arbitrary metadata and getters',()=>{
 expect(sanitizeAnswerClass('LIQUIDITY_DEPTH_VERIFY_GENERAL',{dexscreener_failure:'PRIVATE'})).toBeUndefined();
 expect(sanitizeAnswerClass('LIQUIDITY_DEPTH_VERIFY_GENERAL',Object.defineProperty({},'dexscreener_failure',{get(){throw Error('PRIVATE');}}))).toBeUndefined();
});
