import Database from 'better-sqlite3';
import { afterEach,describe,expect,it } from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {BuyerStore} from '../src/buyer/store';
import {BUYER,HOSTED_BUYER_POLICY_HASH,HOSTED_BUYER_TASK_HASH,HOSTED_BUYER_POLICY,buyerPlanHash,type BuyerPlan} from '../src/buyer/contracts';
const payer='0x'+'22'.repeat(20),owner='a'.repeat(64),network='b'.repeat(64),other='c'.repeat(64);
const temps:string[]=[],stores:BuyerStore[]=[];
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'buyer-store-'));temps.push(dir);return join(dir,'buyer.sqlite');};
const open=(file=fixture(),clock=()=>Date.parse('2026-11-22T18:00:00Z'))=>{const s=new BuyerStore(file,payer,clock);stores.push(s);return s;};
function plan(now:number):BuyerPlan {const p:Omit<BuyerPlan,'plan_hash'>={version:'sponsored-filing-plan-v1',id:randomUUID(),created_at:new Date(now).toISOString(),expires_at:new Date(now+600000).toISOString(),input:{cik:'320193',year:2025},policy_hash:HOSTED_BUYER_POLICY_HASH,task_hash:HOSTED_BUYER_TASK_HASH,network:BUYER.network,call_uusdc:BUYER.callUusdc,daily_cap_uusdc:BUYER.dailyUusdc,form:'10-Q',minimum_count:3,params:{entity:'Form 10-Q filings (CIK 320193)',period:'calendar 2025'},rule:structuredClone(HOSTED_BUYER_POLICY.tasks[0].rule) as BuyerPlan['rule']};return {...p,plan_hash:buyerPlanHash(p)};}
function mint(s:BuyerStore,now:number){return s.create(plan(now),owner,network);}
function checkpoint(p:BuyerPlan,now:number){return {plan_hash:p.plan_hash,amount_uusdc:BUYER.callUusdc,nonce:randomUUID(),payer,valid_before:Math.floor(now/1000)+120};}
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const t of temps.splice(0))rmSync(t,{recursive:true,force:true});});
describe('single-host durable SQLite buyer authority (real local DB, no network or signing)',()=>{
 it('owner-binds server-created plan IDs, freezes hashes, and makes start idempotent across two connections',()=>{
  const file=fixture(),a=open(file),b=open(file),p=mint(a,Date.parse('2026-11-22T18:00:00Z'));
  expect(b.read(p.id,other)).toBeNull();expect(()=>b.start(p.id,other,p.plan_hash)).toThrow('NOT_FOUND');
  expect(()=>b.start(p.id,owner,'f'.repeat(64))).toThrow('TERMS_MISMATCH');
  expect(a.start(p.id,owner,p.plan_hash).reused).toBe(false);expect(b.start(p.id,owner,p.plan_hash).reused).toBe(true);
  expect(b.start(p.id,owner,p.plan_hash).plan).toEqual(p);
 });
 it('pins persistent payer identity across restart',()=>{const f=fixture();open(f);expect(()=>new BuyerStore(f,'0x'+'33'.repeat(20))).toThrow('another payer');});
 it('never buys unknown IDs or an expired preview, including exact boundary',()=>{
  let now=Date.parse('2026-11-22T18:00:00Z');const s=open(undefined,()=>now),p=mint(s,now);
  expect(()=>s.start(randomUUID(),owner,p.plan_hash)).toThrow('NOT_FOUND');now+=600000;
  expect(()=>s.start(p.id,owner,p.plan_hash)).toThrow();expect(s.read(p.id,owner)).toBeNull();
 });
 it('keeps uncertain exposure and lease after restart and never retries the same plan',()=>{
  let now=Date.parse('2026-11-22T18:00:00Z');const f=fixture(),a=open(f,()=>now),p=mint(a,now);a.start(p.id,owner,p.plan_hash);a.beforeSign(p.id,checkpoint(p,now));a.uncertain(p.id);
  const b=open(f,()=>now),q=mint(b,now);expect(()=>b.start(q.id,owner,q.plan_hash)).toThrow('BUSY');
  expect(b.start(p.id,owner,p.plan_hash).reused).toBe(true);now+=180001;
  expect(b.start(q.id,owner,q.plan_hash).reused).toBe(false);expect(b.read(p.id,owner)?.state).toBe('uncertain');
 });
 it('requires an exact live lease, server plan hash, payer and amount before durable signing intent',()=>{
  let now=Date.parse('2026-11-22T18:00:00Z');const s=open(undefined,()=>now),p=mint(s,now);s.start(p.id,owner,p.plan_hash);
  for(const patch of [{amount_uusdc:'10001'},{payer:'0x'+'33'.repeat(20)},{plan_hash:'f'.repeat(64)},{valid_before:Math.floor(now/1000)+121}])expect(()=>s.beforeSign(p.id,{...checkpoint(p,now),...patch})).toThrow();
  expect(s.read(p.id,owner)?.state).toBe('reserved');s.beforeSign(p.id,checkpoint(p,now));expect(s.read(p.id,owner)?.state).toBe('signing');expect(()=>s.beforeSign(p.id,checkpoint(p,now))).toThrow('STATE_CHANGED');
  now+=180000;expect(s.read(p.id,owner)?.state).toBe('uncertain');
 });
 it('refuses stolen/reused nonces even across separate jobs',()=>{
  let now=Date.parse('2026-11-22T18:00:00Z');const s=open(undefined,()=>now),p=mint(s,now),c=checkpoint(p,now);s.start(p.id,owner,p.plan_hash);s.beforeSign(p.id,c);s.uncertain(p.id);now+=180001;
  const q=mint(s,now);s.start(q.id,owner,q.plan_hash);expect(()=>s.beforeSign(q.id,{...checkpoint(q,now),nonce:c.nonce})).toThrow();
 });
 it('refuses stale worker checkpoints when another reservation owns the payer',()=>{
  let now=Date.parse('2026-11-22T18:00:00Z');const f=fixture(),a=open(f,()=>now),b=open(f,()=>now),p=mint(a,now);a.start(p.id,owner,p.plan_hash);now+=180000;
  const q=mint(b,now);b.start(q.id,owner,q.plan_hash);expect(()=>a.beforeSign(p.id,checkpoint(p,now))).toThrow('STATE_CHANGED');
 });
 it('enforces daily reservations without refunds, across connections and UTC rollover',()=>{
  let now=Date.parse('2026-11-22T00:00:00Z');const f=fixture(),a=open(f,()=>now),b=open(f,()=>now);
  for(let n=0;n<200;n++){const p=mint(n%2?a:b,now);a.start(p.id,owner,p.plan_hash);a.complete(p.id,{plan_hash:p.plan_hash});now+=360001;}
  const blocked=mint(b,now);expect(()=>b.start(blocked.id,owner,blocked.plan_hash)).toThrow('DAILY_CAP');
  now=Date.parse('2026-11-23T00:00:00Z');const next=mint(b,now);expect(b.start(next.id,owner,next.plan_hash).reused).toBe(false);
 });
 it('rechecks signing-day exposure for a reservation crossing UTC midnight',()=>{
  let now=Date.parse('2026-11-22T23:59:59Z');const s=open(undefined,()=>now),p=mint(s,now);s.start(p.id,owner,p.plan_hash);now+=2000;
  s.beforeSign(p.id,checkpoint(p,now));s.complete(p.id,{plan_hash:p.plan_hash,hold:true});
  // Cross-midnight signing consumes the new signing day as well as the reservation day.
  for(let n=0;n<199;n++){now+=360001;const q=mint(s,now);s.start(q.id,owner,q.plan_hash);s.complete(q.id,{plan_hash:q.plan_hash});}
  now+=180001;const last=mint(s,now);expect(()=>s.start(last.id,owner,last.plan_hash)).toThrow('DAILY_CAP');
 });
 it('bounds worst-case retained payload capacity before authorizing another purchase',()=>{
  let now=Date.parse('2026-11-22T00:00:00Z');const s=open(undefined,()=>now);
  for(let n=0;n<9;n++){const p=mint(s,now);s.start(p.id,owner,p.plan_hash);now+=180001;}
  const p=mint(s,now);expect(()=>s.start(p.id,owner,p.plan_hash)).toThrow('STORAGE_CAP');
 });
 it('requires headers before body and preserves terminal results without overwriting',()=>{
  const now=Date.parse('2026-11-22T18:00:00Z'),s=open(),p=mint(s,now);s.start(p.id,owner,p.plan_hash);s.beforeSign(p.id,checkpoint(p,now));
  expect(()=>s.recordPaidBody(p.id,{status:200,receipt_header:null,body_text:'{}'})).toThrow();
  s.recordHeaders(p.id,{status:200,receipt_header:null});expect(()=>s.recordHeaders(p.id,{status:200,receipt_header:null})).toThrow();
  s.recordPaidBody(p.id,{status:200,receipt_header:null,body_text:'{}'});s.complete(p.id,{plan_hash:p.plan_hash,hold:true});
  expect(s.read(p.id,owner)?.result).toEqual({plan_hash:p.plan_hash,hold:true});expect(()=>s.complete(p.id,{plan_hash:p.plan_hash,hold:false})).toThrow();
 });
 it('denies payload access at 24h, purges private data, and will not buy expired or removed IDs',()=>{
  let now=Date.parse('2026-11-22T18:00:00Z');const f=fixture(),s=open(f,()=>now),p=mint(s,now);s.start(p.id,owner,p.plan_hash);s.complete(p.id,{plan_hash:p.plan_hash});
  now+=86400000;expect(s.read(p.id,owner)).toBeNull();s.purge();expect(()=>s.start(p.id,owner,p.plan_hash)).toThrow();
  const db=new Database(f,{readonly:true});const expired=db.prepare('SELECT owner_hash,network_hash,plan,headers,paid_body,result,state FROM buyer_jobs WHERE id=?').get(p.id);db.close();expect(expired).toEqual({owner_hash:'',network_hash:'',plan:null,headers:null,paid_body:null,result:null,state:'expired'});
  now+=86400000;s.purge();expect(()=>s.start(p.id,owner,p.plan_hash)).toThrow('NOT_FOUND');
 });
 it('rate limits preview creation and read-only followup records',()=>{
  const now=Date.parse('2026-11-22T18:00:00Z'),s=open(),p=mint(s,now);s.start(p.id,owner,p.plan_hash);s.complete(p.id,{plan_hash:p.plan_hash});s.addFollowup(p.id,owner,{ok:false});expect(()=>s.addFollowup(p.id,owner,{ok:true})).toThrow('RATE_LIMIT');
  for(let n=1;n<10;n++)mint(s,now);expect(()=>mint(s,now)).toThrow('RATE_LIMIT');
 });
 it('serializes simultaneous worker starts on the actual same WAL database',async()=>{
  const f=fixture(),now=Date.parse('2026-11-22T18:00:00Z'),s=open(f,()=>now),p=mint(s,now);
  const workers=Array.from({length:4},()=>new Worker(`require('tsx/cjs');const {parentPort,workerData:d}=require('node:worker_threads');const {BuyerStore}=require(d.module);const s=new BuyerStore(d.file,d.payer,()=>d.now);parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage(s.start(d.id,d.owner,d.hash));}catch(e){parentPort.postMessage({error:e.message});}s.close();});`,{eval:true,workerData:{module:resolve('src/buyer/store.ts'),file:f,payer,now,id:p.id,owner,hash:p.plan_hash}}));
  await Promise.all(workers.map(w=>new Promise<void>((res,rej)=>{w.once('message',()=>res());w.once('error',rej);})));const replies=workers.map(w=>new Promise<any>((res,rej)=>{w.once('message',res);w.once('error',rej);}));for(const w of workers)w.postMessage('go');const r=await Promise.all(replies);await Promise.all(workers.map(w=>w.terminate()));expect(r.filter(x=>x.reused===false)).toHaveLength(1);expect(r.filter(x=>x.reused===true)).toHaveLength(3);
 });
});
