import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {refreshSourceReachability,sourceReachabilitySnapshot,resetReachabilityForTests,awaitReachabilityForTests} from '../src/core/sourceReachability';
import {mkdtempSync,rmSync} from 'node:fs';
const scratch=mkdtempSync('/tmp/source-health-test-');
process.env.SQLITE_PATH=scratch+'/receipts.sqlite';
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
import {buildServer} from '../src/server';
beforeEach(()=>{resetReachabilityForTests();vi.useFakeTimers();vi.setSystemTime('2026-11-24T00:00:00Z');});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();resetReachabilityForTests();});
it('single-flights and never exceeds one probe per source per minute',async()=>{
 const f=vi.fn(async()=>new Response('captured source body'));vi.stubGlobal('fetch',f);
 refreshSourceReachability();refreshSourceReachability();await awaitReachabilityForTests();
 expect(f).toHaveBeenCalledTimes(1);expect(sourceReachabilitySnapshot().coinpaprika.status).toBe('reachable');
 vi.advanceTimersByTime(59999);refreshSourceReachability();expect(f).toHaveBeenCalledTimes(1);
 vi.advanceTimersByTime(1);refreshSourceReachability();await awaitReachabilityForTests();expect(f).toHaveBeenCalledTimes(2);
});
it('deadline is bounded even if fetch ignores abort, and a late response cannot overwrite timeout',async()=>{
 let finish!:(r:Response)=>void;vi.stubGlobal('fetch',()=>new Promise<Response>(resolve=>finish=resolve));
 refreshSourceReachability();await vi.advanceTimersByTimeAsync(2000);await awaitReachabilityForTests();
 expect(sourceReachabilitySnapshot().coinpaprika.status).toBe('timeout');finish(new Response('late'));await Promise.resolve();await Promise.resolve();
 expect(sourceReachabilitySnapshot().coinpaprika.status).toBe('timeout');
});
it.each([403,429])('stops probes after HTTP %s, no bypass retry',async status=>{
 const f=vi.fn(async()=>new Response('',{status}));vi.stubGlobal('fetch',f);refreshSourceReachability();await awaitReachabilityForTests();
 expect(sourceReachabilitySnapshot().coinpaprika.status).toBe('blocked');vi.advanceTimersByTime(3600000);refreshSourceReachability();expect(f).toHaveBeenCalledTimes(1);
});
it('keeps a pending flight single when the wall clock jumps forward',async()=>{
 let finish!:(r:Response)=>void;const f=vi.fn(()=>new Promise<Response>(resolve=>finish=resolve));vi.stubGlobal('fetch',f);
 refreshSourceReachability();vi.setSystemTime(Date.now()+120000);refreshSourceReachability();expect(f).toHaveBeenCalledTimes(1);
 finish(new Response(''));await awaitReachabilityForTests();
});
it('health response does not await or fail on a pending probe',async()=>{
 vi.useRealTimers();vi.stubGlobal('fetch',()=>new Promise(()=>{}));const app=buildServer();
 try{const response=await app.inject({method:'GET',url:'/health'});expect(response.statusCode).toBe(200);expect(response.json().source_reachability.coinpaprika.status).toBe('pending');}finally{await app.close();await awaitReachabilityForTests();}
});
