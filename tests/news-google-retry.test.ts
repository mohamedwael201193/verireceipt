import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {fetchIndex,resetNewsCircuitForTests} from '../src/handlers/newsSources';
const g=readFileSync('tests/fixtures/news/gnews-rss-openai.xml','utf8');
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();resetNewsCircuitForTests();});
const U='https://news.google.com/rss/search?q=openai';
const hang=(o:any)=>new Promise<Response>((_r,rej)=>o.signal.addEventListener('abort',()=>rej(Object.assign(new Error('t'),{name:'AbortError'}))));
it('first attempt times out leaving the reserve, retry succeeds inside the deadline',async()=>{
 vi.useFakeTimers();const t0=Date.now();const f=vi.fn().mockImplementationOnce((_u:any,o:any)=>hang(o)).mockResolvedValueOnce(new Response(g));vi.stubGlobal('fetch',f);
 const p=fetchIndex(U,t0+3300,{timeoutRetry:true});await vi.advanceTimersByTimeAsync(2099);expect(f).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);
 const r=await p;expect(r.ok).toBe(true);expect(f).toHaveBeenCalledTimes(2);expect(Date.now()-t0).toBe(2100);
});
it('both attempts hang: exactly 2 fetches, ends at the deadline, never later',async()=>{
 vi.useFakeTimers();const t0=Date.now();const f=vi.fn((_u:any,o:any)=>hang(o));vi.stubGlobal('fetch',f);
 const p=fetchIndex(U,t0+3300,{timeoutRetry:true});await vi.advanceTimersByTimeAsync(3299);let done=false;p.then(()=>{done=true;});await vi.advanceTimersByTimeAsync(0);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);
 expect((await p).failure_reason).toBe('timeout');expect(f).toHaveBeenCalledTimes(2);
});
it('no retry when the reserve does not remain; no retry without the option; none for HTTP errors or other hosts',async()=>{
 vi.useFakeTimers();let t0=Date.now();let f=vi.fn((_u:any,o:any)=>hang(o));vi.stubGlobal('fetch',f);
 let p=fetchIndex(U,t0+2500);await vi.advanceTimersByTimeAsync(2500);expect((await p).failure_reason).toBe('timeout');expect(f).toHaveBeenCalledTimes(1);resetNewsCircuitForTests();
 f=vi.fn(async()=>new Response('x',{status:503}));vi.stubGlobal('fetch',f);expect((await fetchIndex(U,Date.now()+3300,{timeoutRetry:true})).ok).toBe(false);expect(f).toHaveBeenCalledTimes(1);resetNewsCircuitForTests();
 t0=Date.now();f=vi.fn((_u:any,o:any)=>hang(o));vi.stubGlobal('fetch',f);p=fetchIndex('https://hn.algolia.com/api/v1/search?query=x',t0+3300,{timeoutRetry:true});await vi.advanceTimersByTimeAsync(3300);await p;expect(f).toHaveBeenCalledTimes(1);
});
it('after a failed retried leg the host breaker is open (no hammering)',async()=>{
 vi.useFakeTimers();const t0=Date.now();const f=vi.fn((_u:any,o:any)=>hang(o));vi.stubGlobal('fetch',f);
 const p=fetchIndex(U,t0+3300,{timeoutRetry:true});await vi.advanceTimersByTimeAsync(3300);await p;expect((await fetchIndex(U,Date.now()+3300,{timeoutRetry:true})).failure_reason).toBe('circuit_open');expect(f).toHaveBeenCalledTimes(2);
});
