// Durable conservative reservations. This store never releases money reservations.
// A timeout/crash may have signed or charged, so capacity is not silently restored.
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { attachClientErrorGuard, pgPoolConfig } from '../core/pgStore';
import { VISITOR_LIMITS, type VisitorInput } from './policy';
const LOCK = 774922;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS visitor_research_jobs (
 id UUID PRIMARY KEY, request_id TEXT NOT NULL, visitor_hash TEXT NOT NULL,
 network_hash TEXT NOT NULL, input JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 reserved_uusdc BIGINT NOT NULL CHECK(reserved_uusdc=10000),
 state TEXT NOT NULL CHECK(state IN ('reserved','signed','complete','uncertain')),
 plan_hash TEXT, nonce TEXT, signed_at TIMESTAMPTZ, private_response JSONB, result JSONB,
 UNIQUE(visitor_hash,request_id)
);
ALTER TABLE visitor_research_jobs ADD COLUMN IF NOT EXISTS response_headers JSONB;
CREATE TABLE IF NOT EXISTS visitor_research_payer (
 id INTEGER PRIMARY KEY CHECK(id=1), active_job UUID,
 blocked_until TIMESTAMPTZ NOT NULL DEFAULT '-infinity'
);
CREATE INDEX IF NOT EXISTS visitor_jobs_created ON visitor_research_jobs(created_at);
CREATE INDEX IF NOT EXISTS visitor_jobs_signed ON visitor_research_jobs(signed_at);
INSERT INTO visitor_research_payer(id) VALUES(1) ON CONFLICT DO NOTHING;
`;
export class VisitorCapacityError extends Error { constructor(readonly code: 'BUSY'|'RATE_LIMIT'|'DAILY_CAP'|'STORAGE_CAP') { super(code); } }
export class VisitorJobStore {
  private readonly pool: Pool;
  private ready: Promise<void> | undefined;
  constructor(url: string) {
    if (!url) throw new Error('Hosted research requires Postgres');
    this.pool = new Pool({ ...pgPoolConfig(url), max: 2, application_name: 'verireceipt-visitor' });
    this.pool.on('error', () => {});
    this.pool.on('connect', c => attachClientErrorGuard(c, url));
  }
  async init(): Promise<void> {
    if (!this.ready) this.ready = this.transaction(async c => { await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]); await c.query(SCHEMA); }).catch(e => { this.ready = undefined; throw e; });
    await this.ready;
  }
  private async transaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect(); let destroy = false;
    try { await c.query('BEGIN'); const out = await work(c); await c.query('COMMIT'); return out; }
    catch (error) { try { await c.query('ROLLBACK'); } catch { destroy = true; } throw error; }
    finally { c.release(destroy); }
  }
  async reserve(visitor: string, network: string, request: string, input: VisitorInput) {
    await this.init();
    return this.transaction(async c => {
      await c.query('SELECT id FROM visitor_research_payer WHERE id=1 FOR UPDATE');
      const old = await c.query('SELECT id,input,state FROM visitor_research_jobs WHERE visitor_hash=$1 AND request_id=$2', [visitor,request]);
      if (old.rowCount) {
        if (JSON.stringify(old.rows[0].input) !== JSON.stringify(input)) {
          // JSONB key order differs from input order: compare canonical field values.
          if (Object.keys(input).some(k => old.rows[0].input[k] !== input[k as keyof VisitorInput])) throw new Error('Request id already used for another input');
        }
        return { id: old.rows[0].id as string, reused: true, spentBeforeUusdc: null };
      }
      const active = await c.query('SELECT blocked_until>clock_timestamp() AS blocked FROM visitor_research_payer WHERE id=1');
      if (active.rows[0].blocked) throw new VisitorCapacityError('BUSY');
      const rate = await c.query("SELECT count(*) FILTER(WHERE visitor_hash=$1)::int AS visitor_n, count(*) FILTER(WHERE network_hash=$2)::int AS network_n FROM visitor_research_jobs WHERE created_at>clock_timestamp()-interval '1 minute' AND (visitor_hash=$1 OR network_hash=$2)", [visitor,network]);
      if (rate.rows[0].visitor_n >= VISITOR_LIMITS.requestsPerMinute || rate.rows[0].network_n >= VISITOR_LIMITS.networkRequestsPerMinute) throw new VisitorCapacityError('RATE_LIMIT');
      const spent = await c.query("SELECT coalesce(sum(reserved_uusdc),0)::text AS total FROM visitor_research_jobs WHERE created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' OR signed_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
      if (BigInt(spent.rows[0].total)+VISITOR_LIMITS.perCallUusdc > VISITOR_LIMITS.dailyUusdc) throw new VisitorCapacityError('DAILY_CAP');
      const storage = await c.query("SELECT coalesce(sum(octet_length(coalesce(private_response::text,''))+octet_length(coalesce(result::text,''))),0)::text total FROM visitor_research_jobs WHERE created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
      if (Number(storage.rows[0].total)+VISITOR_LIMITS.maxJobStoredBytes>VISITOR_LIMITS.dailyStoredBytes) throw new VisitorCapacityError('STORAGE_CAP');
      const id = randomUUID();
      await c.query("INSERT INTO visitor_research_jobs(id,request_id,visitor_hash,network_hash,input,reserved_uusdc,state) VALUES($1,$2,$3,$4,$5,10000,'reserved')", [id,request,visitor,network,JSON.stringify(input)]);
      await c.query("UPDATE visitor_research_payer SET active_job=$1,blocked_until=clock_timestamp()+$2*interval '1 second' WHERE id=1", [id,VISITOR_LIMITS.uncertainLeaseSeconds]);
      return { id, reused: false, spentBeforeUusdc: spent.rows[0].total as string };
    });
  }
  async markSigned(id: string, reservation: { plan_hash: string; nonce: string; reserved_uusdc: string }): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(reservation.plan_hash) || reservation.reserved_uusdc !== '10000' || reservation.nonce.length > 160) throw new Error('Invalid reservation');
    await this.transaction(async c => {
      await c.query('SELECT id FROM visitor_research_payer WHERE id=1 FOR UPDATE');
      // A queued challenge can cross midnight. Count yesterday's reservation
      // again on its actual signing day rather than bypassing today's cap.
      const spent = await c.query("SELECT coalesce(sum(reserved_uusdc),0)::text total FROM visitor_research_jobs WHERE id=$1 OR created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' OR signed_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[id]);
      if (BigInt(spent.rows[0].total)>VISITOR_LIMITS.dailyUusdc) throw new VisitorCapacityError('DAILY_CAP');
      const r = await c.query("UPDATE visitor_research_jobs SET state='signed',plan_hash=$2,nonce=$3,signed_at=clock_timestamp() WHERE id=$1 AND state='reserved' AND EXISTS(SELECT 1 FROM visitor_research_payer WHERE id=1 AND active_job=$1::uuid AND blocked_until>clock_timestamp())", [id,reservation.plan_hash,reservation.nonce]);
      if (r.rowCount !== 1) throw new Error('Durable signing reservation unavailable');
      // The challenge can arrive late. Start the uncertainty window at signing,
      // not at job creation, and hold beyond the protocol's 120-second auth bound.
      await c.query("UPDATE visitor_research_payer SET blocked_until=clock_timestamp()+$2*interval '1 second' WHERE id=1 AND active_job=$1::uuid",[id,VISITOR_LIMITS.uncertainLeaseSeconds]);
    });
  }

  async recordHeaders(id: string, response: { status: number; receiptHeader: string | null }): Promise<void> {
    const serialized = JSON.stringify(response);
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || Buffer.byteLength(serialized) > 16000) throw new Error('Invalid paid response headers');
    const r = await this.pool.query("UPDATE visitor_research_jobs SET response_headers=$2 WHERE id=$1 AND state='signed' AND response_headers IS NULL", [id,serialized]);
    if (r.rowCount !== 1) throw new Error('Paid response headers could not be recorded');
  }
  async recordResponse(id: string, response: { status: number; receiptHeader: string | null; bodyText: string }): Promise<void> {
    const serialized = JSON.stringify(response);
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || Buffer.byteLength(serialized) > 2_100_000) throw new Error('Invalid paid response');
    const r = await this.pool.query("UPDATE visitor_research_jobs SET private_response=$2 WHERE id=$1 AND state='signed' AND private_response IS NULL AND octet_length($2::jsonb::text)<=2100000",[id,serialized]);
    if (r.rowCount !== 1) throw new Error('Paid response could not be recorded');
  }
  async complete(id: string, result: unknown): Promise<void> {
    await this.transaction(async c => {
      // Match reserve/markSigned lock order to avoid a payer/job deadlock.
      await c.query('SELECT id FROM visitor_research_payer WHERE id=1 FOR UPDATE');
      const r = await c.query("UPDATE visitor_research_jobs SET state='complete',result=$2 WHERE id=$1 AND state='signed' AND octet_length($2::jsonb::text)<=2100000", [id,JSON.stringify(result)]);
      if (r.rowCount !== 1) throw new Error('Job state changed');
      await c.query("UPDATE visitor_research_payer SET active_job=NULL,blocked_until='-infinity' WHERE id=1 AND active_job=$1::uuid", [id]);
    });
  }
  async uncertain(id: string): Promise<void> {
    await this.pool.query("UPDATE visitor_research_jobs SET state='uncertain' WHERE id=$1 AND state IN ('reserved','signed')",[id]);
    // Do not release the payer lock early or refund the daily reservation.
  }
  async read(id: string, visitor: string) {
    await this.init();
    const r = await this.pool.query('SELECT j.id,j.state,j.created_at,j.signed_at,j.result, EXISTS(SELECT 1 FROM visitor_research_payer p WHERE p.id=1 AND p.active_job=j.id AND p.blocked_until>clock_timestamp()) AS lease_active FROM visitor_research_jobs j WHERE j.id=$1 AND j.visitor_hash=$2',[id,visitor]);
    return r.rows[0] ?? null;
  }
  async close(): Promise<void> { await this.pool.end(); }
}
