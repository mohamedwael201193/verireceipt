// Real isolated PostgreSQL integration. Never uses DATABASE_URL or the live DB.
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VisitorJobStore } from '../src/visitor/store';
import { inspectVisitorJobs } from '../src/visitor/reconcile';
const LOCAL = `postgresql://${userInfo().username}@127.0.0.1:55439/postgres`;
const enabled = process.env.VISITOR_LOCAL_PG_TEST === '1';
const schema = 'visitor_' + randomUUID().replace(/-/g,'');
const url = LOCAL + '?options=' + encodeURIComponent('-c search_path=' + schema);
const input = { cik: '1318605', year: 2024, form: '10-Q' as const, minimum_count: 3 };
const id = () => randomUUID();
const hash = 'a'.repeat(64), network = 'b'.repeat(64);
const reservation = { plan_hash: 'c'.repeat(64), nonce: 'vr-research-real-reservation-test', reserved_uusdc: '10000' };
describe.skipIf(!enabled)('visitor reservations on real isolated PostgreSQL', () => {
  let admin: Pool, pool: Pool, store: VisitorJobStore;
  beforeAll(async () => { admin = new Pool({ connectionString: LOCAL }); await admin.query(`CREATE SCHEMA ${schema}`); pool = new Pool({ connectionString: url }); store = new VisitorJobStore(url); await store.init(); });
  beforeEach(async () => { await pool.query("TRUNCATE visitor_research_jobs; UPDATE visitor_research_payer SET active_job=NULL,blocked_until='-infinity'"); });
  afterAll(async () => { await store?.close(); await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  it('commits the exact money reservation before signing and persists across a new client', async () => {
    const job = await store.reserve(hash,network,id(),input);
    const second = new VisitorJobStore(url); const saved = await second.read(job.id,hash); expect(saved.state).toBe('reserved'); await second.close();
    const money = await pool.query('SELECT reserved_uusdc FROM visitor_research_jobs WHERE id=$1',[job.id]); expect(money.rows[0].reserved_uusdc).toBe('10000');
    await store.markSigned(job.id,reservation); expect((await store.read(job.id,hash)).state).toBe('signed');
  });
  it('captures one paid response privately before verification and never exposes it from read', async () => {
    const job = await store.reserve(hash,network,id(),input); await store.markSigned(job.id,reservation);
    await store.recordResponse(job.id,{ status:200,receiptHeader:'public-test-receipt-header',bodyText:'private-test-response-for-reconciliation' });
    await expect(store.recordResponse(job.id,{ status:200,receiptHeader:null,bodyText:'replacement' })).rejects.toThrow();
    const found = await store.read(job.id,hash); expect(found).not.toHaveProperty('private_response');
    expect((await pool.query('SELECT private_response FROM visitor_research_jobs WHERE id=$1',[job.id])).rows[0].private_response.bodyText).toBe('private-test-response-for-reconciliation');
  });
  it('captures paid headers independently of a failed or missing body',async()=>{
    const job=await store.reserve(hash,network,id(),input);await store.markSigned(job.id,reservation);
    await store.recordHeaders(job.id,{status:200,receiptHeader:'public-header-only'});await store.uncertain(job.id);
    const q=await pool.query('SELECT response_headers,private_response FROM visitor_research_jobs WHERE id=$1',[job.id]);expect(q.rows[0].response_headers.receiptHeader).toBe('public-header-only');expect(q.rows[0].private_response).toBeNull();
    expect(await store.read(job.id,hash)).not.toHaveProperty('response_headers');
  });
  it('operator inspection and hypothetical expiry preview are read-only and omit private input and body',async()=>{
    const job=await store.reserve(hash,network,id(),input);await store.markSigned(job.id,reservation);await store.recordHeaders(job.id,{status:200,receiptHeader:'public-test-header'});await store.uncertain(job.id);
    const c=await pool.connect();try{
      const report=await inspectVisitorJobs(c,job.id,{payloadDays:7,accountingDays:90});expect(report.read_only).toBe(true);expect(report.settlement_verified).toBe(false);expect(report.retention_preview?.erasure_performed).toBe(false);expect(report.jobs[0].receipt_header).toBe('public-test-header');expect(report.jobs[0]).not.toHaveProperty('input');expect(report.jobs[0]).not.toHaveProperty('visitor_hash');expect(report.jobs[0]).not.toHaveProperty('private_response');
      await expect(inspectVisitorJobs(c,undefined,{payloadDays:90,accountingDays:7})).rejects.toThrow();
    }finally{c.release();}
    expect((await store.read(job.id,hash)).state).toBe('uncertain');expect((await pool.query('SELECT reserved_uusdc FROM visitor_research_jobs WHERE id=$1',[job.id])).rows[0].reserved_uusdc).toBe('10000');
  });
  it('serializes two independent processes through a persisted payer lease', async () => {
    const second = new VisitorJobStore(url); await second.init();
    const jobs = await Promise.allSettled([store.reserve(hash,network,id(),input),second.reserve('d'.repeat(64),'e'.repeat(64),id(),input)]);
    expect(jobs.filter(x=>x.status==='fulfilled')).toHaveLength(1); expect(jobs.filter(x=>x.status==='rejected')).toHaveLength(1); await second.close();
    expect((await pool.query('SELECT count(*)::int n FROM visitor_research_jobs')).rows[0].n).toBe(1);
  });
  it('idempotent retry returns the existing job and does not reserve twice', async () => {
    const request = id(), a = await store.reserve(hash,network,request,input), b = await store.reserve(hash,network,request,input);
    expect(b).toEqual({ id:a.id,reused:true,spentBeforeUusdc:null }); expect((await pool.query('SELECT count(*)::int n FROM visitor_research_jobs')).rows[0].n).toBe(1);
    await expect(store.reserve(hash,network,request,{ ...input,minimum_count:4 })).rejects.toThrow('another input');
  });
  it('uncertain jobs retain reservation and block another purchase until the lease expires', async () => {
    const a = await store.reserve(hash,network,id(),input); await store.markSigned(a.id,reservation); await store.uncertain(a.id);
    expect((await store.read(a.id,hash)).state).toBe('uncertain'); await expect(store.reserve(hash,network,id(),input)).rejects.toThrow('BUSY');
    expect((await pool.query('SELECT sum(reserved_uusdc)::text total FROM visitor_research_jobs')).rows[0].total).toBe('10000');
  });
  it('a successfully persisted result unlocks the payer, but never refunds reserved money', async () => {
    const a = await store.reserve(hash,network,id(),input); await store.markSigned(a.id,reservation); await store.complete(a.id,{ result:{ status:'HOLD' } });
    expect((await store.read(a.id,hash)).state).toBe('complete'); const b = await store.reserve(hash,network,id(),input); expect(b.reused).toBe(false);
    expect((await pool.query('SELECT sum(reserved_uusdc)::text total FROM visitor_research_jobs')).rows[0].total).toBe('20000');
  });
  it('the daily cap includes uncertain reservations and fails closed at the limit', async () => {
    await pool.query("INSERT INTO visitor_research_jobs(id,request_id,visitor_hash,network_hash,input,reserved_uusdc,state) SELECT gen_random_uuid(),g::text,$1,$2,$3,10000,'uncertain' FROM generate_series(1,10000) g",[hash,network,JSON.stringify(input)]);
    // Age rows past the minute throttle while keeping their UTC-day reservations.
    await pool.query("UPDATE visitor_research_jobs SET created_at=clock_timestamp()-interval '2 minutes'");
    await expect(store.reserve(hash,network,id(),input)).rejects.toThrow('DAILY_CAP');
  });
  it('rate limit counts both visitor and network identity', async () => {
    await pool.query("INSERT INTO visitor_research_jobs(id,request_id,visitor_hash,network_hash,input,reserved_uusdc,state) SELECT gen_random_uuid(),g::text,$1,$2,$3,10000,'complete' FROM generate_series(1,10) g",[hash,network,JSON.stringify(input)]);
    await expect(store.reserve(hash,'f'.repeat(64),id(),input)).rejects.toThrow('RATE_LIMIT');
    await pool.query("INSERT INTO visitor_research_jobs(id,request_id,visitor_hash,network_hash,input,reserved_uusdc,state) SELECT gen_random_uuid(),g::text,$1,$2,$3,10000,'complete' FROM generate_series(11,100) g",['d'.repeat(64),network,JSON.stringify(input)]);
    await expect(store.reserve('f'.repeat(64),network,id(),input)).rejects.toThrow('RATE_LIMIT');
  });
  it('does not persist an oversized result or private paid response',async()=>{
    const a=await store.reserve(hash,network,id(),input);await store.markSigned(a.id,reservation);
    await expect(store.recordResponse(a.id,{status:200,receiptHeader:null,bodyText:'x'.repeat(2_100_001)})).rejects.toThrow();
    await expect(store.complete(a.id,{data:'x'.repeat(2_100_001)})).rejects.toThrow();
    expect((await store.read(a.id,hash)).state).toBe('signed');
  });
  it('extends the uncertainty lease at signing rather than job creation',async()=>{
    const a=await store.reserve(hash,network,id(),input);
    await pool.query("UPDATE visitor_research_payer SET blocked_until=clock_timestamp()+interval '1 second'");
    await store.markSigned(a.id,reservation);
    const q=await pool.query("SELECT extract(epoch from blocked_until-clock_timestamp()) seconds FROM visitor_research_payer WHERE id=1");
    expect(Number(q.rows[0].seconds)).toBeGreaterThan(175);
  });
  it('rechecks a previous UTC-day reservation against the signing-day cap',async()=>{
    const a=await store.reserve(hash,network,id(),input);
    await pool.query("UPDATE visitor_research_jobs SET created_at=clock_timestamp()-interval '1 day' WHERE id=$1",[a.id]);
    await pool.query("INSERT INTO visitor_research_jobs(id,request_id,visitor_hash,network_hash,input,reserved_uusdc,state) SELECT gen_random_uuid(),g::text,$1,$2,$3,10000,'uncertain' FROM generate_series(1,10000) g",[hash,network,JSON.stringify(input)]);
    await expect(store.markSigned(a.id,reservation)).rejects.toThrow('DAILY_CAP');
    expect((await store.read(a.id,hash)).state).toBe('reserved');
  });
  it('an expired reservation cannot sign and an unknown visitor cannot read the job', async () => {
    const a = await store.reserve(hash,network,id(),input); await pool.query("UPDATE visitor_research_payer SET blocked_until=clock_timestamp()-interval '1 second'");
    await expect(store.markSigned(a.id,reservation)).rejects.toThrow('unavailable'); expect(await store.read(a.id,'f'.repeat(64))).toBeNull();
  });
});

// Header capture precedes any body read; a missing body is still auditable.
