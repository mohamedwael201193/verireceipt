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
import { verifyReceipt, isHash } from "./desk/verify";
import { handleMcpRequest } from "./desk/mcp";

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

  // Desk receipt verification (src/desk/verify.ts): the signal (answer)
  // and, when the ask recorded one, the delivery (payment). signal_hash
  // and receipt_hash are different hashes — never reuse one for the
  // other. A delivery lookup before the epoch closes returns status
  // "pending", never a broken 404 link.
  app.get("/api/desk/verify", async (request, reply) => {
    const query = asQuery(request.query);
    const signalHash = query["signal_hash"];
    if (typeof signalHash !== "string" || !isHash(signalHash)) {
      return reply.status(400).send({
        error: "signal_hash query param must be 0x + 64 hex characters",
      });
    }
    const receiptHash = query["receipt_hash"];
    if (
      receiptHash !== undefined &&
      (typeof receiptHash !== "string" || !isHash(receiptHash))
    ) {
      return reply.status(400).send({
        error: "receipt_hash query param must be 0x + 64 hex characters",
      });
    }
    const epochRaw = query["epoch"];
    let epoch: number | null = null;
    if (epochRaw !== undefined) {
      // Strict digits-only: Number() would accept "" as 0, "0x18" as 24
      // and "1e3" as 1000 — all of them must be refused with 400.
      if (!/^\d+$/.test(epochRaw)) {
        return reply.status(400).send({
          error: "epoch query param must be a non-negative integer (digits only)",
        });
      }
      epoch = Number(epochRaw);
    }
    return verifyReceipt({
      signal_hash: signalHash,
      receipt_hash: receiptHash ?? null,
      epoch,
    });
  });

  // Desk MCP surface (src/desk/mcp.ts): keyless Streamable HTTP,
  // JSON-RPC 2.0. Tools: verify_receipt (more register in mcp.ts).
  app.post("/api/mcp", async (request) => handleMcpRequest(request.body));

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
