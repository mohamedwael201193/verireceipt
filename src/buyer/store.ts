// One persistent SQLite authority for one dedicated hosted payer on one host.
// WAL + FULL synchronous + IMMEDIATE transactions serialize every worker.
// Never use separate files/replicas or another purchasing client for this payer.
import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
import { BUYER, buyerId, validateBuyerPlan, type BuyerPlan } from './contracts';
export type BuyerState='planned'|'reserved'|'signing'|'complete'|'uncertain'|'expired';
export class BuyerStoreError extends Error {constructor(readonly code:'NOT_FOUND'|'EXPIRED'|'BUSY'|'RATE_LIMIT'|'DAILY_CAP'|'STORAGE_CAP'|'TERMS_MISMATCH'|'STATE_CHANGED'|'OPERATOR_REQUIRED'|'ONE_SHOT_REQUIRED'){super(code);}}
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
CREATE TABLE IF NOT EXISTS buyer_one_shot(id INTEGER PRIMARY KEY CHECK(id=1),access_hash TEXT NOT NULL,access_expires INTEGER NOT NULL,closed INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'unarmed' CHECK(state IN ('unarmed','armed','consumed','disarmed')),plan_id TEXT,plan_hash TEXT,owner_hash TEXT,arm_expires INTEGER,ceiling TEXT,consumed_at INTEGER);
CREATE TABLE IF NOT EXISTS buyer_operator_sessions(owner_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS buyer_jobs_reserved ON buyer_jobs(reserved_at);
CREATE INDEX IF NOT EXISTS buyer_jobs_created ON buyer_jobs(created_at);
CREATE TABLE IF NOT EXISTS buyer_lifetime(id INTEGER PRIMARY KEY CHECK(id=1),reservation_history TEXT NOT NULL CHECK(reservation_history IN ('never_reserved','reserved','unknown')));
CREATE TABLE IF NOT EXISTS buyer_followups(job_id TEXT NOT NULL REFERENCES buyer_jobs(id) ON DELETE CASCADE,observed_at INTEGER NOT NULL,data TEXT NOT NULL);
`;
function proofJobIds():string[]{
 const ids=[...new Set((process.env.BUYER_PROOF_JOB_IDS??'').split(',').map(x=>x.trim()).filter(Boolean))];
 if(ids.length>64||ids.some(id=>! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))throw Error('Invalid BUYER_PROOF_JOB_IDS operator configuration');
 return ids;
}
const DAY=86400000,PER_JOB_STORAGE=BUYER.maxResultBytes+2100000+16000+320000+4096;
const dayStart=(ms:number)=>Math.floor(ms/DAY)*DAY;
export class BuyerStore {
 private readonly db:Database.Database;
 constructor(filename:string,readonly payer:string,private readonly clock:()=>number=Date.now){
  if(!/^0x[0-9a-f]{40}$/.test(payer))throw new Error('Canonical dedicated payer required');
  this.db=new Database(filename,{timeout:5000});
  if(filename!==':memory:')chmodSync(filename,0o600);
  this.db.pragma('journal_mode = WAL');this.db.pragma('synchronous = FULL');this.db.pragma('foreign_keys = ON');
  this.db.transaction(()=>{
   const existed=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='buyer_payer'").get();
   this.db.exec(SCHEMA);
   this.db.prepare('INSERT OR IGNORE INTO buyer_lifetime(id,reservation_history) VALUES(1,?)').run(existed?'unknown':'never_reserved');
   this.db.prepare('INSERT OR IGNORE INTO buyer_payer(id,address) VALUES(1,?)').run(payer);
   const saved=this.db.prepare('SELECT address FROM buyer_payer WHERE id=1').get() as {address:string};
   if(saved.address!==payer)throw new Error('Persistent buyer authority belongs to another payer');
  }).immediate();
  this.purge();
 }
 /** Irreversible mode selection for this payer database. No HTTP route can arm it. */
 requireOneShot(accessHash:string,expiresAt:number):void {
  if(!/^[a-f0-9]{64}$/.test(accessHash)||!Number.isSafeInteger(expiresAt))throw new Error('Operator access hash and expiry required');
  this.immediate(()=>{
   const saved=this.db.prepare('SELECT access_hash,access_expires FROM buyer_one_shot WHERE id=1').get() as {access_hash:string;access_expires:number}|undefined;
   if(saved){if(this.lifetimeHistory()==='unknown'&& !['consumed','disarmed'].includes(this.gate()!.state))throw new Error('One-shot mode requires an unused payer authority with known history');if(saved.access_hash!==accessHash||saved.access_expires!==expiresAt)throw new Error('One-shot access configuration is immutable');return;}
   const now=this.clock();if(expiresAt<=now||expiresAt>now+3600000)throw new Error('Initial operator access window must be within one hour');
   if((this.db.prepare('SELECT reservation_history history FROM buyer_lifetime WHERE id=1').get() as {history:string}|undefined)?.history!=='never_reserved')throw new Error('One-shot mode requires an unused payer authority');
   this.db.prepare('INSERT INTO buyer_one_shot(id,access_hash,access_expires) VALUES(1,?,?)').run(accessHash,expiresAt);
  });
 }
 authorizeOperator(owner:string,credential:string):void {
  if(!/^[a-f0-9]{64}$/.test(owner)||!/^[a-f0-9]{64}$/.test(credential))throw new BuyerStoreError('OPERATOR_REQUIRED');
  const actual=createHash('sha256').update(credential).digest();
  this.immediate(()=>{const gate=this.gate();if(!gate||gate.closed||gate.state==='consumed'||gate.state==='disarmed'||gate.access_expires<=this.clock()||!timingSafeEqual(actual,Buffer.from(gate.access_hash,'hex')))throw new BuyerStoreError('OPERATOR_REQUIRED');
   if(!this.isOperator(owner)&&(this.db.prepare('SELECT count(*) n FROM buyer_operator_sessions').get() as {n:number}).n>=10)throw new BuyerStoreError('RATE_LIMIT');
   this.db.prepare('INSERT INTO buyer_operator_sessions(owner_hash,expires_at) VALUES(?,?) ON CONFLICT(owner_hash) DO UPDATE SET expires_at=excluded.expires_at').run(owner,this.clock()+86400000);
  });
 }
 isOperator(owner:string):boolean {return !!this.db.prepare('SELECT 1 FROM buyer_operator_sessions WHERE owner_hash=? AND expires_at>?').get(owner,this.clock());}
 private lifetimeHistory():string {return (this.db.prepare('SELECT reservation_history history FROM buyer_lifetime WHERE id=1').get() as {history:string}|undefined)?.history??'unknown';}
 private gate():{access_hash:string;access_expires:number;closed:number;state:'unarmed'|'armed'|'consumed'|'disarmed';plan_id:string|null;plan_hash:string|null;owner_hash:string|null;arm_expires:number;ceiling:string|null;consumed_at:number|null}|undefined {return this.db.prepare('SELECT * FROM buyer_one_shot WHERE id=1').get() as ReturnType<BuyerStore['gate']>;}
 private requireOperator(owner:string):void {const gate=this.gate();if(gate&&(!this.isOperator(owner)||gate.closed||gate.access_expires<=this.clock()||gate.state==='consumed'||gate.state==='disarmed'))throw new BuyerStoreError('OPERATOR_REQUIRED');}
 armOneShot(id:string,expectedHash:string,expiresAt:number,ceiling:string):void {
  this.immediate(()=>{const now=this.clock(),gate=this.gate();if(!gate||gate.closed||gate.state!=='unarmed'||gate.access_expires<=now||ceiling!==BUYER.callUusdc||!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>gate.access_expires)throw new BuyerStoreError('ONE_SHOT_REQUIRED');
   const row=this.db.prepare('SELECT * FROM buyer_jobs WHERE id=?').get(id) as Row|undefined;
   if(!row||row.state!=='planned'||!row.plan||row.plan_hash!==expectedHash||expiresAt>row.expires_at||!this.isOperator(row.owner_hash))throw new BuyerStoreError('ONE_SHOT_REQUIRED');
   validateBuyerPlan(JSON.parse(row.plan),new Date(now));
   this.db.prepare("UPDATE buyer_one_shot SET state='armed',plan_id=?,plan_hash=?,owner_hash=?,arm_expires=?,ceiling=? WHERE id=1").run(id,expectedHash,row.owner_hash,expiresAt,ceiling);
  });
 }
 closePurchases():void {this.immediate(()=>{if(!this.gate())throw new BuyerStoreError('ONE_SHOT_REQUIRED');this.db.prepare("UPDATE buyer_one_shot SET closed=1,state=CASE WHEN state='consumed' THEN state ELSE 'disarmed' END WHERE id=1").run();});}
 oneShotStatus():{state:string;closed:boolean;expires_at:number;plan_id:string|null;plan_hash:string|null}|null {const g=this.gate();return g?{state:g.state,closed:!!g.closed,expires_at:g.arm_expires??g.access_expires,plan_id:g.plan_id,plan_hash:g.plan_hash}:null;}
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
   this.purgeInside(now);this.requireOperator(owner);
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
   if(row.state!=='planned'){this.db.prepare('UPDATE buyer_operator_sessions SET expires_at=max(expires_at,?) WHERE owner_hash=?').run((row.reserved_at??now)+86400000,owner);return {id,reused:true,plan,state:row.state};}
   this.requireOperator(owner);
   const gate=this.gate();if(gate&&(this.lifetimeHistory()!=='never_reserved'||!this.isOperator(owner)||gate.closed||gate.state!=='armed'||gate.plan_id!==id||gate.plan_hash!==expectedHash||gate.owner_hash!==owner||gate.arm_expires<=now||gate.access_expires<=now||gate.ceiling!==BUYER.callUusdc))throw new BuyerStoreError('ONE_SHOT_REQUIRED');
   if(row.expires_at<=now)throw new BuyerStoreError('EXPIRED');
   const payer=this.db.prepare('SELECT blocked_until FROM buyer_payer WHERE id=1').get() as {blocked_until:number};
   if(payer.blocked_until>now)throw new BuyerStoreError('BUSY');
   if(this.exposure(now)+BigInt(BUYER.callUusdc)>BigInt(BUYER.dailyUusdc))throw new BuyerStoreError('DAILY_CAP');
   const retained=this.db.prepare("SELECT coalesce(sum(CASE WHEN state IN ('reserved','signing') THEN ? ELSE coalesce(length(CAST(result AS BLOB)),0)+coalesce(length(CAST(paid_body AS BLOB)),0)+coalesce(length(CAST(headers AS BLOB)),0)+320000+4096 END),0) bytes FROM buyer_jobs WHERE reserved_at>?").get(PER_JOB_STORAGE,now-BUYER.payloadHours*3600000) as {bytes:number};
   if(retained.bytes+PER_JOB_STORAGE>BUYER.maxRetainedBytes)throw new BuyerStoreError('STORAGE_CAP');
   this.db.prepare("UPDATE buyer_lifetime SET reservation_history='reserved' WHERE id=1").run();
   if(gate)this.db.prepare('UPDATE buyer_operator_sessions SET expires_at=max(expires_at,?) WHERE owner_hash=?').run(now+86400000,owner);
   if(gate)this.db.prepare("UPDATE buyer_one_shot SET state='consumed',consumed_at=? WHERE id=1 AND state='armed'").run(now);
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
   const gate=this.gate();if(gate&&(this.lifetimeHistory()!=='reserved'||gate.closed||gate.state!=='consumed'||gate.plan_id!==id||gate.plan_hash!==notice.plan_hash||gate.owner_hash!==row?.owner_hash||gate.arm_expires<=now||gate.access_expires<=now||notice.valid_before*1000>Math.min(gate.arm_expires,gate.access_expires)||gate.ceiling!==notice.amount_uusdc))throw new BuyerStoreError('ONE_SHOT_REQUIRED');
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
 uncertain(id:string,result?:{plan_hash:string;[key:string]:unknown}):void {
  if(!result){this.db.prepare("UPDATE buyer_jobs SET state='uncertain' WHERE id=? AND state IN ('reserved','signing')").run(id);return;}
  const text=JSON.stringify(result);if(Buffer.byteLength(text)>BUYER.maxResultBytes)throw new Error('Evidence result exceeds bound');
  const r=this.db.prepare("UPDATE buyer_jobs SET state='uncertain',result=? WHERE id=? AND plan_hash=? AND state IN ('reserved','signing')").run(text,id,result.plan_hash);if(r.changes!==1)throw new BuyerStoreError('STATE_CHANGED');
 }
 read(id:string,owner:string):{id:string;state:BuyerState;plan:BuyerPlan;expires_at:string;result:unknown;followups:unknown[]}|null {
  let row:Row;try{row=this.row(id,owner);}catch(error){if(error instanceof BuyerStoreError)return null;throw error;}
  const now=this.clock(),expires=row.reserved_at===null?row.expires_at:row.reserved_at+BUYER.payloadHours*3600000;
  const proof=row.state==='complete'&&proofJobIds().includes(id);
  if(!row.plan||row.state==='expired'||(!proof&&now>=expires))return null;
  const payer=this.db.prepare('SELECT active_job,blocked_until FROM buyer_payer WHERE id=1').get() as {active_job:string;blocked_until:number};
  const stale=['reserved','signing'].includes(row.state)&&(payer.active_job!==id||payer.blocked_until<=now);
  const followups=this.db.prepare('SELECT data FROM buyer_followups WHERE job_id=? ORDER BY observed_at DESC LIMIT 10').all(id) as {data:string}[];
  return {id,state:stale?'uncertain':row.state,plan:JSON.parse(row.plan),expires_at:new Date(expires).toISOString(),result:row.result?JSON.parse(row.result):null,followups:followups.map(x=>JSON.parse(x.data))};
 }
 evidence(id:string,owner:string):unknown {
  const job=this.read(id,owner);if(!job)return null;const row=this.row(id,owner);return {...job,public_response_headers:row.headers?JSON.parse(row.headers):null,paid_response:row.paid_body?JSON.parse(row.paid_body):null};
 }
 finishFollowup(id:string,owner:string,token:number,data:unknown):void {
  if(!this.read(id,owner))throw new BuyerStoreError('NOT_FOUND');const text=JSON.stringify(data);if(Buffer.byteLength(text)>32000)throw new Error('Follow-up exceeds bound');
  const r=this.db.prepare('UPDATE buyer_followups SET data=? WHERE job_id=? AND observed_at=?').run(text,id,token);if(r.changes!==1)throw new BuyerStoreError('STATE_CHANGED');
 }
 addFollowup(id:string,owner:string,data:unknown):number {
  const text=JSON.stringify(data);if(Buffer.byteLength(text)>32000)throw new Error('Follow-up exceeds bound');
  return this.immediate(()=>{
   const found=this.read(id,owner);if(!found||found.state!=='complete')throw new BuyerStoreError('NOT_FOUND');
   const now=this.clock(),last=this.db.prepare('SELECT max(observed_at) at FROM buyer_followups WHERE job_id=?').get(id) as {at:number|null};
   if(last.at!==null&&now-last.at<60000)throw new BuyerStoreError('RATE_LIMIT');
   this.db.prepare('INSERT INTO buyer_followups(job_id,observed_at,data) VALUES(?,?,?)').run(id,now,text);
   this.db.prepare('DELETE FROM buyer_followups WHERE job_id=? AND rowid NOT IN (SELECT rowid FROM buyer_followups WHERE job_id=? ORDER BY observed_at DESC LIMIT 10)').run(id,id);return now;
  });
 }
 private purgeInside(now:number):void {
  this.db.prepare('DELETE FROM buyer_operator_sessions WHERE expires_at<=?').run(now);
  // Keep only the permanent spent/disarmed bit after normal 48-hour retention.
  this.db.prepare("UPDATE buyer_one_shot SET plan_id=NULL,plan_hash=NULL,owner_hash=NULL WHERE state IN ('consumed','disarmed') AND coalesce(consumed_at,arm_expires,access_expires)<=?").run(now-BUYER.tombstoneHours*3600000);
  const pins=JSON.stringify((this.db.prepare("SELECT id FROM buyer_jobs WHERE state='complete' AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(proofJobIds())) as {id:string}[]).map(r=>r.id));
  this.db.prepare("DELETE FROM buyer_jobs WHERE id NOT IN (SELECT value FROM json_each(?)) AND ((state='planned' AND expires_at<=?) OR coalesce(signed_at,reserved_at,created_at)<=?)").run(pins,now,now-BUYER.tombstoneHours*3600000);
  this.db.prepare('DELETE FROM buyer_followups WHERE job_id IN (SELECT id FROM buyer_jobs WHERE reserved_at<=? AND id NOT IN (SELECT value FROM json_each(?)))').run(now-BUYER.payloadHours*3600000,pins);
  this.db.prepare("UPDATE buyer_jobs SET owner_hash='',network_hash='',plan=NULL,headers=NULL,paid_body=NULL,result=NULL,state='expired' WHERE reserved_at<=? AND state!='expired' AND id NOT IN (SELECT value FROM json_each(?))").run(now-BUYER.payloadHours*3600000,pins);
 }
 purge():void {this.immediate(()=>this.purgeInside(this.clock()));}
 close():void {this.db.close();}
}
