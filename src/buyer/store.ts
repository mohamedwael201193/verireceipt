// One persistent SQLite authority for one dedicated hosted payer on one host.
// WAL + FULL synchronous + IMMEDIATE transactions serialize every worker.
// Never use separate files/replicas or another purchasing client for this payer.
import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { BUYER, buyerId, validateBuyerPlan, type BuyerPlan } from './contracts';
export type BuyerState='planned'|'reserved'|'signing'|'complete'|'uncertain'|'expired';
export class BuyerStoreError extends Error {constructor(readonly code:'NOT_FOUND'|'EXPIRED'|'BUSY'|'RATE_LIMIT'|'DAILY_CAP'|'STORAGE_CAP'|'TERMS_MISMATCH'|'STATE_CHANGED'){super(code);}}
interface Row {id:string;owner_hash:string;network_hash:string;created_at:number;expires_at:number;plan:string|null;plan_hash:string;state:BuyerState;reserved_at:number|null;signed_at:number|null;nonce:string|null;headers:string|null;paid_body:string|null;result:string|null}
export interface SigningCheckpoint {plan_hash:string;amount_uusdc:string;nonce:string;payer:string;valid_before:number}
const SCHEMA=`
CREATE TABLE IF NOT EXISTS buyer_payer(id INTEGER PRIMARY KEY CHECK(id=1),address TEXT NOT NULL,active_job TEXT,blocked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS buyer_jobs(
 id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,network_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,plan TEXT,plan_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('planned','reserved','signing','complete','uncertain','expired')),
 reserved_at INTEGER,signed_at INTEGER,nonce TEXT UNIQUE,headers TEXT,paid_body TEXT,result TEXT
);
CREATE INDEX IF NOT EXISTS buyer_jobs_reserved ON buyer_jobs(reserved_at);
CREATE INDEX IF NOT EXISTS buyer_jobs_created ON buyer_jobs(created_at);
CREATE TABLE IF NOT EXISTS buyer_followups(job_id TEXT NOT NULL REFERENCES buyer_jobs(id) ON DELETE CASCADE,observed_at INTEGER NOT NULL,data TEXT NOT NULL);
`;
const DAY=86400000,PER_JOB_STORAGE=BUYER.maxResultBytes+2100000+16000+320000+4096;
const dayStart=(ms:number)=>Math.floor(ms/DAY)*DAY;
export class BuyerStore {
 private readonly db:Database.Database;
 constructor(filename:string,readonly payer:string,private readonly clock:()=>number=Date.now){
  if(!/^0x[0-9a-f]{40}$/.test(payer))throw new Error('Canonical dedicated payer required');
  this.db=new Database(filename,{timeout:5000});
  if(filename!==':memory:')chmodSync(filename,0o600);
  this.db.pragma('journal_mode = WAL');this.db.pragma('synchronous = FULL');this.db.pragma('foreign_keys = ON');
  this.db.exec(SCHEMA);
  this.db.transaction(()=>{
   this.db.prepare('INSERT OR IGNORE INTO buyer_payer(id,address) VALUES(1,?)').run(payer);
   const saved=this.db.prepare('SELECT address FROM buyer_payer WHERE id=1').get() as {address:string};
   if(saved.address!==payer)throw new Error('Persistent buyer authority belongs to another payer');
  }).immediate();
  this.purge();
 }
 private immediate<T>(f:()=>T):T{return this.db.transaction(f).immediate();}
 private row(id:string,owner:string):Row {
  if(!buyerId(id)||! /^[a-f0-9]{64}$/.test(owner))throw new BuyerStoreError('NOT_FOUND');
  const row=this.db.prepare('SELECT * FROM buyer_jobs WHERE id=? AND owner_hash=?').get(id,owner) as Row|undefined;
  if(!row)throw new BuyerStoreError('NOT_FOUND');return row;
 }
 private exposure(now:number,includeId=''):bigint{
  const r=this.db.prepare('SELECT count(*) n FROM buyer_jobs WHERE reserved_at>=? OR signed_at>=? OR (id=? AND reserved_at IS NOT NULL)').get(dayStart(now),dayStart(now),includeId) as {n:number};
  return BigInt(r.n)*BigInt(BUYER.callUusdc);
 }
 create(plan:BuyerPlan,owner:string,network:string):BuyerPlan {
  const now=this.clock();validateBuyerPlan(plan,new Date(now));
  if(! /^[a-f0-9]{64}$/.test(owner)||! /^[a-f0-9]{64}$/.test(network))throw new Error('Hashed session/network required');
  return this.immediate(()=>{
   this.purgeInside(now);
   const rate=this.db.prepare('SELECT sum(owner_hash=?) visitor_n,sum(network_hash=?) network_n FROM buyer_jobs WHERE created_at>?').get(owner,network,now-60000) as {visitor_n:number;network_n:number};
   const pending=this.db.prepare("SELECT count(*) n FROM buyer_jobs WHERE state='planned'").get() as {n:number};
   if(rate.visitor_n>=10||rate.network_n>=100||pending.n>=1000)throw new BuyerStoreError('RATE_LIMIT');
   this.db.prepare("INSERT INTO buyer_jobs(id,owner_hash,network_hash,created_at,expires_at,plan,plan_hash,state) VALUES(?,?,?,?,?,?,?,'planned')").run(plan.id,owner,network,now,Date.parse(plan.expires_at),JSON.stringify(plan),plan.plan_hash);
   return structuredClone(plan);
  });
 }
 start(id:string,owner:string,expectedHash:string):{id:string;reused:boolean;plan:BuyerPlan;state:BuyerState}{
  return this.immediate(()=>{
   const now=this.clock();this.purgeInside(now);const row=this.row(id,owner);
   if(row.plan_hash!==expectedHash)throw new BuyerStoreError('TERMS_MISMATCH');
   if(row.state==='expired'||!row.plan||(row.reserved_at!==null&&now>=row.reserved_at+BUYER.payloadHours*3600000))throw new BuyerStoreError('EXPIRED');
   const plan=JSON.parse(row.plan) as BuyerPlan;
   validateBuyerPlan(plan,new Date(now),row.state!=='planned');
   if(row.state!=='planned')return {id,reused:true,plan,state:row.state};
   if(row.expires_at<=now)throw new BuyerStoreError('EXPIRED');
   const payer=this.db.prepare('SELECT blocked_until FROM buyer_payer WHERE id=1').get() as {blocked_until:number};
   if(payer.blocked_until>now)throw new BuyerStoreError('BUSY');
   if(this.exposure(now)+BigInt(BUYER.callUusdc)>BigInt(BUYER.dailyUusdc))throw new BuyerStoreError('DAILY_CAP');
   const retained=this.db.prepare("SELECT coalesce(sum(CASE WHEN state IN ('reserved','signing') THEN ? ELSE coalesce(length(CAST(result AS BLOB)),0)+coalesce(length(CAST(paid_body AS BLOB)),0)+coalesce(length(CAST(headers AS BLOB)),0)+320000+4096 END),0) bytes FROM buyer_jobs WHERE reserved_at>?").get(PER_JOB_STORAGE,now-BUYER.payloadHours*3600000) as {bytes:number};
   if(retained.bytes+PER_JOB_STORAGE>BUYER.maxRetainedBytes)throw new BuyerStoreError('STORAGE_CAP');
   this.db.prepare("UPDATE buyer_jobs SET state='reserved',reserved_at=? WHERE id=? AND state='planned'").run(now,id);
   this.db.prepare('UPDATE buyer_payer SET active_job=?,blocked_until=? WHERE id=1').run(id,now+BUYER.leaseSeconds*1000);
   return {id,reused:false,plan,state:'reserved'};
  });
 }
 beforeSign(id:string,notice:SigningCheckpoint):void {
  if(!buyerId(id)||notice.amount_uusdc!==BUYER.callUusdc||notice.payer.toLowerCase()!==this.payer||! /^[A-Za-z0-9:_-]{1,160}$/.test(notice.nonce)||!Number.isSafeInteger(notice.valid_before))throw new Error('Invalid signing checkpoint');
  this.immediate(()=>{
   const now=this.clock(),row=this.db.prepare('SELECT * FROM buyer_jobs WHERE id=?').get(id) as Row|undefined;
   const payer=this.db.prepare('SELECT active_job,blocked_until FROM buyer_payer WHERE id=1').get() as {active_job:string;blocked_until:number};
   if(!row||row.state!=='reserved'||row.plan_hash!==notice.plan_hash||!row.plan||payer.active_job!==id||payer.blocked_until<=now||notice.valid_before*1000<=now+2000||notice.valid_before*1000>now+120000)throw new BuyerStoreError('STATE_CHANGED');
   validateBuyerPlan(JSON.parse(row.plan),new Date(now));
   if(this.exposure(now,id)>BigInt(BUYER.dailyUusdc))throw new BuyerStoreError('DAILY_CAP');
   this.db.prepare("UPDATE buyer_jobs SET state='signing',signed_at=?,nonce=? WHERE id=?").run(now,notice.nonce,id);
   this.db.prepare('UPDATE buyer_payer SET blocked_until=? WHERE id=1 AND active_job=?').run(now+BUYER.leaseSeconds*1000,id);
  });
 }
 recordHeaders(id:string,headers:{status:number;receipt_header:string|null}):void {
  const text=JSON.stringify(headers);if(Buffer.byteLength(text)>16000||!Number.isInteger(headers.status)||headers.status<100||headers.status>599)throw new Error('Invalid response headers');
  const r=this.db.prepare("UPDATE buyer_jobs SET headers=? WHERE id=? AND state='signing' AND headers IS NULL").run(text,id);
  if(r.changes!==1)throw new BuyerStoreError('STATE_CHANGED');
 }
 recordPaidBody(id:string,body:{status:number;receipt_header:string|null;body_text:string}):void {
  const text=JSON.stringify(body);if(Buffer.byteLength(text)>2100000)throw new Error('Paid response exceeds bound');
  const r=this.db.prepare("UPDATE buyer_jobs SET paid_body=? WHERE id=? AND state='signing' AND headers IS NOT NULL AND paid_body IS NULL").run(text,id);
  if(r.changes!==1)throw new BuyerStoreError('STATE_CHANGED');
 }
 complete(id:string,result:{plan_hash:string;[key:string]:unknown}):void {
  const text=JSON.stringify(result);if(Buffer.byteLength(text)>BUYER.maxResultBytes)throw new Error('Evidence result exceeds bound');
  this.immediate(()=>{
   const row=this.db.prepare('SELECT plan_hash FROM buyer_jobs WHERE id=?').get(id) as {plan_hash:string}|undefined;
   if(!row||row.plan_hash!==result.plan_hash)throw new BuyerStoreError('TERMS_MISMATCH');
   const r=this.db.prepare("UPDATE buyer_jobs SET state='complete',result=? WHERE id=? AND state IN ('reserved','signing')").run(text,id);
   if(r.changes!==1)throw new BuyerStoreError('STATE_CHANGED');
   this.db.prepare('UPDATE buyer_payer SET active_job=NULL,blocked_until=0 WHERE id=1 AND active_job=?').run(id);
  });
 }
 uncertain(id:string):void {this.db.prepare("UPDATE buyer_jobs SET state='uncertain' WHERE id=? AND state IN ('reserved','signing')").run(id);}
 read(id:string,owner:string):{id:string;state:BuyerState;plan:BuyerPlan;expires_at:string;result:unknown;followups:unknown[]}|null {
  let row:Row;try{row=this.row(id,owner);}catch(error){if(error instanceof BuyerStoreError)return null;throw error;}
  const now=this.clock(),expires=row.reserved_at===null?row.expires_at:row.reserved_at+BUYER.payloadHours*3600000;
  if(!row.plan||row.state==='expired'||now>=expires)return null;
  const payer=this.db.prepare('SELECT active_job,blocked_until FROM buyer_payer WHERE id=1').get() as {active_job:string;blocked_until:number};
  const stale=['reserved','signing'].includes(row.state)&&(payer.active_job!==id||payer.blocked_until<=now);
  const followups=this.db.prepare('SELECT data FROM buyer_followups WHERE job_id=? ORDER BY observed_at DESC LIMIT 10').all(id) as {data:string}[];
  return {id,state:stale?'uncertain':row.state,plan:JSON.parse(row.plan),expires_at:new Date(expires).toISOString(),result:row.state==='complete'&&row.result?JSON.parse(row.result):null,followups:followups.map(x=>JSON.parse(x.data))};
 }
 addFollowup(id:string,owner:string,data:unknown):void {
  const text=JSON.stringify(data);if(Buffer.byteLength(text)>32000)throw new Error('Follow-up exceeds bound');
  this.immediate(()=>{
   const found=this.read(id,owner);if(!found||found.state!=='complete')throw new BuyerStoreError('NOT_FOUND');
   const now=this.clock(),last=this.db.prepare('SELECT max(observed_at) at FROM buyer_followups WHERE job_id=?').get(id) as {at:number|null};
   if(last.at!==null&&now-last.at<60000)throw new BuyerStoreError('RATE_LIMIT');
   this.db.prepare('INSERT INTO buyer_followups(job_id,observed_at,data) VALUES(?,?,?)').run(id,now,text);
   this.db.prepare('DELETE FROM buyer_followups WHERE job_id=? AND rowid NOT IN (SELECT rowid FROM buyer_followups WHERE job_id=? ORDER BY observed_at DESC LIMIT 10)').run(id,id);
  });
 }
 private purgeInside(now:number):void {
  this.db.prepare("DELETE FROM buyer_jobs WHERE (state='planned' AND expires_at<=?) OR coalesce(signed_at,reserved_at,created_at)<=?").run(now,now-BUYER.tombstoneHours*3600000);
  this.db.prepare('DELETE FROM buyer_followups WHERE job_id IN (SELECT id FROM buyer_jobs WHERE reserved_at<=?)').run(now-BUYER.payloadHours*3600000);
  this.db.prepare("UPDATE buyer_jobs SET owner_hash='',network_hash='',plan=NULL,headers=NULL,paid_body=NULL,result=NULL,state='expired' WHERE reserved_at<=? AND state!='expired'").run(now-BUYER.payloadHours*3600000);
 }
 purge():void {this.immediate(()=>this.purgeInside(this.clock()));}
 close():void {this.db.close();}
}
