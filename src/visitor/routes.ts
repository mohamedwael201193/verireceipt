// Additive hosted API. Mounting this module is inert unless VISITOR_RESEARCH_ENABLED=1.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { VisitorCapacityError, VisitorJobStore } from './store';
import { validateRequestId, validateVisitorInput, visitorHash, VISITOR_LIMITS, type VisitorInput } from './policy';
interface RuntimeOptions {
  spentTodayUusdc: string; dailyCapUusdc: string; reserveUusdc: string; signal: AbortSignal;
  recordResponse: (r: { status: number; receiptHeader: string | null; bodyText: string }) => Promise<void>;
  beforeSign: (r: { plan_hash: string; at: string; reserved_uusdc: string; nonce: string }) => Promise<void>;
}
export type VisitorRuntime = (input: VisitorInput, options: RuntimeOptions) => Promise<unknown>;
function token(request: FastifyRequest): string | null {
  const found = /(?:^|;\s*)vr_research=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '');
  return found?.[1] ?? null;
}
function loadRuntime(): VisitorRuntime {
  // A fixed operator-built module, never a request-controlled path.
  const module = require(join(__dirname, '..', 'visitor-runtime.cjs')) as { executeVisitorResearch: VisitorRuntime; assertVisitorConfiguration: () => void };
  module.assertVisitorConfiguration();
  return module.executeVisitorResearch;
}
export function registerVisitorResearch(app: FastifyInstance, options: { runtime?: VisitorRuntime; store?: VisitorJobStore; enabled?: boolean } = {}): void {
  const enabled = options.enabled ?? process.env.VISITOR_RESEARCH_ENABLED === '1';
  if (!enabled) return;
  const url = process.env.DATABASE_URL;
  if (!options.store && !url) throw new Error('Hosted research requires Postgres');
  const runtime = options.runtime ?? loadRuntime();
  const store = options.store ?? new VisitorJobStore(url!);
  app.addHook('onReady',async () => { await store.init(); });
  const active = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let stopping = false;
  app.addHook('onClose', async () => {
    stopping = true;
    for (const controller of controllers) controller.abort();
    // Closing does not retry or refund unfinished jobs. Their durable lease expires.
    await Promise.allSettled([...active]);
    await store.close();
  });
  app.get('/v1/research/status', async (_request, reply) => {
    reply.header('Cache-Control','no-store');
    return { enabled: true, network: VISITOR_LIMITS.network, call_uusdc: '10000', hosted_daily_cap_uusdc: VISITOR_LIMITS.dailyUusdc.toString(), visitor_daily_limit: null,
      per_visitor_requests_per_minute: VISITOR_LIMITS.requestsPerMinute, per_network_requests_per_minute:VISITOR_LIMITS.networkRequestsPerMinute, maximum_active_hosted_purchases: 1, maximum_daily_stored_bytes:VISITOR_LIMITS.dailyStoredBytes, source: 'Own operator-sponsored Sepolia testnet purchases, not independent adoption or ranked routing' };
  });
  app.get('/v1/research/session', async (request, reply) => {
    reply.header('Cache-Control','no-store');
    if (!token(request)) reply.header('Set-Cookie',`vr_research=${randomBytes(32).toString('hex')}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`);
    return { ready: true, network: VISITOR_LIMITS.network, sponsored: true, call_uusdc: '10000' };
  });
  app.post('/v1/research/jobs', { bodyLimit: VISITOR_LIMITS.maxBodyBytes }, async (request, reply) => {
    reply.header('Cache-Control','no-store');
    if (stopping) return reply.status(503).send({ status:'HOLD',code:'SERVICE_STOPPING' });
    // This endpoint is deliberately for the production UI only, not arbitrary origins.
    if (request.headers.origin !== 'https://verireceipt.vercel.app') return reply.status(403).send({ status:'HOLD',code:'ORIGIN_REQUIRED' });
    const visitor = token(request);
    if (!visitor) return reply.status(428).send({ status:'HOLD',code:'SESSION_REQUIRED' });
    let input: VisitorInput, requestId: string;
    try { input = validateVisitorInput(request.body); requestId = validateRequestId(request.headers['idempotency-key']); }
    catch { return reply.status(400).send({ status:'HOLD',code:'INVALID_INPUT' }); }
    try {
      // request.ip is the transport address, never trust user-supplied forwarding headers.
      // A proxy can group multiple visitors. Global caps remain authoritative.
      const job = await store.reserve(visitorHash(visitor), visitorHash(request.ip), requestId, input);
      if (!job.reused) {
        const controller = new AbortController();
        controllers.add(controller);
        const work = (async () => {
          try {
            const result = await runtime(input, { spentTodayUusdc:job.spentBeforeUusdc!, dailyCapUusdc:VISITOR_LIMITS.dailyUusdc.toString(), reserveUusdc:VISITOR_LIMITS.minimumReserveUusdc.toString(), signal:AbortSignal.any([controller.signal,AbortSignal.timeout(VISITOR_LIMITS.executionMs)]), beforeSign:r => store.markSigned(job.id,r),recordResponse:r => store.recordResponse(job.id,r) });
            const serialized = JSON.stringify(result);
            if (!serialized || Buffer.byteLength(serialized)>2_000_000) throw new Error('Research report exceeds bounds');
            await store.complete(job.id,result);
          } catch {
            try { await store.uncertain(job.id); } catch { /* Existing durable reservation remains held. */ }
          } finally { controllers.delete(controller); }
        })();
        active.add(work); void work.finally(() => active.delete(work));
      }
      return reply.status(202).send({ job_id:job.id,state:job.reused?'existing':'accepted',reused:job.reused,network:VISITOR_LIMITS.network });
    } catch (error) {
      if (error instanceof VisitorCapacityError) return reply.status(429).header('Retry-After','10').send({ status:'HOLD',code:error.code,paid_retry:false });
      return reply.status(503).send({ status:'HOLD',code:'RESEARCH_UNAVAILABLE',paid_retry:false });
    }
  });
  app.get<{ Params:{id:string} }>('/v1/research/jobs/:id', async (request, reply) => {
    reply.header('Cache-Control','no-store');
    const visitor = token(request);
    if (!visitor || !/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.status(404).send({ status:'HOLD',code:'NOT_FOUND' });
    try {
      const job = await store.read(request.params.id,visitorHash(visitor));
      if (!job) return reply.status(404).send({ status:'HOLD',code:'NOT_FOUND' });
      const stale = ['reserved','signed'].includes(job.state) && Date.now()-new Date(job.created_at).getTime()>VISITOR_LIMITS.uncertainLeaseSeconds*1000;
      return { job_id:job.id,state:stale?'uncertain':job.state,result:job.state==='complete'?job.result:null,
        limit:'Operator-sponsored related-party testnet request. Pending delivery is not settlement. Uncertain jobs are not retried or refunded automatically.' };
    } catch { return reply.status(503).send({ status:'HOLD',code:'RESEARCH_UNAVAILABLE' }); }
  });
}
