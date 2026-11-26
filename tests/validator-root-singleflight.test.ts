import {it,expect,vi,afterEach,describe} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {handleValidator,BEACON_SOURCES,noteSourceSlow,FINALIZED_ROOT_CACHE_TTL_MS,resetValidatorCachesForTests,resetValidatorPerformanceReadsForTests} from '../src/handlers/validator';
const raw=readFileSync('tests/fixtures/validator-effective/publicnode-0.json','utf8'),root=readFileSync('tests/fixtures/validator-effective/publicnode-root.json','utf8');
afterEach(()=>{rootText=root;resetValidatorCachesForTests();resetValidatorPerformanceReadsForTests();vi.useRealTimers();vi.clearAllMocks();});
const isRoot=(u:string)=>/\/states\/finalized\/root\/?$/.test(u);
let rootText=root;
function mk(opts:{rootDelay?:number;rootFails?:()=>boolean}={}){const calls:string[]=[];
 const f=(async(u:any)=>{const url=String(u);calls.push(url);
  if(url.includes('/headers/')||url.includes('/rewards/')||url.includes('/validator_balances'))throw Error('optional off');
  if(isRoot(url)){if(opts.rootDelay)await new Promise(r=>setTimeout(r,opts.rootDelay));if(opts.rootFails?.())throw Error('root down');return new Response(rootText);}
  if(url.startsWith(BEACON_SOURCES[3]))throw Error('unavailable');
  const b=JSON.parse(raw);const m=url.match(/validators\/(\d+)/);if(m)b.data.index=m[1];return new Response(JSON.stringify(b));}) as typeof fetch;
 return {f,calls,rootCalls:()=>calls.filter(isRoot).length};}
const call=(i:string,t:ReturnType<typeof mk>,now?:()=>number)=>handleValidator({validator_index:i},{fetchImpl:t.f,optionalReads:false,...(now?{nowMs:now}:{})} as any).then((r:any)=>r,(e:any)=>({error:e.code??String(e),msg:String(e.message)}));
describe('finalized root single flight',()=>{
 it('concurrent calls share one root resolution',async()=>{
  const t=mk({rootDelay:60});const rs:any[]=await Promise.all([call('1',t),call('2',t),call('3',t)]);
  resetValidatorCachesForTests();const seq=mk();for(const i of ['1','2','3'])await call(i,seq);
  expect(t.rootCalls()).toBe(seq.rootCalls());
  for(const r of rs){expect(String(r.msg??'')).not.toContain('finalized state root');if(!r.error)expect(r.effective_balance).toBe(34000000000);}
  expect(rs.filter(r=>!r.error).length).toBeGreaterThan(0);
 });
 it('a failed shared resolution fails every joiner closed, then the next call retries',async()=>{
  let fail=true;const t=mk({rootDelay:40,rootFails:()=>fail});const rs:any[]=await Promise.all([call('1',t),call('2',t)]);
  for(const r of rs){expect(r.error).toBe('QUORUM_UNREACHABLE');expect(r.effective_balance).toBeUndefined();}
  const before=t.rootCalls();fail=false;const ok:any=await call('3',t);expect(t.rootCalls()).toBeGreaterThan(before);expect(ok.effective_balance).toBe(34000000000);
 });
});
describe('root reuse window',()=>{
 it('reuses an agreed root inside the window even when every host is cooling',async()=>{
  const t=mk();let now=Date.now();await call('1',t,()=>now);const n=t.rootCalls();expect(n).toBeGreaterThan(1);
  for(const b of BEACON_SOURCES)noteSourceSlow(b);
  now+=FINALIZED_ROOT_CACHE_TTL_MS-1;const r:any=await call('2',t,()=>now);
  expect(t.rootCalls()).toBe(n);expect(String(r.msg??'')).not.toContain('finalized state root');
 });
 it('does not reuse the root at the window; a newer agreed root is then used',async()=>{
  const t=mk();let now=Date.now();const a:any=await call('1',t,()=>now);const A=JSON.parse(root).data.root;expect(String(a.answer)).toContain(A);
  const B=JSON.parse(root);B.data.root='0x'+'cd'.repeat(32);rootText=JSON.stringify(B);
  now+=FINALIZED_ROOT_CACHE_TTL_MS-1;const inside:any=await call('1',t,()=>now);expect(String(inside.answer)).toContain(A);expect(String(inside.answer)).not.toContain('cdcdcd');
  now+=1;const after:any=await call('3',t,()=>now);expect(String(after.answer)).toContain('0x'+'cd'.repeat(32));
 });
 it('with the window expired and every root source down the call fails closed, with no value',async()=>{
  let down=false;const t=mk({rootFails:()=>down});let now=Date.now();await call('1',t,()=>now);
  down=true;now+=FINALIZED_ROOT_CACHE_TTL_MS+1;const r:any=await call('2',t,()=>now);expect(r.error).toBe('QUORUM_UNREACHABLE');expect(r.effective_balance).toBeUndefined();
 });
});
describe('joiner deadline',()=>{
 it('a joiner with a shorter deadline fails closed at its own deadline while the leader still succeeds',async()=>{
  const t=mk({rootDelay:500});
  const leader=call('1',t);await new Promise(r=>setTimeout(r,50));
  const t0=Date.now();const joiner:any=await handleValidator({validator_index:'2'},{fetchImpl:t.f,timeoutMs:200} as any).then((r:any)=>r,(e:any)=>({error:e.code}));const waited=Date.now()-t0;
  expect(joiner.error).toBe('QUORUM_UNREACHABLE');expect(waited).toBeLessThan(400);
  const l:any=await leader;expect(l.error).toBeUndefined();expect(l.effective_balance).toBe(34000000000);
 });
});
