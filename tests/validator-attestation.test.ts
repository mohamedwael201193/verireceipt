import {it,expect,vi,afterEach,describe} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {handleValidator,BEACON_SOURCES,resetValidatorCachesForTests,resetValidatorPerformanceReadsForTests} from '../src/handlers/validator';
const raw=readFileSync('tests/fixtures/validator-effective/publicnode-0.json','utf8'),root=readFileSync('tests/fixtures/validator-effective/publicnode-root.json','utf8');
const rewards=readFileSync('tests/fixtures/validator-effective/publicnode-attestation-rewards-491804-v1.json','utf8');
afterEach(()=>{curIdx='1';resetValidatorCachesForTests();resetValidatorPerformanceReadsForTests();vi.useRealTimers();vi.clearAllMocks();});
const HEAD=JSON.stringify({finalized:true,execution_optimistic:false,data:{header:{message:{slot:'15737760'}}}});
let curIdx='1';
function validatorBody(over:Record<string,any>={}){const b=JSON.parse(raw);b.data.index=curIdx;Object.assign(b.data,over.data??{});Object.assign(b.data.validator,over.validator??{});return JSON.stringify(b);}
interface T{calls:{url:string;init:any}[];rewardsFor:(base:string)=>Response|Promise<Response>;over?:Record<string,any>;}
function transport(t:T):typeof fetch{return (async(u:any,init:any)=>{const url=String(u);t.calls.push({url,init});
 if(url.includes('/headers/'))return new Response(HEAD);
 if(url.includes('/rewards/attestations/')){const base=BEACON_SOURCES.find(b=>url.startsWith(b))!;return t.rewardsFor(base);}
 if(url.includes('/root'))return new Response(root);
 if(url.startsWith(BEACON_SOURCES[3]))throw Error('unavailable');
 if(url.includes('/validator_balances'))throw Error('no balances');
 return new Response(validatorBody(t.over));}) as typeof fetch;}
const rewardCalls=(t:T)=>t.calls.filter(c=>c.url.includes('/rewards/attestations/'));
describe('active validator attestation rewards',()=>{
 it('reports a two-source agreed row from the real captured body, effective_balance unchanged, POST with the index only',async()=>{
  const t:T={calls:[],rewardsFor:()=>new Response(rewards)};const r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});
  expect(r.effective_balance).toBe(34000000000);expect(r.verdict).toBe('verified');expect(r.performance_status).toBe('measured');
  const a=r.attestation_performance;expect(a).toMatchObject({epoch:'491804',epoch_finalized:false,cross_checked:true,sources_agreeing:2,head_reward_gwei:'2088',target_reward_gwei:'3931',source_reward_gwei:'2117',inactivity_gwei:'0',head_correct:true,target_correct:true,source_correct:true,total_reward_gwei:'8136'});
  expect(r.answer).toContain('For attestation epoch 491804');expect(r.answer).toContain('not yet finalized');expect(r.answer).toContain('Not measured: proposer duties');expect(String(r.answer).startsWith('Validator 1 effective balance is 34000000000 gwei')).toBe(true);
  expect(r.performance_not_measured).toContain('proposer duties');expect(r.performance_measured).toContain('attestation head/target/source rewards for one epoch');expect(r.attestation_receipt).toBeTruthy();
  const c=rewardCalls(t);expect(c).toHaveLength(2);for(const x of c){expect(x.init.method).toBe('POST');expect(JSON.parse(x.init.body)).toEqual(['1']);expect(x.init.redirect).toBe('error');expect(x.url).toMatch(/\/rewards\/attestations\/491804$/);}
 });
 it('one answering source is disclosed as not cross-checked',async()=>{
  let n=0;const t:T={calls:[],rewardsFor:()=>n++===0?new Response(rewards):new Response('x',{status:500})};const r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});
  expect(r.attestation_performance).toMatchObject({cross_checked:false,sources_agreeing:1});expect(r.answer).toContain('single source and was not cross-checked');expect(r.attestation_performance.basis).toContain('ONE source only');
 });
 it('two sources disagreeing on the row yield no performance numbers',async()=>{
  let n=0;const d=JSON.parse(rewards);d.data.total_rewards[0].target='1';const t:T={calls:[],rewardsFor:()=>new Response(n++===0?rewards:JSON.stringify(d))};
  const r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});expect(r.performance_status).toBe('attestation_rewards_unavailable');expect(r).not.toHaveProperty('attestation_performance');expect(r.effective_balance).toBe(34000000000);expect(r.answer).toContain('were not obtained');
 });
 it('a row for a different validator is refused',async()=>{
  const d=JSON.parse(rewards);d.data.total_rewards[0].validator_index='2';const t:T={calls:[],rewardsFor:()=>new Response(JSON.stringify(d))};
  const r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});expect(r).not.toHaveProperty('attestation_performance');
 });
 it('an optimistic rewards reply and a non-numeric reward are refused',async()=>{
  for(const mut of [(d:any)=>{d.execution_optimistic=true;},(d:any)=>{d.data.total_rewards[0].head='1.5';}]){resetValidatorCachesForTests();resetValidatorPerformanceReadsForTests();const d=JSON.parse(rewards);mut(d);const t:T={calls:[],rewardsFor:()=>new Response(JSON.stringify(d))};
   const r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});expect(r).not.toHaveProperty('attestation_performance');}
 });
 it('a body over the 320 KiB cap is refused and a sub-cap body still works',async()=>{
  const big=JSON.parse(rewards);big.pad='x'.repeat(330*1024);const t:T={calls:[],rewardsFor:()=>new Response(JSON.stringify(big))};
  const r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});expect(r).not.toHaveProperty('attestation_performance');expect(rewards.length).toBeGreaterThan(65536);
 });
 it('skips the rewards read when the verified path already used the start window',async()=>{
  vi.useFakeTimers();const calls:string[]=[];const f=(async(u:any)=>{const url=String(u);calls.push(url);if(url.includes('/root'))return new Response(root);if(url.includes('/headers/'))return new Response(HEAD);if(url.startsWith(BEACON_SOURCES[3]))throw Error('x');if(url.includes('/rewards/'))return new Response(rewards);await new Promise(r=>setTimeout(r,1700));const b=JSON.parse(raw);b.data.index='1';return new Response(JSON.stringify(b));}) as typeof fetch;
  const p=handleValidator({validator_index:'1'},{fetchImpl:f});await vi.advanceTimersByTimeAsync(3000);const r:any=await p;expect(r.effective_balance).toBe(34000000000);expect(calls.some(u=>u.includes('/rewards/'))).toBe(false);expect(r.performance_status).toBe('attestation_rewards_unavailable');
 });
});
describe('inactive validators say so plainly',()=>{
 it.each([
  ['withdrawal_done',{data:{status:'withdrawal_done'},validator:{exit_epoch:'428813',withdrawable_epoch:'429069',activation_epoch:'174446'}},'last active epoch is 428812 and its exit epoch is 428813'],
  ['exited_unslashed',{data:{status:'exited_unslashed'},validator:{exit_epoch:'428813',withdrawable_epoch:'429069',activation_epoch:'174446'}},'last active epoch is 428812'],
  ['exited_slashed',{data:{status:'exited_slashed'},validator:{slashed:true,exit_epoch:'428813',withdrawable_epoch:'429069',activation_epoch:'174446'}},'slashed, so no live performance exists'],
  ['active_slashed',{data:{status:'active_slashed'},validator:{slashed:true,exit_epoch:'428813',withdrawable_epoch:'429069',activation_epoch:'174446'}},'no live performance exists'],
  ['pending_queued',{data:{status:'pending_queued'},validator:{activation_epoch:'18446744073709551615'}},'not active yet'],
 ])('%s',async(_n,over,expected)=>{
  const t:T={calls:[],rewardsFor:()=>new Response(rewards),over};const r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});
  expect(r.performance_status).toBe('no_live_performance');expect(r.answer).toContain(expected);expect(r.answer).toContain('no live performance exists');expect(rewardCalls(t)).toHaveLength(0);expect(r).not.toHaveProperty('attestation_performance');expect(r.verdict).toBe('verified');
 });
 it('reports last_active_epoch and exit_epoch fields for an exited validator',async()=>{
  const t:T={calls:[],rewardsFor:()=>new Response(rewards),over:{data:{status:'withdrawal_done'},validator:{exit_epoch:'428813',withdrawable_epoch:'429069',activation_epoch:'174446'}}};
  const r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});expect(r.last_active_epoch).toBe('428812');expect(r.exit_epoch).toBe('428813');
 });
});
describe('guards',()=>{
 it('a zero or negative reward is not reported as correct',async()=>{
  const d=JSON.parse(rewards);Object.assign(d.data.total_rewards[0],{head:'0',target:'-100',source:'5'});const t:T={calls:[],rewardsFor:()=>new Response(JSON.stringify(d))};
  const r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});expect(r.attestation_performance).toMatchObject({head_correct:false,target_correct:false,source_correct:true});
 });
 it('a failed finalized-head read is not memoized for the attestation step',async()=>{
  let n=0;const t:T={calls:[],rewardsFor:()=>new Response(rewards)};const base=transport(t);
  const f=(async(u:any,i:any)=>{if(String(u).includes('/headers/')&&n++===0)throw Error('flap');return base(u,i);}) as typeof fetch;
  const r:any=await handleValidator({validator_index:'1'},{fetchImpl:f});expect(n).toBeGreaterThan(1);expect(r.performance_status).toBe('measured');
 });
});
describe('review fixes',()=>{
 const hang=()=>{const enc=new TextEncoder();let sent=false;const reader={read:async()=>{if(sent)return{done:true,value:undefined};sent=true;return{done:false,value:enc.encode('x'.repeat(330*1024))};},cancel:()=>new Promise<void>(()=>{})};
  return {ok:true,status:200,headers:new Headers(),body:{getReader:()=>reader,cancel:()=>new Promise<void>(()=>{})},text:async()=>''} as unknown as Response;};
 it('an oversize body whose cancel never settles keeps host ownership until the bounded cancel wait passes',async()=>{
  vi.useFakeTimers();const t:T={calls:[],rewardsFor:()=>hang()};const f=transport(t);
  const p1=handleValidator({validator_index:'1'},{fetchImpl:f});await vi.advanceTimersByTimeAsync(100);
  const n1=rewardCalls(t).length;expect(n1).toBeGreaterThan(0);
  curIdx='2';const p2=handleValidator({validator_index:'2'},{fetchImpl:f});await vi.advanceTimersByTimeAsync(50);
  expect(rewardCalls(t).length).toBe(n1);
  await vi.advanceTimersByTimeAsync(4000);await p1;await p2;
 });
 it('a non-OK response body is cancelled',async()=>{
  let cancelled=0;const mk=()=>({ok:false,status:500,headers:new Headers(),body:{cancel:async()=>{cancelled++;}},text:async()=>''}) as unknown as Response;
  const t:T={calls:[],rewardsFor:mk};await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});expect(cancelled).toBeGreaterThan(0);
 });
 it('a non-finalized head yields no rewards read',async()=>{
  const t:T={calls:[],rewardsFor:()=>new Response(rewards)};const base=transport(t);
  const f=(async(u:any,i:any)=>String(u).includes('/headers/')?new Response(JSON.stringify({finalized:false,execution_optimistic:false,data:{header:{message:{slot:'15737760'}}}})):base(u,i)) as typeof fetch;
  const r:any=await handleValidator({validator_index:'1'},{fetchImpl:f});expect(rewardCalls(t)).toHaveLength(0);expect(r.performance_status).toBe('attestation_rewards_unavailable');
 });
 it('only the ideal bucket matching the effective balance is used, and no match gives a null ideal',async()=>{
  const d=JSON.parse(rewards);d.data.ideal_rewards=[{effective_balance:'1000000000',head:'1',target:'1',source:'1',inactivity:'0'},{effective_balance:'34000000000',head:'10',target:'20',source:'30',inactivity:'0'},{effective_balance:'35000000000',head:'7',target:'7',source:'7',inactivity:'0'}];
  let t:T={calls:[],rewardsFor:()=>new Response(JSON.stringify(d))};let r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});
  expect(r.attestation_performance.ideal_reward_gwei).toBe('60');
  resetValidatorCachesForTests();resetValidatorPerformanceReadsForTests();
  d.data.ideal_rewards=[{effective_balance:'1000000000',head:'1',target:'1',source:'1',inactivity:'0'}];
  t={calls:[],rewardsFor:()=>new Response(JSON.stringify(d))};r=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});
  expect(r.attestation_performance.ideal_reward_gwei).toBeNull();expect(r.attestation_performance.reward_efficiency_pct).toBeNull();expect(r.effective_balance).toBe(34000000000);
 });
 it('a rewards reply with two rows is refused',async()=>{
  const d=JSON.parse(rewards);d.data.total_rewards.push({...d.data.total_rewards[0]});const t:T={calls:[],rewardsFor:()=>new Response(JSON.stringify(d))};
  const r:any=await handleValidator({validator_index:'1'},{fetchImpl:transport(t)});expect(r).not.toHaveProperty('attestation_performance');
 });
});
describe('bounded cancel pin',()=>{
 it('holds ownership through 220 ms and aborts the request signal at the 250 ms cancel bound',async()=>{
  vi.useFakeTimers();const enc=new TextEncoder();const signals:AbortSignal[]=[];
  const mk=()=>{let sent=false;const reader={read:async()=>{if(sent)return{done:true,value:undefined};sent=true;return{done:false,value:enc.encode('x'.repeat(330*1024))};},cancel:()=>new Promise<void>(()=>{})};
   return {ok:true,status:200,headers:new Headers(),body:{getReader:()=>reader},text:async()=>''} as unknown as Response;};
  const t:T={calls:[],rewardsFor:()=>mk()};const base=transport(t);
  const f=(async(u:any,i:any)=>{if(String(u).includes('/rewards/'))signals.push(i.signal);return base(u,i);}) as typeof fetch;
  const p1=handleValidator({validator_index:'1'},{fetchImpl:f});await vi.advanceTimersByTimeAsync(200);
  const n=rewardCalls(t).length;expect(n).toBeGreaterThan(0);expect(signals.every(s=>!s.aborted)).toBe(true);
  curIdx='2';const early=handleValidator({validator_index:'2'},{fetchImpl:f});await vi.advanceTimersByTimeAsync(20);expect(rewardCalls(t).length).toBe(n);
  await vi.advanceTimersByTimeAsync(60);expect(signals.slice(0,n).every(s=>s.aborted)).toBe(true);
  await vi.advanceTimersByTimeAsync(4000);await p1;await early;
 });
 it.each([500,429])('a %i body whose cancel never settles keeps its signal live at 220 ms and aborts it by 280 ms',async(status)=>{
  vi.useFakeTimers();const signals:AbortSignal[]=[];
  const mk=()=>({ok:false,status,headers:new Headers(),body:{cancel:()=>new Promise<void>(()=>{})},text:async()=>''}) as unknown as Response;
  const t:T={calls:[],rewardsFor:()=>mk()};const base=transport(t);
  const f=(async(u:any,i:any)=>{if(String(u).includes('/rewards/'))signals.push(i.signal);return base(u,i);}) as typeof fetch;
  const p=handleValidator({validator_index:'1'},{fetchImpl:f});await vi.advanceTimersByTimeAsync(220);
  expect(signals.length).toBeGreaterThan(0);expect(signals.every(s=>!s.aborted)).toBe(true);
  await vi.advanceTimersByTimeAsync(60);expect(signals.every(s=>s.aborted)).toBe(true);
  await vi.advanceTimersByTimeAsync(4000);await p;
 });
});
