// VeriReceipt Desk — HTTP routes (routes.ts).
//
//   POST /desk/run    — run one M13 or M12 scenario live (ranked
//                        escrow calls + deterministic policy verdict)
//   GET  /desk/ledger — paginated desk runs with signal_hash links
//   GET  /desk/stats  — payer balance, runway ticker, spend totals, caps
//   GET  /desk/verify — verify one signal_hash against the node
//
// Routes are mounted WITHOUT an /api prefix (repo convention, like
// /health and /v1/*): the Vite dev proxy and the Vercel rewrites
// strip a leading /api from same-origin calls, so /api/desk/* 404s
// on Render. There is no /api/desk/* mount — the remount is clean.
//
// Spend caps (hard, enforced before any call is bought — see caps.ts,
// the single enforcement point shared with the MCP run_* tools):
//   - 5 free live checks / IP / day (in-memory counters; see caps.ts
//     for the honest durability limitation)
//   - $2.00 / day global cap (2,000,000 µUSDC), counted from the
//     per-call SQLite ledger plus pending reservations
// The payer key is server-side only (DESK_PAYER_PRIVATE_KEY); the client
// never sees it. Every bought call is a REAL ranked escrow call —
// there is no demo mode and no simulated spend anywhere in this file.
//
// Order of operations per request (this order is the TOCTOU fix):
//   1. validate the mission + inputs (a 400/422 consumes no quota);
//   2. reserveCaps() — synchronous check + reservation, before the
//      first await, so concurrent requests see each other's quota;
//   3. run the scenario, logging EACH call to the ledger the moment
//      it is bought (onCall), so a throw mid-run cannot lose spend;
//   4. fill in the verdict on the run's rows, release the reservation
//      in a finally block (the ledger then carries the real rows).

import type { FastifyInstance } from "fastify";
import { ApiError, badRequest, upstreamUnavailable } from "../core/errors";
import { validateM12Input } from "./policyM12";
import { validateM13Input } from "./policyM13";
import {
  deskRunToPublic,
  deskSpendSinceUtcDay,
  deskSpendTotals,
  countDeskRuns,
  listDeskRuns,
  logDeskRun,
  markDeskRunVerified,
  updateDeskRunVerdict,
} from "./ledger";
import { runM12Scenario, runM13Scenario, type ScenarioCallRecord } from "./scenarios";
import {
  clientIp,
  reserveCaps,
  COST_PER_CALL_UUSDC,
  DAILY_GLOBAL_CAP_UUSDC,
  FREE_CHECKS_PER_IP_PER_DAY,
  M12_RUN_COST_UUSDC,
  M13_RUN_COST_UUSDC,
} from "./caps";
import {
  TELEGRAPH_DIAMOND,
  TELEGRAPH_NETWORK,
  TelegraphClient,
  type Hex,
} from "./telegraphClient";

export { resetDeskCaps } from "./caps";
export { FREE_CHECKS_PER_IP_PER_DAY, DAILY_GLOBAL_CAP_UUSDC };
export const COST_PER_CHECK_UUSDC = COST_PER_CALL_UUSDC; // $0.01 per ranked call (protocol floor)

/**
 * Mandatory related-party disclosure — VERBATIM from the build blueprint
 * §7.3. Served by GET /desk/stats and used by the UI. Do not reword.
 */
export const RELATED_PARTY_DISCLOSURE =
  "Disclosure: VeriReceipt Desk and the VeriReceipt Miner are operated by the same team. " +
  "Calls made by VeriReceipt Desk use Telegraph's ranked router (`POST /engine/v1/ask`) " +
  "on Ethereum Sepolia testnet (Test USDC only) and are explicitly labeled as related-party / " +
  "internal test traffic, not independent customer demand. " +
  "Independent third-party developer runs are logged and identified separately.";

export interface DeskRouteDeps {
  client?: TelegraphClient;
  /** Override for tests: returns the current UTC day prefix YYYY-MM-DD. */
  todayPrefix?: () => string;
  /** Override for tests: live Bitcoin tip height (default: mempool.space). */
  blockHeightFn?: () => Promise<number>;
}

function utcDayPrefix(): string {
  return new Date().toISOString().slice(0, 10);
}

function payerClient(deps: DeskRouteDeps): TelegraphClient {
  if (deps.client) return deps.client;
  const key = (process.env.DESK_PAYER_PRIVATE_KEY ?? "").trim();
  if (!key) {
    throw new ApiError(
      503,
      "DESK_NOT_FUNDED",
      "The Desk payer wallet is not configured on this server (DESK_PAYER_PRIVATE_KEY missing). No live check can run.",
    );
  }
  return new TelegraphClient({ privateKey: key as Hex });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Log one bought call to the SQLite ledger IMMEDIATELY (per-call
 * logging). The verdict is null at this point and is filled in by
 * updateDeskRunVerdict once the scenario decides. All receipt
 * identifiers the ask provided are recorded (see ledger.ts).
 */
export function logBoughtCall(
  runId: string,
  mission: "M13" | "M12",
  scenarioId: string,
  call: ScenarioCallRecord,
): void {
  logDeskRun({
    run_id: runId,
    mission,
    scenario_id: scenarioId,
    intent: call.intent,
    miner_id: call.miner_id,
    miner_name: call.miner_name,
    signal_hash: call.signal_hash,
    receipt_hash: call.receipt_hash,
    receipt_json: JSON.stringify({ payments: call.payments, receipt: call.receipt }),
    cost_uusdc: call.cost_uusdc,
    rail: call.rail,
    verdict: null,
    related_party: 1,
    fetched_at: call.fetched_at,
    verification_status: call.signal_hash ? "pending" : "failed",
  });
}

export function registerDeskRoutes(app: FastifyInstance, deps: DeskRouteDeps = {}): void {
  const today = deps.todayPrefix ?? utcDayPrefix;

  app.post("/desk/run", async (request, reply) => {
    const ip = clientIp(request);
    const day = today();
    const body = asRecord(request.body);
    const mission = body.mission;
    if (mission !== "M13" && mission !== "M12") {
      throw badRequest("INVALID_MISSION", 'mission must be "M13" or "M12"');
    }
    const scenarioId =
      typeof body.scenario_id === "string" && body.scenario_id
        ? body.scenario_id
        : `api-${day}`;
    // Validate BEFORE reserving: a refusal must not consume quota.
    const client = payerClient(deps);
    const m13Input =
      mission === "M13"
        ? validateM13Input({
            protocol: String(body.protocol ?? ""),
            tx_hash: String(body.tx_hash ?? ""),
            chain: String(body.chain ?? ""),
            issuer_entity: String(body.issuer_entity ?? ""),
            period: String(body.period ?? ""),
            trade_pair: String(body.trade_pair ?? ""),
          })
        : null;
    const m12Input =
      mission === "M12"
        ? validateM12Input({
            node_or_zone: String(body.node_or_zone ?? ""),
            interval_start: String(body.interval_start ?? ""),
            breakeven_usd_per_mwh: Number(body.breakeven_usd_per_mwh),
          })
        : null;
    const reservation =
      mission === "M13"
        ? reserveCaps(ip, day, M13_RUN_COST_UUSDC)
        : reserveCaps(ip, day, M12_RUN_COST_UUSDC);

    try {
      if (mission === "M13") {
        const input = m13Input as NonNullable<typeof m13Input>;
        const outcome = await runM13Scenario(client, input, scenarioId, {
          onCall: (runId, call) => logBoughtCall(runId, "M13", scenarioId, call),
        });
        updateDeskRunVerdict(outcome.run_id, outcome.decision.verdict);
        return reply.status(200).send({
          run_id: outcome.run_id,
          mission: "M13",
          scenario_id: scenarioId,
          verdict: outcome.decision.verdict,
          checks: outcome.decision.checks,
          why: outcome.decision.why,
          calls: outcome.calls.map((c) => ({
            ...c,
            signal_url: c.signal_hash
              ? `https://devnode.telegraphprotocol.com/engine/v1/signal/${c.signal_hash}`
              : null,
          })),
          total_cost_uusdc: outcome.total_cost_uusdc,
          total_cost_usd: outcome.total_cost_uusdc / 1_000_000,
          related_party: true,
          disclosure: RELATED_PARTY_DISCLOSURE,
        });
      }

      const input = m12Input as NonNullable<typeof m12Input>;
      const outcome = await runM12Scenario(client, input, scenarioId, {
        blockHeightFn: deps.blockHeightFn,
        onCall: (runId, call) => logBoughtCall(runId, "M12", scenarioId, call),
      });
      updateDeskRunVerdict(outcome.run_id, outcome.decision.verdict);
      return reply.status(200).send({
        run_id: outcome.run_id,
        mission: "M12",
        scenario_id: scenarioId,
        verdict: outcome.decision.verdict,
        checks: outcome.decision.checks,
        why: outcome.decision.why,
        calls: outcome.calls.map((c) => ({
          ...c,
          signal_url: c.signal_hash
            ? `https://devnode.telegraphprotocol.com/engine/v1/signal/${c.signal_hash}`
            : null,
        })),
        total_cost_uusdc: outcome.total_cost_uusdc,
        total_cost_usd: outcome.total_cost_uusdc / 1_000_000,
        related_party: true,
        disclosure: RELATED_PARTY_DISCLOSURE,
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // A live-call failure is an upstream failure, never a verdict.
      // Calls already bought before the throw are in the ledger via onCall.
      throw upstreamUnavailable(
        "DESK_RUN_FAILED",
        `Live Desk run failed before a verdict could be reached: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      reservation.release();
    }
  });

  app.get("/desk/ledger", async (request) => {
    const query = request.query as Record<string, unknown>;
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20) || 20));
    const offset = (page - 1) * limit;
    const rows = listDeskRuns(limit, offset);
    const total = countDeskRuns();
    return {
      page,
      limit,
      total,
      runs: rows.map(deskRunToPublic),
    };
  });

  app.get("/desk/stats", async () => {
    const totals = deskSpendTotals();
    const day = today();
    const spentToday = deskSpendSinceUtcDay(day);
    const payerAddress = process.env.DESK_PAYER_ADDRESS ?? null;
    let escrow: Record<string, unknown> | null = null;
    let runwayChecks: number | null = null;
    let runwayLabel: string | null = null;
    if (payerAddress) {
      try {
        const client = deps.client ?? new TelegraphClient({});
        escrow = await client.getLedgerAccount(payerAddress);
        const available = Number(escrow.available ?? NaN);
        if (Number.isFinite(available) && available >= 0) {
          runwayChecks = Math.floor(available / COST_PER_CHECK_UUSDC);
          runwayLabel = `Funded for ~${runwayChecks} live checks`;
        }
      } catch {
        escrow = { error: "ledger lookup failed" };
      }
    }
    return {
      payer_address: payerAddress,
      diamond: TELEGRAPH_DIAMOND,
      network: TELEGRAPH_NETWORK,
      chain: "Ethereum Sepolia (testnet)",
      escrow,
      runway_checks: runwayChecks,
      runway_label: runwayLabel,
      spend: {
        total_calls: totals.total_calls,
        total_cost_uusdc: totals.total_cost_uusdc,
        total_cost_usd: totals.total_cost_uusdc / 1_000_000,
        m13_calls: totals.m13_calls,
        m12_calls: totals.m12_calls,
        verified_calls: totals.verified_calls,
        distinct_miners: totals.distinct_miners,
        distinct_scenarios: totals.distinct_scenarios,
      },
      spend_today: {
        day,
        calls: spentToday.calls,
        cost_uusdc: spentToday.cost_uusdc,
        cost_usd: spentToday.cost_uusdc / 1_000_000,
      },
      caps: {
        free_checks_per_ip_per_day: FREE_CHECKS_PER_IP_PER_DAY,
        daily_global_cap_usd: DAILY_GLOBAL_CAP_UUSDC / 1_000_000,
        cost_per_check_usd: COST_PER_CHECK_UUSDC / 1_000_000,
        cost_per_m13_run_usd: M13_RUN_COST_UUSDC / 1_000_000,
        cost_per_m12_run_usd: M12_RUN_COST_UUSDC / 1_000_000,
      },
      related_party_disclosure: RELATED_PARTY_DISCLOSURE,
    };
  });

  // Verify one signal_hash against the node and record the outcome.
  app.get("/desk/verify", async (request) => {
    const query = request.query as Record<string, unknown>;
    const signalHash = typeof query.signal_hash === "string" ? query.signal_hash : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(signalHash)) {
      throw badRequest(
        "INVALID_SIGNAL_HASH",
        "signal_hash must be a 0x-prefixed 64-hex-character hash",
      );
    }
    const client = deps.client ?? new TelegraphClient({});
    const { verified, body } = await client.verifySignal(signalHash);
    if (verified) {
      markDeskRunVerified(signalHash, "verified", JSON.stringify(body).slice(0, 4000));
    } else {
      markDeskRunVerified(signalHash, "failed", JSON.stringify(body).slice(0, 4000));
    }
    return { signal_hash: signalHash, verified, verification: body };
  });
}
