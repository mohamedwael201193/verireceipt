import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleGameResult} from '../src/handlers/gameResult';
import {answerDiagnostics,sanitizeAnswerClass} from '../src/core/answerClass';
const input={game:'Chargers vs Ravens 2026-11-16'};
const diagnostic=(e:unknown)=>answerDiagnostics('GAME_RESULT_GENERAL',e).answerClass;
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it('all failed leagues retain same public refusal and attach exact safe HTTP classes only',async()=>{
 vi.stubGlobal('fetch',async(url:string)=>new Response('PRIVATE_UPSTREAM_BODY',{status:url.includes('/nfl/')?403:url.includes('/nba/')?429:url.includes('/mlb/')?404:503}));
 const e=await handleGameResult(input).catch(e=>e);
 expect(e.status).toBe(502);expect(e.code).toBe('ESPN_UNREACHABLE');
 expect(e.message).toBe('ESPN scoreboards failed for every covered league (NFL, NBA, MLB, NHL)');
 expect(diagnostic(e)).toEqual({espn_nfl_failure:'http_403',espn_nba_failure:'http_429',espn_mlb_failure:'http_4xx',espn_nhl_failure:'http_5xx'});
 expect(JSON.stringify(e)).not.toMatch(/espn_nfl|PRIVATE_UPSTREAM/);expect(saveReceipt).not.toHaveBeenCalled();
});
it.each(['status-getter','proxy','primitive'])('arbitrary thrown %s is not inspected or substituted',async mode=>{
 let inspected=0;const original=mode==='status-getter'?Object.defineProperty(Error('PRIVATE'), 'status',{get(){inspected++;throw Error('REPLACEMENT');}}):mode==='proxy'?new Proxy({},{get(){inspected++;throw Error('REPLACEMENT');},getOwnPropertyDescriptor(){inspected++;throw Error('REPLACEMENT');}}):'PRIVATE';
 const f=vi.fn(async()=>{throw original;});vi.stubGlobal('fetch',f);
 const e=await handleGameResult(input).catch(e=>e);expect(e.code).toBe('ESPN_UNREACHABLE');expect(inspected).toBe(0);expect(f).toHaveBeenCalledTimes(5);
 expect(diagnostic(e)).toEqual(Object.fromEntries(['nfl','nba','mlb','nhl'].map(l=>['espn_'+l+'_failure',mode==='primitive'?'unknown':'transport'])));
});
it('body-read failures are separate and never log source text',async()=>{
 vi.stubGlobal('fetch',async()=>({ok:true,text:async()=>{throw Error('PRIVATE_BODY_FAILURE');}}));
 const e=await handleGameResult(input).catch(e=>e);expect(diagnostic(e)).toEqual(Object.fromEntries(['nfl','nba','mlb','nhl'].map(l=>['espn_'+l+'_failure','body_read'])));
 expect(JSON.stringify(diagnostic(e))).not.toContain('PRIVATE');
});
it('existing abort timeout remains6seconds with no retry or additional calls',async()=>{
 vi.useFakeTimers();const f=vi.fn(async(_url:string,init:RequestInit)=>new Promise((_resolve,reject)=>{init.signal?.addEventListener('abort',()=>reject(new Error('PRIVATE_ABORT')));}));vi.stubGlobal('fetch',f);
 const pending=handleGameResult(input).catch(e=>e);await vi.advanceTimersByTimeAsync(5999);expect(f).toHaveBeenCalledTimes(4);await vi.advanceTimersByTimeAsync(1);const e=await pending;
 expect(e.code).toBe('ESPN_UNREACHABLE');expect(diagnostic(e)).toEqual(Object.fromEntries(['nfl','nba','mlb','nhl'].map(l=>['espn_'+l+'_failure','timeout'])));expect(f).toHaveBeenCalledTimes(4);
});
it('partial failure does not turn no-match into all-source failure',async()=>{
 vi.stubGlobal('fetch',async(url:string)=>new Response(url.includes('/nfl/')?'PRIVATE':JSON.stringify({events:[]}),{status:url.includes('/nfl/')?403:200}));
 const e=await handleGameResult(input).catch(e=>e);expect(e.code).toBe('GAME_NOT_FOUND');expect(diagnostic(e)).toBeUndefined();
});
it('sanitizer drops foreign values, keys, getters and cross-intent diagnostics',()=>{
 expect(sanitizeAnswerClass('GAME_RESULT_GENERAL',{espn_nfl_failure:'PRIVATE',espn_nba_failure:'http_403',raw:'PRIVATE'})).toEqual({espn_nba_failure:'http_403'});
 expect(sanitizeAnswerClass('GAME_RESULT_GENERAL',Object.defineProperty({},'espn_nfl_failure',{get(){throw Error('PRIVATE');}}))).toBeUndefined();
 expect(sanitizeAnswerClass('TOKEN_HOLDER_COUNT_GENERAL',{espn_nfl_failure:'http_403'})).toBeUndefined();
});
