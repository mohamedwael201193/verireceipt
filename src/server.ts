// VeriReceipt — Fastify server entrypoint.
//
// Zero-LLM. Routes the five deterministic intents to their handlers and
// maps errors through the shared core/errors contract. No mocks, no
// invented data: a handler that cannot answer fails closed via ApiError.
//
// Run directly: `node dist/server.js` (after `npm run build`).
// Requires SEC_USER_AGENT in the environment — never a placeholder value.

import Fastify, { type FastifyInstance } from "fastify";
import { handleTx } from "./handlers/txLookup";
import { handleFilings } from "./handlers/filings";
import { handleTvl, startTvlListsRefreshTimer, warmLists } from "./handlers/tvl";
import { handleRoute } from "./handlers/optimalRoute";
import { handleGridPrice } from "./handlers/gridPrice";
import { handleValidator } from "./handlers/validator";
import { ApiError, badRequest, errorBody } from "./core/errors";
import { getDb } from "./core/db";
import { getJobsSnapshot, getLoopLagSnapshot, startLoopLagSampler } from "./core/loopLag";
import {
  INTENT_PRIMARY_UPSTREAM,
  getUpstreamsSnapshot,
  primaryUpstreamForGridZone,
  recordUpstreamError,
  recordUpstreamOkFromReceipt,
} from "./core/upstreams";

const startedAtMs = Date.now();

/**
 * Deployed git SHA for /health (A6): Render sets RENDER_GIT_COMMIT to
 * the deployed commit. Read at request time (not module load) so tests
 * can set it. A SHA is not a secret; absent locally (or blank) it is
 * "unknown", never a crash and never a leak.
 */
function gitSha(): string {
  const sha = (process.env.RENDER_GIT_COMMIT ?? "").trim();
  return sha ? sha : "unknown";
}

/**
 * A6: record per-upstream health around one intent handler WITHOUT
 * touching the handler. Success: the receipt's upstream_url +
 * fetched_at (see src/core/upstreams.ts — the receipt names the
 * upstream that served the answer and when it was fetched). Failure:
 * only a 502-class error records last_err, for the intent's primary
 * service, with the ApiError CODE only (never the message — messages
 * can embed upstream URLs). 400/422/404 record nothing. The registry
 * itself never throws; the try/catch here is belt-and-braces so the
 * tracking can never change the answer or the error the caller sees.
 */
async function trackIntent<T>(
  intent: string,
  fn: () => Promise<T>,
  primaryOverride?: string,
): Promise<T> {
  try {
    const result = await fn();
    try {
      recordUpstreamOkFromReceipt(
        (result as Record<string, unknown> | null | undefined)?.receipt,
      );
    } catch {
      // Registry is fail-open; ignore tracking failures.
    }
    return result;
  } catch (err) {
    try {
      // Non-ApiError throwables are mapped to 502 by the error handler,
      // so they count as upstream failures too.
      const isUpstreamFailure = err instanceof ApiError ? err.status >= 500 : true;
      if (isUpstreamFailure) {
        const primary = primaryOverride ?? INTENT_PRIMARY_UPSTREAM[intent];
        if (primary) {
          recordUpstreamError(primary, err instanceof ApiError ? err.code : "INTERNAL");
        }
      }
    } catch {
      // Tracking must never change the error the caller sees.
    }
    throw err;
  }
}

type Query = Record<string, string | undefined>;

/**
 * Normalise Fastify's parsed query (string | string[] | undefined values)
 * to the flat string map the handlers accept. Repeated params take the
 * first value; non-string values are dropped.
 */
function asQuery(raw: unknown): Query {
  const out: Query = {};
  if (raw !== null && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") {
        out[key] = value;
      } else if (Array.isArray(value) && typeof value[0] === "string") {
        out[key] = value[0];
      }
    }
  }
  return out;
}

/** Build (but do not listen on) the Fastify instance. Used by tests and scripts. */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Initialise storage (creates tables on first run). Handlers rely on it
  // for receipt persistence and the grid-price cache.
  getDb();

  // RENDER-SLOWNESS (2026-11-20): start the 1 s event-loop-lag sampler
  // (src/core/loopLag.ts). Idempotent and unref'd; its snapshot is
  // served additively on /health so the next stall is diagnosable from
  // the app itself. Starting it here (not only in main()) keeps the
  // /health fields live for every server built in tests too.
  startLoopLagSampler();

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ApiError) {
      void reply.status(err.status).send(errorBody(err));
      return;
    }
    // Fastify body-parse / validation errors are client errors, not an
    // upstream outage: a malformed JSON body is a 400, never a 502.
    const fastifyErr = err as { code?: unknown; statusCode?: unknown };
    if (
      (typeof fastifyErr.code === "string" && fastifyErr.code.startsWith("FST_ERR_CTP_")) ||
      fastifyErr.statusCode === 400
    ) {
      const clientErr = badRequest("INVALID_JSON", "request body is not valid JSON");
      void reply.status(clientErr.status).send(errorBody(clientErr));
      return;
    }
    // Any other error is an upstream/internal failure: 502, and never leak
    // a stack trace or internal detail in the response body.
    void reply.status(502).send(errorBody(err));
  });

  // RENDER-SLOWNESS (2026-11-20): ADDITIVE fields only — the four
  // existing fields and their semantics are untouched. loopLagMs is
  // the 1 s sampler snapshot (zeroes before the first tick); jobs is
  // the job-timing registry ({} until a job completes). Both are what
  // decide, at the next stall, whether the event loop was blocked
  // in-process (lag max in seconds + a long grid-ingester run) or the
  // process was unreachable from outside (lag ~0 while /health times
  // out — a Render-side stall).
  // A6 (2026-11-20): three more ADDITIVE fields, same rule — nothing
  // existing renamed or removed. `git_sha` is the deployed commit
  // (RENDER_GIT_COMMIT, "unknown" locally); `loop_lag_ms` is the same
  // snapshot object as `loopLagMs` under the snake_case name PLAN.md
  // specifies (no frontend consumer reads either name today — verified
  // 2026-11-20 by grep of the frontend repo — so both are kept);
  // `upstreams` is now the live registry snapshot ({} until a handler
  // call observes an upstream) instead of a hardcoded {}. /health
  // stays cheap: all three are in-memory reads, no upstream calls,
  // no DB touch.
  app.get("/health", async () => {
    const loopLag = getLoopLagSnapshot();
    return {
      status: "ok",
      service: "verireceipt",
      uptime_s: Math.floor((Date.now() - startedAtMs) / 1000),
      upstreams: getUpstreamsSnapshot(),
      loopLagMs: loopLag,
      loop_lag_ms: loopLag,
      jobs: getJobsSnapshot(),
      git_sha: gitSha(),
    };
  });

  app.get("/v1/tx", async (request) => trackIntent("tx", () => handleTx(asQuery(request.query))));
  app.get("/v1/filings", async (request) =>
    trackIntent("filings", () => handleFilings(asQuery(request.query))),
  );
  app.get("/v1/tvl", async (request) =>
    trackIntent("tvl", () => handleTvl(asQuery(request.query))),
  );
  app.get("/v1/route", async (request) =>
    trackIntent("route", () => handleRoute(asQuery(request.query))),
  );
  app.get("/v1/grid-price", async (request) => {
    // A6: the zone refines the error attribution (NYISO/Elering cache
    // misses are not CAISO failures) — see primaryUpstreamForGridZone.
    const q = asQuery(request.query);
    return trackIntent(
      "grid-price",
      () => handleGridPrice(q),
      primaryUpstreamForGridZone(q.node_or_zone),
    );
  });
  app.get("/v1/validator", async (request) =>
    trackIntent("validator", () => handleValidator(asQuery(request.query))),
  );

  return app;
}

/**
 * Start the grid-price ingester if its module exists. The ingester is owned
 * by another worker; a missing module must not prevent the server from
 * starting, so the import is lazy and guarded.
 */
function startGridIngesterIfPresent(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./jobs/gridIngester") as {
      startIngester?: (intervalMs?: number) => NodeJS.Timeout;
    };
    if (typeof mod.startIngester === "function") {
      mod.startIngester();
      console.log("verireceipt: grid ingester started");
    } else {
      console.error(
        "verireceipt: WARNING grid ingester module exists but exports no startIngester(); grid cache will stay empty",
      );
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "MODULE_NOT_FOUND") {
      console.error(
        "verireceipt: WARNING src/jobs/gridIngester.ts not present yet; grid ingester not started, /v1/grid-price serves cache only",
      );
    } else {
      console.error("verireceipt: WARNING grid ingester failed to start:", err);
    }
  }
}

/**
 * Boot the production server: build, start the grid ingester, fire the
 * TVL lists warm-up, start the hourly lists-refresh timer, then listen.
 *
 * Exported (round-3, 2026-11-20) so the wiring test can boot the REAL
 * main() in-process: previously main() was unexported and no test ever
 * booted it, so deleting the `startTvlListsRefreshTimer()` call below
 * passed the whole suite (mutant C, round-2 J2). Returns the Fastify
 * instance so the test can close it cleanly; the `require.main` block
 * below ignores the return value.
 */
export async function main(): Promise<FastifyInstance> {
  if (!process.env.SEC_USER_AGENT) {
    console.error(
      "FATAL: SEC_USER_AGENT environment variable is not set. " +
        "Set it to a real contact string before starting the server. " +
        "Refusing to start without one.",
    );
    process.exit(1);
  }

  const app = buildServer();

  // TVL lists warm-up (tvl.ts warmLists): the /protocols list is ~9.6 MB
  // and its sandbox download time varies wildly by egress conditions
  // (observed completions as of 2026-11-20 11:46 UTC span ~2–29s —
  // fastest 2.2s (J2 curl ~11:42 UTC), R7 curls 15.4s/8.4s at 11:46 UTC,
  // R5 curl 12.8s at 09:55 UTC — plus a 166.8s stall completion and a
  // 120s 0-byte stall; see tvl.ts / JUDGE.md §10). The request path
  // NEVER fetches the lists (TVL-LATENCY fix, 2026-11-20): a request with
  // no usable cache fails closed immediately with 502
  // TVL_LISTS_UNAVAILABLE (retry_after_sec 65) while the background warm
  // proceeds, and a warm request's reading fetches share ONE wall budget
  // of 2x the per-fetch cap (REQUEST_UPSTREAM_MAX_MS) — worst-case wall
  // ~9s, well under 60s (A5-fix2, 2026-11-20, J2-R2 F1: the old "~5s /
  // at most one fetch" claim was FALSE — every fallback-triggered
  // request measured 9.0–9.2s; the bound is now honest).
  // Fire-and-forget: this must never block listen() or crash startup
  // (warmLists never throws). PRESERVE THIS CALL on any later server.ts
  // rewrite.
  void warmLists().catch(() => undefined);
  // TVL lists hourly refresh timer (round-2 fix, 2026-11-20, tvl.ts):
  // refreshes the lists BEFORE the 24h TTL expires, so a zero-traffic
  // server cannot hit the expiry window and serve a fast 502. Idempotent
  // and unref'd; a tick refreshes only when the cache is due (absent or
  // older than 22h), never on a fresh cache.
  startTvlListsRefreshTimer();

  const rawPort = Number(process.env.PORT ?? "10000");
  const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.floor(rawPort) : 10000;
  await app.listen({ host: "0.0.0.0", port });
  console.log(`verireceipt listening on 0.0.0.0:${port}`);
  // Grid ingester starts AFTER listen (A5-fix2, 2026-11-20, J2-R2 F1d):
  // startIngester() fires its first multi-source pull immediately, and
  // starting it before listen() let that pull (25–104 s jobs observed)
  // compete with the first TVL requests before the server could serve
  // anything. Listening first means the first request is servable before
  // the ingester's pull begins; the ingester still starts at boot, just
  // after the socket is open. Grid-price serves cache-only until the
  // first cycle lands either way.
  startGridIngesterIfPresent();
  return app;
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("FATAL: server failed to start:", err);
    process.exit(1);
  });
}
