// VeriReceipt Desk — scenario runners (scenarios.ts).
//
// One M13 scenario buys 6 ranked intents (5 own + 1 independent):
//   ONCHAIN_TX_LOOKUP_GENERAL, REGULATORY_FILING_MONITOR_GENERAL,
//   TVL_LOOKUP_GENERAL, OPTIMAL_EXECUTION_ROUTE_GENERAL,
//   SANCTIONS_SCREENING_MATCH_GENERAL, CRYPTO_PRICE_USD.
// CRYPTO_PRICE_USD is bought in every M13 run through this runner (blueprint §7.3 lists it
// among the M13 intents; the seed plan buys it in all 20 scenarios): it is
// the independent spot price the ≤2% route-vs-spot check is computed
// against. Without it the check is "unverifiable" and blocks APPROVE
// (policyM13.ts checkRouteVsSpot) — it is never "skipped" into an
// approval. Buying the price in every run through this runner closes that hole.
// One M12 scenario buys 2 ranked intents:
//   GRID_POWER_PRICE_GENERAL, MINING_HASHPRICE_VERIFY_GENERAL.
// Every call goes through the ranked router (POST /engine/v1/ask) via
// the TelegraphClient — escrow primary, x402 fallback. No direct
// /ask/<minerId> calls for primary runs, no mocked answers: a call
// that fails throws and the scenario fails closed with no verdict.
//
// PER-CALL LOGGING (spend can never be lost mid-run): both runners
// accept opts.onCall, invoked IMMEDIATELY after each ask resolves
// and BEFORE the next ask is bought. Callers pass a logger that
// writes the call to the SQLite ledger (and, for the seed runner, to
// receipts/ledger.jsonl) at that moment. If ask 3 of 6 throws, calls
// 1–2 are already in the ledger; the throw only loses the verdict,
// never the spend record.
//
// Evidence is extracted ONLY from the live answer bodies (shaped
// `result` fields). The node's echoed `input` is NEVER used as
// evidence: it is our own request echoed back, so a chain or hash
// read from it would always "match" by construction. A field the
// answer does not carry stays absent — the policy then marks that
// check unverifiable and the verdict can only be HOLD or worse.

import { randomUUID } from "crypto";
import { evaluateM12, type M12Evidence, type M12Input, type M12Result } from "./policyM12";
import { evaluateM13, type M13Evidence, type M13Input, type M13Result } from "./policyM13";
import type { AskResult, TelegraphClient } from "./telegraphClient";

export interface ScenarioCallRecord {
  intent: string;
  params: Record<string, unknown>;
  miner_id: string | null;
  miner_name: string | null;
  signal_hash: string | null;
  receipt_hash: string | null;
  /** Every payment row the node billed for this call (miner/intent/amount/receipt_hash). */
  payments: Array<{ miner: string; intent: string; amount_uusdc: number; receipt_hash: string }>;
  /** The raw payment receipt the node returned (X-PAYMENT-RESPONSE), if any. */
  receipt: Record<string, unknown> | null;
  cost_uusdc: number;
  rail: string;
  fetched_at: string;
}

export interface M13ScenarioOutcome {
  run_id: string;
  scenario_id: string;
  mission: "M13";
  input: M13Input;
  decision: M13Result;
  calls: ScenarioCallRecord[];
  total_cost_uusdc: number;
}

export interface M12ScenarioOutcome {
  run_id: string;
  scenario_id: string;
  mission: "M12";
  input: M12Input;
  decision: M12Result;
  calls: ScenarioCallRecord[];
  total_cost_uusdc: number;
}

export function toCallRecord(ask: AskResult): ScenarioCallRecord {
  const paymentTotal = ask.payments.reduce((sum, p) => sum + (p.amount_uusdc || 0), 0);
  const cost =
    paymentTotal > 0
      ? paymentTotal
      : ask.receipt?.amount_uusdc !== undefined
        ? Number(ask.receipt.amount_uusdc)
        : 0;
  return {
    intent: ask.intent,
    params: ask.params,
    miner_id: ask.miner_id ?? null,
    miner_name: ask.miner_name ?? null,
    signal_hash: ask.signal_hash ?? null,
    receipt_hash:
      ask.payments[0]?.receipt_hash ?? ask.receipt?.receipt_hash ?? null,
    payments: ask.payments.map((p) => ({
      miner: p.miner,
      intent: p.intent,
      amount_uusdc: p.amount_uusdc,
      receipt_hash: p.receipt_hash,
    })),
    receipt: ask.receipt ? { ...ask.receipt } : null,
    cost_uusdc: Number.isFinite(cost) ? cost : 0,
    rail: ask.rail,
    fetched_at: ask.fetched_at,
  };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function buildM13Evidence(calls: AskResult[]): M13Evidence {
  const byIntent = new Map(calls.map((c) => [c.intent, c]));
  const tx = byIntent.get("ONCHAIN_TX_LOOKUP_GENERAL");
  const filings = byIntent.get("REGULATORY_FILING_MONITOR_GENERAL");
  const tvl = byIntent.get("TVL_LOOKUP_GENERAL");
  const route = byIntent.get("OPTIMAL_EXECUTION_ROUTE_GENERAL");
  const sanctions = byIntent.get("SANCTIONS_SCREENING_MATCH_GENERAL");
  const price = byIntent.get("CRYPTO_PRICE_USD");
  return {
    tx: tx
      ? {
          status: str(tx.result.status),
          // Chain comes ONLY from the answer body (result.chain). The
          // node's echoed input is our own request echoed back — using
          // it would make the chain check a tautology that always
          // passes. If the answer carries no chain, the field stays
          // absent and the policy marks the chain check unverifiable.
          chain: str(tx.result.chain),
          tx_hash: str(tx.result.tx_hash),
          from: str(tx.result.from),
          to: str(tx.result.to),
          block_number: num(tx.result.block_number),
          value_eth: num(tx.result.value_eth) ?? str(tx.result.value_eth),
        }
      : null,
    filings: filings
      ? { entity: str(filings.result.entity), filing_count: num(filings.result.filing_count) }
      : null,
    tvl: tvl
      ? { tvl_usd: num(tvl.result.tvl_usd), protocol_or_chain: str(tvl.result.protocol_or_chain) }
      : null,
    route: route
      ? {
          amount_out: num(route.result.amount_out),
          // Pair comes ONLY from the answer body. An answer that names
          // no pair leaves the field absent and the policy marks the
          // route check unverifiable — the ask params are our own
          // request echoed back, never evidence.
          pair: str(route.result.pair),
        }
      : null,
    sanctions:
      sanctions === undefined
        ? undefined
        : sanctions
          ? {
              matched:
                typeof sanctions.result.matched === "boolean"
                  ? sanctions.result.matched
                  : undefined,
              name: str(sanctions.result.name),
              match_score: num(sanctions.result.match_score),
              lists: Array.isArray(sanctions.result.lists)
                ? (sanctions.result.lists as unknown[]).filter((x): x is string => typeof x === "string")
                : undefined,
            }
          : null,
    price: price
      ? {
          price_usd: num(price.result.price_usd),
          // Symbol comes ONLY from the answer body. A missing symbol
          // stays missing — it is NEVER defaulted to "ETH": a default
          // would manufacture a binding the answer never carried, and
          // a BTC spot price would then "validate" an ETH quote.
          symbol: str(price.result.symbol),
        }
      : undefined,
  };
}

export function buildM12Evidence(calls: AskResult[]): M12Evidence {
  const byIntent = new Map(calls.map((c) => [c.intent, c]));
  const grid = byIntent.get("GRID_POWER_PRICE_GENERAL");
  const hashprice = byIntent.get("MINING_HASHPRICE_VERIFY_GENERAL");
  return {
    grid: grid
      ? {
          lmp_usd_per_mwh: num(grid.result.lmp_usd_per_mwh),
          node_or_zone: str(grid.result.node_or_zone),
          market: str(grid.result.market),
          interval_start: str(grid.result.interval_start),
          currency: str(grid.result.currency),
        }
      : null,
    hashprice: hashprice
      ? {
          hashprice_sats_per_ph_day: num(hashprice.result.hashprice_sats_per_ph_day),
          hashprice_usd_per_ph_day: num(hashprice.result.hashprice_usd_per_ph_day),
          block_height: num(hashprice.result.block_height),
        }
      : null,
  };
}

export const M13_INTENTS = [
  "ONCHAIN_TX_LOOKUP_GENERAL",
  "REGULATORY_FILING_MONITOR_GENERAL",
  "TVL_LOOKUP_GENERAL",
  "OPTIMAL_EXECUTION_ROUTE_GENERAL",
  "SANCTIONS_SCREENING_MATCH_GENERAL",
] as const;

/**
 * The intents a live M13 run through this code actually buys: the 5 own intents PLUS the
 * independent CRYPTO_PRICE_USD spot price (blueprint §7.3 lists it among
 * the M13 intents). An M13 run therefore costs 6 × $0.01 = $0.06.
 * Scenarios 11–20 buy only the first 4 own intents + CRYPTO_PRICE_USD
 * (5 calls); the missing sanctions screen is the blueprint-sanctioned
 * skip (§7.1 allows 4–5 intents, and the seed plan's own arithmetic —
 * 110 M13 / 140 total / $1.40 — drops it there; blueprint §7.3 itself
 * plans 90 M13 calls / 120+ total / ~$1.20 (ll. 556–558) and mandates nothing about
 * which scenarios drop sanctions) — see the seed runner.
 */
export const M13_RUN_INTENTS = [...M13_INTENTS, "CRYPTO_PRICE_USD"] as const;

export const M12_INTENTS = [
  "GRID_POWER_PRICE_GENERAL",
  "MINING_HASHPRICE_VERIFY_GENERAL",
] as const;

export function m13ParamsFor(intent: string, input: M13Input): Record<string, unknown> {
  switch (intent) {
    case "ONCHAIN_TX_LOOKUP_GENERAL":
      return { tx_hash: input.tx_hash, chain: input.chain };
    case "REGULATORY_FILING_MONITOR_GENERAL":
      return { entity: input.issuer_entity, period: input.period };
    case "TVL_LOOKUP_GENERAL":
      return { protocol: input.protocol };
    case "OPTIMAL_EXECUTION_ROUTE_GENERAL":
      return { pair: input.trade_pair };
    case "SANCTIONS_SCREENING_MATCH_GENERAL":
      return { name: input.issuer_entity };
    case "CRYPTO_PRICE_USD":
      return { symbol: "ETH" };
    default:
      throw new Error(`unknown M13 intent: ${intent}`);
  }
}

export function m12ParamsFor(
  intent: string,
  input: M12Input,
  blockHeight: number,
): Record<string, unknown> {
  switch (intent) {
    case "GRID_POWER_PRICE_GENERAL":
      return { node_or_zone: input.node_or_zone, interval_start: input.interval_start };
    case "MINING_HASHPRICE_VERIFY_GENERAL":
      return { block_height: blockHeight };
    default:
      throw new Error(`unknown M12 intent: ${intent}`);
  }
}

/** Buy one ranked intent for an M13 scenario. */
export async function executeM13Intent(
  client: TelegraphClient,
  intent: string,
  input: M13Input,
): Promise<AskResult> {
  return client.askRanked(intent, m13ParamsFor(intent, input));
}

/** Buy one ranked intent for an M12 scenario. */
export async function executeM12Intent(
  client: TelegraphClient,
  intent: string,
  input: M12Input,
  blockHeight: number,
): Promise<AskResult> {
  return client.askRanked(intent, m12ParamsFor(intent, input, blockHeight));
}

/** Decide an M13 scenario from its bought calls (pure policy). */
export function decideM13(input: M13Input, calls: AskResult[]): M13Result {
  return evaluateM13(input, buildM13Evidence(calls));
}

/** Decide an M12 scenario from its bought calls (pure policy). */
export function decideM12(
  input: M12Input,
  calls: AskResult[],
  opts: { expectedBlockHeight?: number; nowMs?: number } = {},
): M12Result {
  return evaluateM12(input, buildM12Evidence(calls), opts);
}

/** Per-call hook: invoked immediately after each ask resolves. */
export type OnDeskCall = (runId: string, call: ScenarioCallRecord) => void;

/** Run one full M13 allocation audit: 6 ranked calls, then the policy. */
export async function runM13Scenario(
  client: TelegraphClient,
  input: M13Input,
  scenarioId: string,
  opts: { onCall?: OnDeskCall } = {},
): Promise<M13ScenarioOutcome> {
  const runId = `desk_${randomUUID()}`;
  const calls: AskResult[] = [];
  for (const intent of M13_RUN_INTENTS) {
    const ask = await executeM13Intent(client, intent, input);
    calls.push(ask);
    // Log NOW, before buying the next call: a throw on a later ask
    // must not lose the spend already bought.
    opts.onCall?.(runId, toCallRecord(ask));
  }
  const decision = decideM13(input, calls);
  const records = calls.map(toCallRecord);
  return {
    run_id: runId,
    scenario_id: scenarioId,
    mission: "M13",
    input: decision.input,
    decision,
    calls: records,
    total_cost_uusdc: records.reduce((s, c) => s + c.cost_uusdc, 0),
  };
}

/** Live Bitcoin tip height (mempool.space, keyless) for the hashprice ask. */
export async function fetchBtcTipHeight(fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl("https://mempool.space/api/blocks/tip/height");
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`cannot read Bitcoin tip height: mempool.space HTTP ${res.status}`);
  }
  const height = Number(await res.text());
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error("cannot read Bitcoin tip height: mempool.space returned no integer height");
  }
  return height;
}

/** Run one full M12 dispatch check: 2 ranked calls, then the policy. */
export async function runM12Scenario(
  client: TelegraphClient,
  input: M12Input,
  scenarioId: string,
  opts: {
    blockHeight?: number;
    blockHeightFn?: () => Promise<number>;
    fetchImpl?: typeof fetch;
    nowMs?: number;
    onCall?: OnDeskCall;
  } = {},
): Promise<M12ScenarioOutcome> {
  const runId = `desk_${randomUUID()}`;
  const blockHeight =
    opts.blockHeight ??
    (opts.blockHeightFn ? await opts.blockHeightFn() : await fetchBtcTipHeight(opts.fetchImpl));
  const calls: AskResult[] = [];
  for (const intent of M12_INTENTS) {
    const ask = await executeM12Intent(client, intent, input, blockHeight);
    calls.push(ask);
    // Log NOW, before buying the next call (see runM13Scenario).
    opts.onCall?.(runId, toCallRecord(ask));
  }
  const decision = decideM12(input, calls, {
    expectedBlockHeight: blockHeight,
    nowMs: opts.nowMs,
  });
  const records = calls.map(toCallRecord);
  return {
    run_id: runId,
    scenario_id: scenarioId,
    mission: "M12",
    input: decision.input,
    decision,
    calls: records,
    total_cost_uusdc: records.reduce((s, c) => s + c.cost_uusdc, 0),
  };
}
