// VeriReceipt — Fastify server entrypoint.
//
// Zero-LLM. Routes the five deterministic intents to their handlers and
// maps errors through the shared core/errors contract. No mocks, no
// invented data: a handler that cannot answer fails closed via ApiError.
//
// Run directly: `node dist/server.js` (after `npm run build`).
// Requires SEC_USER_AGENT in the environment — never a placeholder value.

import {registerBuyer} from './buyer/routes';
import Fastify, { type FastifyInstance } from "fastify";
import { handleTx } from "./handlers/txLookup";
import { handleFilings } from "./handlers/filings";
import { handleTvl, startTvlListsRefreshTimer, stopTvlListsRefreshTimer, tvlDiskListsPresent, warmLists } from "./handlers/tvl";
import { handleRoute } from "./handlers/optimalRoute";
import { handleGridPrice } from "./handlers/gridPrice";
import { handleValidator } from "./handlers/validator";
import { handleGasPrice } from "./handlers/gasPrice";
import { handleTransactionRisk } from "./handlers/transactionRisk";
import { handleFinancialData } from "./handlers/financialData";
import { handleBalance } from "./handlers/walletBalance";
import { handleTokenSupply } from "./handlers/tokenSupply";
import { handleFx, handleFxNow } from "./handlers/currencyConvert";
import { handleDns } from "./handlers/dnsLookup";
import { handleSsl } from "./handlers/sslVerification";
import { handleCve, handleVulnTriage } from "./handlers/cveLookup";
import { handleAcademicSearch } from "./handlers/academicSearch";
import { handleCodePatchVerify } from "./handlers/codePatchVerify";
import { handleStockPrice } from "./handlers/stockPrice";
import { handleSanctionsScreen } from "./handlers/sanctionsScreening";
import { handleIpGeolocation } from "./handlers/ipGeolocation";
import { handleGameResult } from "./handlers/gameResult";
import { handleCorporateRegistry } from "./handlers/corporateRegistry";
import { handleAirQuality } from "./handlers/airQuality";
import { handleStormAlert } from "./handlers/stormAlert";
import { handleNewsHeadlines } from "./handlers/newsHeadlines";
import { handleNewsSearch } from "./handlers/newsSearch";
import { handleRouteEta } from "./handlers/routeEta";
import { handleApiHealth } from "./handlers/apiHealth";
import { handleServerUptime } from "./handlers/serverUptime";
import { handleMiningHashprice } from "./handlers/miningHashprice";
import { handleCryptoPrice } from "./handlers/cryptoPrice";
import { handleCryptoTransferVerify } from "./handlers/cryptoTransferVerify";
import { handleWeatherCheck } from "./handlers/weatherCheck";
import { handleEventOutcome } from "./handlers/eventOutcome";
import { handleTravelDisruption } from "./handlers/travelDisruption";
import { handleEmailSecurity } from "./handlers/emailSecurity";
import { exactQuery } from "./core/exactQuery";
import { diagnosticErrorCode, recordRequestArrival, recordRequestCompletion, requestMetricsSnapshot } from "./core/requestMetrics";
import { handleMacro } from "./handlers/macroEconomic";
import { handleTokenHolders } from "./handlers/tokenHolders";
import { createWiredFinanceHandlers } from "./handlers/financeWired";
import { createWiredWeatherHandlers } from "./handlers/weatherWired";
import { ApiError, badRequest, errorBody } from "./core/errors";
import { getDb } from "./core/db";
import {
  closeStorage,
  getStorageHealth,
  initStorage,
  startStoragePinger,
  stopStoragePinger,
  storageBackend,
} from "./core/storage";
import { installGracefulShutdown } from "./core/shutdown";
import { maybeMigrateOnBoot } from "./tools/bootMigrate";
import { registerReceiptRoutes } from "./core/receiptRoutes";
import { registerAccuracyRoute } from "./core/accuracy";
import { getJobsSnapshot, getLoopLagSnapshot, startLoopLagSampler } from "./core/loopLag";
import {
  INTENT_PRIMARY_UPSTREAM,
  getUpstreamsSnapshot,
  primaryUpstreamForGridZone,
  recordUpstreamError,
  recordUpstreamOkFromReceipt,
} from "./core/upstreams";

const startedAtMs = Date.now();

/** Max boot wait for the TVL lists warm on the no-disk (Postgres) layout. */
export const TVL_PRELISTEN_WARM_CAP_MS = 45_000;

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
  const requestStart = new WeakMap<object, bigint>();
  const requestErrors = new WeakMap<object, string>();
  app.addHook("onRequest", async (request) => {
    requestStart.set(request, process.hrtime.bigint());
    recordRequestArrival(request.routeOptions.url);
  });
  app.addHook("onResponse", async (request, reply) => {
    const started = requestStart.get(request);
    const elapsedMs = started === undefined ? 0 : Number(process.hrtime.bigint() - started) / 1e6;
    recordRequestCompletion(request.routeOptions.url, reply.statusCode, elapsedMs, { query: request.query, errorCode: requestErrors.get(request) });
  });

  // Initialise storage (creates tables on first run). Handlers rely on it
  // for receipt persistence and the grid-price cache.
  // PG-MIGRATE (2026-11-21): SQLite opens synchronously here as before;
  // the Postgres backend is async — main() awaits initStorage() before
  // listen(), and every store call also ensures the schema lazily.
  if (storageBackend() === "sqlite") getDb();

  // RENDER-SLOWNESS (2026-11-20): start the 1 s event-loop-lag sampler
  // (src/core/loopLag.ts). Idempotent and unref'd; its snapshot is
  // served additively on /health so the next stall is diagnosable from
  // the app itself. Starting it here (not only in main()) keeps the
  // /health fields live for every server built in tests too.
  startLoopLagSampler();

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ApiError) {
      requestErrors.set(request, diagnosticErrorCode(err.code));
      void reply.status(err.status).send(err.responseBody ?? errorBody(err));
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
      requestErrors.set(request, "INVALID_JSON");
      void reply.status(clientErr.status).send(errorBody(clientErr));
      return;
    }
    // Any other error is an upstream/internal failure: 502, and never leak
    // a stack trace or internal detail in the response body.
    requestErrors.set(request, "INTERNAL");
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
      // PG-MIGRATE (2026-11-21): ADDITIVE. In-memory snapshot of the
      // background storage ping (core/storage.ts, every 15 s, 2 s cap) —
      // /health never awaits the database.
      storage: getStorageHealth(),
      requests: requestMetricsSnapshot(),
    };
  });

  app.get("/v1/tx", async (request) => trackIntent("tx", () => handleTx(asQuery(request.query))));
  app.get("/v1/dns", async (request) => trackIntent("dns", () => handleDns(asQuery(request.query))));
  app.get("/v1/ssl", async (request) => trackIntent("ssl", () => handleSsl(asQuery(request.query))));
  app.get("/v1/cve", async (request) => trackIntent("cve", () => handleCve(asQuery(request.query))));
  app.get("/v1/vulnerability-triage", async (request) => trackIntent("vulnerability-triage", () => handleVulnTriage(asQuery(request.query))));
  app.get("/v1/academic-search", async (request) => trackIntent("academic-search", () => handleAcademicSearch(asQuery(request.query))));
  app.get("/v1/code-patch", async (request) => trackIntent("code-patch", () => handleCodePatchVerify(asQuery(request.query))));
  app.get("/v1/stock-price", async (request) => trackIntent("stock-price", () => handleStockPrice(asQuery(request.query))));
  app.get("/v1/sanctions-screen", async (request) => trackIntent("sanctions-screen", () => handleSanctionsScreen(asQuery(request.query))));
  app.get("/v1/ip-geolocation", async (request) => trackIntent("ip-geolocation", () => handleIpGeolocation(asQuery(request.query))));
  app.get("/v1/game-result", async (request) => trackIntent("game-result", () => handleGameResult(asQuery(request.query))));
  app.get("/v1/corporate-registry", async (request) => trackIntent("corporate-registry", () => handleCorporateRegistry(asQuery(request.query))));
  app.get("/v1/air-quality", async (request) => trackIntent("air-quality", () => handleAirQuality(asQuery(request.query))));
  app.get("/v1/storm-alert", async (request) => trackIntent("storm-alert", () => handleStormAlert(asQuery(request.query))));
  app.get("/v1/news-headlines", async (request) => trackIntent("news-headlines", () => handleNewsHeadlines(asQuery(request.query))));
  app.get("/v1/news-search", async (request) => trackIntent("news-search", () => handleNewsSearch(asQuery(request.query))));
  app.get("/v1/route-eta", async (request) => trackIntent("route-eta", () => handleRouteEta(asQuery(request.query))));
  app.get("/v1/api-health", async (request) => trackIntent("api-health", () => handleApiHealth(asQuery(request.query))));
  app.get("/v1/server-uptime", async (request) => trackIntent("server-uptime", () => handleServerUptime(asQuery(request.query))));
  app.get("/v1/mining-hashprice", async (request) => trackIntent("mining-hashprice", () => handleMiningHashprice(asQuery(request.query))));
  app.get("/v1/crypto-price", async (request) => trackIntent("crypto-price", () => handleCryptoPrice(asQuery(request.query))));
  app.get("/v1/crypto-transfer", async (request) => trackIntent("crypto-transfer", () => handleCryptoTransferVerify(asQuery(request.query))));
  app.get("/v1/weather-check", async (request) => trackIntent("weather-check", () => handleWeatherCheck(asQuery(request.query))));
  app.get("/v1/event-outcome", async (request) => trackIntent("event-outcome", () => handleEventOutcome(asQuery(request.query))));
  app.get("/v1/travel-disruption", async (request) => trackIntent("travel-disruption", () => handleTravelDisruption(asQuery(request.query))));
  app.get("/v1/email-security", async (request) => trackIntent("email-security", () => handleEmailSecurity(exactQuery(request.raw.url ?? "", ["domain", "record_type"])), "dns.google"));
  app.get("/v1/filings", async (request) =>
    trackIntent("filings", () => {
      // A1 (2026-11-21): asQuery keeps only the FIRST value of a repeated
      // key, so "form_type=10-K&form_type=144/A" (or a repeated entity /
      // period) would silently answer one of them. A repeated key on the
      // filings route is a 400, never a guess.
      // Round 9 (J2-r8 m7): Fastify's query parser silently drops
      // prototype keys, so "__proto__=x" used to answer 200. The raw URL
      // is checked for them: 400 UNKNOWN_PARAM, never silently ignored.
      const qs = (request.raw.url ?? "").split("?").slice(1).join("?");
      for (const key of new URLSearchParams(qs).keys()) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw badRequest(
            "UNKNOWN_PARAM",
            `Query parameter "${key}" is not supported; /v1/filings takes entity, period, form_type (or form) and cik`,
          );
        }
      }
      const raw = request.query as Record<string, unknown> | null;
      if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw)) {
          if (Array.isArray(value)) {
            throw badRequest("DUPLICATE_PARAM", `Query parameter "${key}" was given more than once`);
          }
        }
      }
      return handleFilings(asQuery(request.query));
    }),
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
  app.get("/v1/gas-price", async (request) =>
    trackIntent("gas-price", () => handleGasPrice(asQuery(request.query))),
  );
  app.get("/v1/transaction-risk", async (request) => trackIntent("transaction-risk", () => handleTransactionRisk(asQuery(request.query))));
  app.get("/v1/financial-data", async (request) => trackIntent("financial-data", () => handleFinancialData(asQuery(request.query))));
  app.get("/v1/balance", async (request) =>
    trackIntent("balance", () => handleBalance(asQuery(request.query))),
  );
  app.get("/v1/token-supply", async (request) =>
    trackIntent("token-supply", () => handleTokenSupply(asQuery(request.query))),
  );
  app.get("/v1/macro", async (request) =>
    trackIntent("macro", () => handleMacro(asQuery(request.query))),
  );
  app.get("/v1/fx", async (request) =>
    trackIntent("fx", () => handleFx(asQuery(request.query))),
  );
  app.get("/v1/fx-now", async (request) =>
    trackIntent("fx-now", () => handleFxNow(asQuery(request.query))),
  );
  app.get("/v1/token-holders", async (request) =>
    trackIntent("token-holders", () => handleTokenHolders(asQuery(request.query))),
  );
  // Wired finance observations (expansion): primary/fallback sources, no
  // averaging; keyed failover legs appear only when their env keys are set.
  const wiredFinance = createWiredFinanceHandlers();
  app.get("/v1/price", async (request) =>
    trackIntent("price", () => wiredFinance.price(asQuery(request.query))),
  );
  app.get("/v1/liquidity", async (request) =>
    trackIntent("liquidity", () => wiredFinance.liquidity(asQuery(request.query))),
  );
  app.get("/v1/yield", async (request) =>
    trackIntent("yield", () => wiredFinance.yield(asQuery(request.query))),
  );
  // Wired measured-weather observations (expansion): NOAA station
  // observations only, exact reviewed station spellings, no forecast or
  // reanalysis substitution.
  const wiredWeather = createWiredWeatherHandlers();
  app.get("/v1/weather", async (request) =>
    trackIntent("weather", () => wiredWeather.current(asQuery(request.query))),
  );
  app.get("/v1/weather-history", async (request) =>
    trackIntent("weather-history", () => wiredWeather.past(asQuery(request.query))),
  );

  // G10: serve stored receipts + their exact raw evidence bytes
  // (GET /receipts/:id, /receipts/:id/raw; /api/* aliases). See
  // src/core/receiptRoutes.ts for the contract.
  registerReceiptRoutes(app);
  registerBuyer(app);

  // S2: serve the daily accuracy document (exact counts over stored
  // receipts, same contract as scripts/accuracy.mjs — core/accuracy.ts).
  registerAccuracyRoute(app);

  return app;
}

/**
 * Start the grid-price ingester if its module exists. The ingester is owned
 * by another worker; a missing module must not prevent the server from
 * starting, so the import is lazy and guarded.
 */
function startGridIngesterIfPresent(): NodeJS.Timeout | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./jobs/gridIngester") as {
      startIngester?: (intervalMs?: number) => NodeJS.Timeout;
    };
    if (typeof mod.startIngester === "function") {
      const timer = mod.startIngester();
      console.log("verireceipt: grid ingester started");
      return timer;
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
  return null;
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
  const lists = warmLists().catch(() => undefined);
  // TVL lists hourly refresh timer (round-2 fix, 2026-11-20, tvl.ts):
  // refreshes the lists BEFORE the 24h TTL expires, so a zero-traffic
  // server cannot hit the expiry window and serve a fast 502. Idempotent
  // and unref'd; a tick refreshes only when the cache is due (absent or
  // older than 22h), never on a fresh cache.
  startTvlListsRefreshTimer();

  // PG-MIGRATE (2026-11-21): open the store BEFORE listen(). On Postgres
  // this creates the schema and proves the connection; if it fails the
  // boot fails (exit 1) and, with zero-downtime deploys, Render keeps the
  // previous instance serving instead of routing to a broken one.
  // PG-CUTOVER (2026-11-21): no-op unless DATABASE_URL + MIGRATE_ON_BOOT=1
  // + the SQLite file exists; copies and verifies SQLite -> Postgres first.
  await maybeMigrateOnBoot();
  await initStorage();
  startStoragePinger();
  // Without the disk the TVL lists cache (tvl.ts listsCacheDir) is cold on
  // every boot. Zero-downtime deploys keep the old instance serving until
  // this one listens, so on the no-disk (Postgres) layout the boot waits
  // for the warm — capped, never forever (warmLists never throws).
  // r2 (J1 m5): skip the wait when the disk cache files exist (disk still
  // attached, cutover step 3): warmLists serves them immediately.
  if (storageBackend() === "postgres" && !tvlDiskListsPresent()) {
    let capTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      lists,
      new Promise<void>((r) => {
        capTimer = setTimeout(r, TVL_PRELISTEN_WARM_CAP_MS);
        if (typeof capTimer.unref === "function") capTimer.unref();
      }),
    ]);
    if (capTimer) clearTimeout(capTimer);
  }

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
  const ingesterTimer = startGridIngesterIfPresent();
  // GRACEFUL-SHUTDOWN (2026-11-21, src/core/shutdown.ts): on Render's
  // deploy SIGTERM, drain in-flight requests, stop timers, close SQLite
  // (WAL checkpoint), exit 0. Without it Node died on the default signal
  // action mid-request.
  installGracefulShutdown(app, {
    stopTimers: () => {
      if (ingesterTimer) clearInterval(ingesterTimer);
      stopTvlListsRefreshTimer();
      stopStoragePinger();
    },
    closeDb: closeStorage,
  });
  return app;
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("FATAL: server failed to start:", err);
    process.exit(1);
  });
}
