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
import { handleTvl } from "./handlers/tvl";
import { handleRoute } from "./handlers/optimalRoute";
import { handleGridPrice } from "./handlers/gridPrice";
import { ApiError, errorBody } from "./core/errors";
import { getDb } from "./core/db";

const startedAtMs = Date.now();

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

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ApiError) {
      void reply.status(err.status).send(errorBody(err));
      return;
    }
    // Any other error is an upstream/internal failure: 502, and never leak
    // a stack trace or internal detail in the response body.
    void reply.status(502).send(errorBody(err));
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "verireceipt",
    uptime_s: Math.floor((Date.now() - startedAtMs) / 1000),
    upstreams: {},
  }));

  app.get("/v1/tx", async (request) => handleTx(asQuery(request.query)));
  app.get("/v1/filings", async (request) => handleFilings(asQuery(request.query)));
  app.get("/v1/tvl", async (request) => handleTvl(asQuery(request.query)));
  app.get("/v1/route", async (request) => handleRoute(asQuery(request.query)));
  app.get("/v1/grid-price", async (request) => handleGridPrice(asQuery(request.query)));

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

async function main(): Promise<void> {
  if (!process.env.SEC_USER_AGENT) {
    console.error(
      "FATAL: SEC_USER_AGENT environment variable is not set. " +
        "Set it to a real contact string before starting the server. " +
        "Refusing to start without one.",
    );
    process.exit(1);
  }

  const app = buildServer();
  startGridIngesterIfPresent();

  const rawPort = Number(process.env.PORT ?? "10000");
  const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.floor(rawPort) : 10000;
  await app.listen({ host: "0.0.0.0", port });
  console.log(`verireceipt listening on 0.0.0.0:${port}`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("FATAL: server failed to start:", err);
    process.exit(1);
  });
}
