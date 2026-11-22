// API tests use a real local PostgreSQL store and an explicitly injected no-payment
// runtime. This verifies HTTP authorization/accounting, not a real paid experiment.
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerVisitorResearch, type VisitorRuntime } from '../src/visitor/routes';
import { VisitorJobStore } from '../src/visitor/store';
const enabled = process.env.VISITOR_LOCAL_PG_TEST === '1';
const local = `postgresql://${userInfo().username}@127.0.0.1:55439/postgres`;
const schema = 'api_' + randomUUID().replace(/-/g,'');
const url = local + '?options=' + encodeURIComponent('-c search_path=' + schema);
const input = { cik:'1318605',year:2024,form:'10-Q',minimum_count:3 };
const cookie = 'vr_research=' + 'a'.repeat(64);
const headers = () => ({ origin:'https://verireceipt.vercel.app',cookie,'idempotency-key':randomUUID() });
describe.skipIf(!enabled)('hosted API with real isolated PostgreSQL, no-payment test runtime', () => {
  let admin:Pool, pool:Pool, app:FastifyInstance, store:VisitorJobStore;
  const runtime = vi.fn<VisitorRuntime>();
  beforeAll(async () => { admin = new Pool({connectionString:local}); await admin.query(`CREATE SCHEMA ${schema}`); pool = new Pool({connectionString:url}); });
  beforeEach(async () => {
    if (app) await app.close();
    store = new VisitorJobStore(url); await store.init();
    await pool.query("TRUNCATE visitor_research_jobs; UPDATE visitor_research_payer SET active_job=NULL,blocked_until='-infinity'");
    runtime.mockReset(); runtime.mockImplementation(async (_input,opts) => {
      const saved = await pool.query("SELECT state FROM visitor_research_jobs"); expect(saved.rows[0].state).toBe('reserved');
      await opts.beforeSign({ plan_hash:'c'.repeat(64),at:new Date().toISOString(),reserved_uusdc:'10000',nonce:'test-only-not-a-paid-purchase' });
      return { version:'test-runtime-only',result:{status:'HOLD'},receipt:null };
    });
    app = Fastify(); registerVisitorResearch(app,{enabled:true,store,runtime});
  });
  afterAll(async () => { await app?.close(); await pool?.end(); if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();} });
  const post = (extra:Record<string,unknown> = {}, h = headers()) => app.inject({method:'POST',url:'/v1/research/jobs',headers:h,payload:{...input,...extra}});
  it('is absent when feature disabled and never creates a payment runtime', async () => {
    const off = Fastify(); registerVisitorResearch(off,{enabled:false,runtime}); expect((await off.inject({method:'POST',url:'/v1/research/jobs',payload:input})).statusCode).toBe(404); expect(runtime).not.toHaveBeenCalled(); await off.close();
  });
  it('bootstrap creates only a secure session cookie, never a job or purchase', async () => {
    const r = await app.inject({url:'/v1/research/session'}); expect(r.statusCode).toBe(200); expect(r.headers['set-cookie']).toMatch(/HttpOnly; Secure; SameSite=Strict/); expect(r.headers['cache-control']).toBe('no-store'); expect(runtime).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::int n FROM visitor_research_jobs')).rows[0].n).toBe(0);
  });
  it('refuses foreign or missing origin before reserving or running', async () => {
    const h=headers(); delete (h as Partial<typeof h>).origin; expect((await post({},h)).statusCode).toBe(403); h.origin='https://outside.invalid'; expect((await post({},h)).statusCode).toBe(403); expect(runtime).not.toHaveBeenCalled();
  });
  it('requires an existing session cookie before a chargeable request', async () => { const h=headers(); delete (h as Partial<typeof h>).cookie; expect((await post({},h)).statusCode).toBe(428); expect(runtime).not.toHaveBeenCalled(); });
  it.each([{key:'unrelated'},{network:'mainnet'},{miner:'other'},{cik:'Tesla'},{year:new Date().getUTCFullYear()},{minimum_count:0},{form:'10-Q/A'}])('refuses noncanonical or unauthorized input %j', async extra => { expect((await post(extra)).statusCode).toBe(400); expect(runtime).not.toHaveBeenCalled(); });
  it('enforces the 2KB HTTP body ceiling',async()=>{expect((await post({payload:'x'.repeat(3000)})).statusCode).toBe(413);expect(runtime).not.toHaveBeenCalled();});
  it('idempotency preserves one reservation and one execution',async()=>{
    const h=headers(),first=await post({},h);expect(first.statusCode).toBe(202);const id=first.json().job_id;
    await vi.waitFor(async()=>expect((await store.read(id,'e'.repeat(64)))??null).toBeNull());
    await vi.waitFor(()=>expect(runtime).toHaveBeenCalledTimes(1));
    const again=await post({},h);expect(again.json().job_id).toBe(id);expect(again.json().reused).toBe(true);expect(runtime).toHaveBeenCalledTimes(1);
    await vi.waitFor(async()=>{const r=await app.inject({url:'/v1/research/jobs/'+id,headers:{cookie}});expect(r.json().state).toBe('complete');expect(r.json().result.version).toBe('test-runtime-only');});
  });
  it('another visitor cannot retrieve a job or result',async()=>{const r=await post();const id=r.json().job_id;expect((await app.inject({url:'/v1/research/jobs/'+id,headers:{cookie:'vr_research='+'b'.repeat(64)}})).statusCode).toBe(404);});
  it('shutdown aborts an active request without refunding or retrying it',async()=>{
    runtime.mockImplementationOnce(async(_input,opts)=>new Promise((_resolve,reject)=>{
      opts.signal.addEventListener('abort',()=>reject(new Error('shutdown')),{once:true});
    }));
    const r=await post(); expect(r.statusCode).toBe(202);
    await vi.waitFor(()=>expect(runtime).toHaveBeenCalledOnce());
    await app.close();
    expect((await pool.query('SELECT state,reserved_uusdc FROM visitor_research_jobs WHERE id=$1',[r.json().job_id])).rows[0]).toEqual({ state:'uncertain',reserved_uusdc:'10000' });
    expect(runtime).toHaveBeenCalledOnce();
  });
  it('errors are uncertain with no paid retry, leaked error or wallet details',async()=>{
    runtime.mockRejectedValueOnce(new Error('private runtime error must not leave server'));
    const r=await post(),id=r.json().job_id;
    await vi.waitFor(async()=>{const found=await app.inject({url:'/v1/research/jobs/'+id,headers:{cookie}});expect(found.json().state).toBe('uncertain');expect(found.body).not.toContain('private runtime');expect(found.json().result).toBeNull();});
    expect((await post()).statusCode).toBe(429);expect(runtime).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT sum(reserved_uusdc)::text n FROM visitor_research_jobs')).rows[0].n).toBe('10000');
  });
});
