// VeriReceipt Desk — Mission 13 Asset Allocation gate (policyM13.ts).
//
// Pure deterministic policy: NO network, NO LLM, NO invented values.
// Inputs are the proposed allocation plus evidence bought live from
// Telegraph ranked intents (POST /engine/v1/ask). The policy only reads
// the evidence it is handed; it never fetches, estimates, or backfills.
//
// Verdicts: APPROVE / HOLD / REJECT. Fail-closed by construction:
//   - any check with status "reject"  -> REJECT (counterparty tx reverted
//     or not found, sanctions match, chain mismatch, tx-hash mismatch,
//     route-pair mismatch)
//   - any check "hold" or "unverifiable" -> HOLD (never APPROVE on doubt)
//   - APPROVE only when every applicable check passes.
// A check whose evidence was deliberately not bought in this run is
// "skipped" and is named as such in the Why box. After the round-2 fix
// the ONLY such check is sanctions in scenarios 11–20 (see below); a
// missing spot price is NOT skipped — it is "unverifiable" and blocks
// APPROVE, because a quote that cannot be checked against spot must
// never clear on no evidence.
//
// FAIL-CLOSED MAP (omitted required field -> HOLD/REJECT, never a pass):
//   tx.status missing/unknown      -> unverifiable (HOLD)
//   tx.chain missing               -> unverifiable (HOLD)
//   tx.chain != requested chain    -> reject (REJECT)
//   tx.tx_hash missing             -> unverifiable (HOLD)
//   tx.tx_hash != requested hash   -> reject (REJECT)
//   filings.entity missing         -> hold (HOLD — no identity to bind)
//   filings.entity != requested    -> unverifiable (HOLD)
//   filings.filing_count missing/0 -> unverifiable (HOLD)
//   tvl.protocol_or_chain missing  -> hold (HOLD — no identity to bind)
//   tvl.protocol != requested      -> unverifiable (HOLD)
//   tvl_usd missing / below $1M   -> unverifiable / hold (HOLD)
//   route.amount_out missing       -> unverifiable (HOLD)
//   route.pair missing             -> unverifiable (HOLD — no pair to bind)
//   route.pair != requested pair   -> reject (REJECT — quote belongs to
//     another market, like a tx_hash mismatch)
//   route.amount_out out of range  -> hold (HOLD)
//   price missing (not bought)     -> unverifiable (HOLD — the quote
//     cannot be checked against spot, so the allocation cannot clear)
//   price.price_usd missing / <= 0 -> unverifiable (HOLD)
//   price.symbol missing           -> unverifiable (HOLD — asset unknown)
//   price.symbol != ETH            -> hold (HOLD — a spot price for
//     another asset cannot validate an ETH/USDC quote)
//   sanctions not bought           -> skipped, NAMED in the Why box.
//     This is the ONE named exception, and it is blueprint-sanctioned:
//     §7.1 allows 4–5 intents, and the seed plan's own arithmetic
//     (110 M13 / 140 total / $1.40) drops the screen in scenarios
//     11–20. Blueprint §7.3 (ll. 556–558) itself plans 90 M13 calls across 20
//     scenarios (120+ total, ~$1.20) and mandates nothing about
//     which scenarios drop sanctions. The skip is documented, not
//     hidden, and it never passes silently.
//   sanctions.matched missing      -> unverifiable (HOLD)
//   sanctions.name missing         -> unverifiable (HOLD — no identity
//     to bind the screening to)
//   sanctions.name != requested issuer -> unverifiable (HOLD — the
//     screening does not cover the issuer)
//   sanctions.matched === true     -> reject (REJECT)
// Every check always emits a non-empty reason (the UI contract).
//
// Thresholds (all strict, all documented here — change them here, not in
// a caller):
//   - Institutional TVL minimum: $1,000,000 (below -> HOLD, too thin).
//   - Route/spot consistency: execution quote implied ETH price must be
//     within 2% of the independent CRYPTO_PRICE_USD spot (else HOLD).
//   - Route amount_out must lie inside the intent's own declared range
//     [100,000,000 , 100,000,000,000] USDC base units (else HOLD).
//   - Sanctions: matched === true -> REJECT at any match_score.
//   - Filings: zero filings for the issuer in the period -> HOLD
//     (issuer standing unverifiable), never APPROVE.

import { ApiError, badRequest, unprocessable } from "../core/errors";

export type M13Verdict = "APPROVE" | "HOLD" | "REJECT";

export type CheckStatus = "pass" | "hold" | "reject" | "unverifiable" | "skipped";

export interface M13Check {
  id: string;
  name: string;
  status: CheckStatus;
  reason: string;
  detail?: string;
}

export interface M13Input {
  protocol: string;
  tx_hash: string;
  chain: string;
  issuer_entity: string;
  period: string;
  trade_pair: string;
}

export interface M13TxEvidence {
  status?: string;
  chain?: string;
  tx_hash?: string;
  from?: string;
  to?: string;
  block_number?: number;
  value_eth?: number | string;
}

export interface M13FilingsEvidence {
  entity?: string;
  filing_count?: number;
}

export interface M13TvlEvidence {
  tvl_usd?: number;
  protocol_or_chain?: string;
}

export interface M13RouteEvidence {
  amount_out?: number;
  /** Pair the quote is for, read from the answer body (e.g. "ETH/USDC"). */
  pair?: string;
}

export interface M13PriceEvidence {
  price_usd?: number;
  symbol?: string;
}

export interface M13SanctionsEvidence {
  matched?: boolean;
  name?: string;
  match_score?: number;
  lists?: string[];
}

export interface M13Evidence {
  tx?: M13TxEvidence | null;
  filings?: M13FilingsEvidence | null;
  tvl?: M13TvlEvidence | null;
  route?: M13RouteEvidence | null;
  price?: M13PriceEvidence | null;
  sanctions?: M13SanctionsEvidence | null;
}

export interface M13Result {
  verdict: M13Verdict;
  checks: M13Check[];
  /** Explainability Why box: one plain line per check, in check order. */
  why: string[];
  input: M13Input;
}

/** Institutional minimum protocol TVL (USD) for an allocation to clear. */
export const M13_MIN_TVL_USD = 1_000_000;
/** Max |route-implied price - spot| / spot before the quote is distrusted. */
export const M13_MAX_ROUTE_DEVIATION = 0.02;
/** Declared amount_out range of OPTIMAL_EXECUTION_ROUTE_GENERAL (USDC base units). */
export const M13_ROUTE_AMOUNT_OUT_MIN = 100_000_000;
export const M13_ROUTE_AMOUNT_OUT_MAX = 100_000_000_000;

const SUPPORTED_CHAINS = new Set([
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "sepolia",
]);

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Validate the scenario inputs. Throws ApiError 400/422 — never a verdict. */
export function validateM13Input(input: M13Input): M13Input {
  const protocol = (input.protocol ?? "").trim();
  const txHash = (input.tx_hash ?? "").trim();
  const chain = (input.chain ?? "").trim().toLowerCase();
  const issuer = (input.issuer_entity ?? "").trim();
  const period = (input.period ?? "").trim();
  const pair = (input.trade_pair ?? "").trim().toUpperCase();

  if (!protocol) throw badRequest("INVALID_PROTOCOL", "protocol must be a non-empty string");
  if (protocol.length > 128) {
    throw badRequest("INVALID_PROTOCOL", "protocol must be at most 128 characters");
  }
  if (!TX_HASH_RE.test(txHash)) {
    throw badRequest(
      "INVALID_TX_HASH",
      "tx_hash must be a 0x-prefixed 64-hex-character transaction hash",
    );
  }
  if (!SUPPORTED_CHAINS.has(chain)) {
    throw badRequest(
      "INVALID_CHAIN",
      `chain must be one of: ${[...SUPPORTED_CHAINS].join(", ")}`,
    );
  }
  if (!issuer) {
    throw badRequest("INVALID_ISSUER", "issuer_entity must be a non-empty string");
  }
  if (issuer.length > 256) {
    throw badRequest("INVALID_ISSUER", "issuer_entity must be at most 256 characters");
  }
  if (!period) throw badRequest("INVALID_PERIOD", "period must be a non-empty string");
  if (period.length > 64) {
    throw badRequest("INVALID_PERIOD", "period must be at most 64 characters");
  }
  if (pair !== "ETH/USDC") {
    throw unprocessable(
      "UNSUPPORTED_TRADE_PAIR",
      `trade_pair ${pair || "(empty)"} is not supported: only ETH/USDC can be verified against a live execution route`,
    );
  }
  return { protocol, tx_hash: txHash, chain, issuer_entity: issuer, period, trade_pair: pair };
}

function checkTxStatus(input: M13Input, ev: M13Evidence): M13Check {
  const base = { id: "tx_status", name: "Counterparty transaction status" };
  const tx = ev.tx ?? null;
  if (!tx || typeof tx.status !== "string" || !tx.status) {
    return {
      ...base,
      status: "unverifiable",
      reason: "Counterparty transaction could not be retrieved from the ranked lookup.",
    };
  }
  const status = tx.status.toLowerCase();
  if (status === "confirmed") {
    return {
      ...base,
      status: "pass",
      reason: "Counterparty transaction is confirmed on chain.",
      detail: tx.block_number !== undefined ? `block ${tx.block_number}` : undefined,
    };
  }
  if (status === "reverted") {
    return {
      ...base,
      status: "reject",
      reason: "Counterparty transaction reverted on chain — the execution it evidences did not settle.",
    };
  }
  if (status === "not_found") {
    return {
      ...base,
      status: "reject",
      reason: "Counterparty transaction does not exist on the requested chain.",
    };
  }
  if (status === "pending") {
    return {
      ...base,
      status: "unverifiable",
      reason: "Counterparty transaction is still pending — settlement is not proven.",
    };
  }
  return {
    ...base,
    status: "unverifiable",
    reason: `Counterparty transaction status "${tx.status}" is not a recognised settled state.`,
  };
}

function checkTxHash(input: M13Input, ev: M13Evidence): M13Check {
  const base = { id: "tx_hash", name: "Counterparty transaction hash match" };
  const tx = ev.tx ?? null;
  if (!tx || typeof tx.tx_hash !== "string" || !tx.tx_hash) {
    return {
      ...base,
      status: "unverifiable",
      reason: "Lookup returned no transaction hash, so the answer cannot be bound to the requested transaction.",
    };
  }
  if (tx.tx_hash.trim().toLowerCase() !== input.tx_hash.trim().toLowerCase()) {
    return {
      ...base,
      status: "reject",
      reason: `Lookup answered for transaction "${tx.tx_hash}", not the requested "${input.tx_hash}" — the evidence belongs to another transaction.`,
    };
  }
  return { ...base, status: "pass", reason: "Lookup answered for the requested transaction hash." };
}

function checkTxChain(input: M13Input, ev: M13Evidence): M13Check {
  const base = { id: "tx_chain", name: "Counterparty transaction chain match" };
  const tx = ev.tx ?? null;
  if (!tx || typeof tx.chain !== "string" || !tx.chain) {
    return {
      ...base,
      status: "unverifiable",
      reason: "Lookup returned no chain for the counterparty transaction, so the chain cannot be checked.",
    };
  }
  if (tx.chain.trim().toLowerCase() !== input.chain) {
    return {
      ...base,
      status: "reject",
      reason: `Counterparty transaction is on chain "${tx.chain}", not the requested "${input.chain}".`,
    };
  }
  return { ...base, status: "pass", reason: `Counterparty transaction is on ${input.chain} as requested.` };
}

function checkSanctions(input: M13Input, ev: M13Evidence): M13Check {
  const base = { id: "sanctions", name: "Sanctions screening (issuer)" };
  const s = ev.sanctions;
  if (s === undefined) {
    return {
      ...base,
      status: "skipped",
      reason: "No sanctions-screening evidence was bought in this run.",
    };
  }
  if (s === null || typeof s.matched !== "boolean") {
    return {
      ...base,
      status: "unverifiable",
      reason: "Sanctions screening returned no usable match verdict for the issuer.",
    };
  }
  // The match verdict is meaningless unless the screening names the
  // issuer it screened: a "no match" for an unnamed (or different)
  // entity does not cover the requested issuer, so it cannot pass.
  if (typeof s.name !== "string" || !s.name.trim()) {
    return {
      ...base,
      status: "unverifiable",
      reason: "Sanctions screening names no entity, so the match verdict cannot be bound to the requested issuer.",
    };
  }
  if (norm(s.name) !== norm(input.issuer_entity)) {
    return {
      ...base,
      status: "unverifiable",
      reason: `Sanctions screening names "${s.name}", not the requested issuer "${input.issuer_entity}" — the screening does not cover the issuer.`,
    };
  }
  if (s.matched) {
    return {
      ...base,
      status: "reject",
      reason: `Issuer "${input.issuer_entity}" matched a sanctions-list entry${s.lists?.length ? ` (${s.lists.join(", ")})` : ""}.`,
      detail: s.match_score !== undefined ? `match_score ${s.match_score}` : undefined,
    };
  }
  return {
    ...base,
    status: "pass",
    reason: `Issuer "${input.issuer_entity}" has no sanctions-list match.`,
    detail: s.match_score !== undefined ? `match_score ${s.match_score}` : undefined,
  };
}

function checkFilings(input: M13Input, ev: M13Evidence): M13Check {
  const base = { id: "filings", name: "Issuer regulatory filings in period" };
  const f = ev.filings ?? null;
  if (!f || typeof f.filing_count !== "number" || !Number.isFinite(f.filing_count)) {
    return {
      ...base,
      status: "unverifiable",
      reason: "No usable filing count was returned for the issuer in the requested period.",
    };
  }
  if (!f.entity) {
    return {
      ...base,
      status: "hold",
      reason: "Filings answer names no entity, so the count cannot be bound to the requested issuer.",
    };
  }
  if (norm(f.entity) !== norm(input.issuer_entity)) {
    return {
      ...base,
      status: "unverifiable",
      reason: `Filings answer names entity "${f.entity}", not the requested issuer "${input.issuer_entity}".`,
    };
  }
  if (f.filing_count === 0) {
    return {
      ...base,
      status: "unverifiable",
      reason: `No regulatory filings found for "${input.issuer_entity}" in period "${input.period}" — issuer standing cannot be verified.`,
    };
  }
  return {
    ...base,
    status: "pass",
    reason: `${f.filing_count} regulatory filing(s) found for "${input.issuer_entity}" in period "${input.period}".`,
  };
}

function checkTvl(input: M13Input, ev: M13Evidence): M13Check {
  const base = { id: "tvl", name: "Protocol TVL above institutional minimum" };
  const t = ev.tvl ?? null;
  if (!t || typeof t.tvl_usd !== "number" || !Number.isFinite(t.tvl_usd)) {
    return {
      ...base,
      status: "unverifiable",
      reason: "No usable TVL figure was returned for the protocol.",
    };
  }
  if (!t.protocol_or_chain) {
    return {
      ...base,
      status: "hold",
      reason: "TVL answer names no protocol, so the figure cannot be bound to the requested protocol.",
    };
  }
  if (norm(t.protocol_or_chain) !== norm(input.protocol)) {
    return {
      ...base,
      status: "unverifiable",
      reason: `TVL answer names protocol "${t.protocol_or_chain}", not the requested "${input.protocol}".`,
    };
  }
  if (t.tvl_usd < M13_MIN_TVL_USD) {
    return {
      ...base,
      status: "hold",
      reason: `Protocol TVL $${t.tvl_usd.toLocaleString("en-US")} is below the $${M13_MIN_TVL_USD.toLocaleString("en-US")} institutional minimum — too thin to allocate.`,
    };
  }
  return {
    ...base,
    status: "pass",
    reason: `Protocol TVL $${t.tvl_usd.toLocaleString("en-US")} clears the $${M13_MIN_TVL_USD.toLocaleString("en-US")} minimum.`,
  };
}

function checkRoute(input: M13Input, ev: M13Evidence): M13Check {
  const base = { id: "route", name: "Execution route quote in declared range" };
  const r = ev.route ?? null;
  if (!r || typeof r.amount_out !== "number" || !Number.isFinite(r.amount_out)) {
    return {
      ...base,
      status: "unverifiable",
      reason: "No usable execution quote was returned for selling 1 ETH for USDC.",
    };
  }
  // The quote must name the pair it is for: a quote for another market
  // is evidence about the wrong trade (reject, like a tx_hash
  // mismatch); a quote naming no pair cannot be bound at all (hold).
  if (typeof r.pair !== "string" || !r.pair.trim()) {
    return {
      ...base,
      status: "unverifiable",
      reason: "Execution quote names no pair, so it cannot be bound to the requested ETH/USDC route.",
    };
  }
  if (r.pair.trim().toUpperCase() !== input.trade_pair) {
    return {
      ...base,
      status: "reject",
      reason: `Execution quote is for pair "${r.pair}", not the requested "${input.trade_pair}" — the quote belongs to another market.`,
    };
  }
  if (r.amount_out < M13_ROUTE_AMOUNT_OUT_MIN || r.amount_out > M13_ROUTE_AMOUNT_OUT_MAX) {
    return {
      ...base,
      status: "hold",
      reason: `Execution quote amount_out ${r.amount_out} USDC base units lies outside the intent's declared range [${M13_ROUTE_AMOUNT_OUT_MIN}, ${M13_ROUTE_AMOUNT_OUT_MAX}].`,
    };
  }
  const impliedUsd = r.amount_out / 1_000_000;
  return {
    ...base,
    status: "pass",
    reason: `Execution quote for 1 ETH is $${impliedUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC, inside the declared range.`,
  };
}

function checkRouteVsSpot(input: M13Input, ev: M13Evidence): M13Check {
  const base = { id: "route_vs_spot", name: "Execution quote vs independent spot price" };
  const price = ev.price;
  if (price === undefined) {
    // Fail closed: a missing spot price is "unverifiable" and blocks
    // APPROVE. It is never "skipped" into an approval — the only
    // named skip in this policy is the blueprint-sanctioned sanctions
    // skip. Runs through the current code always buy CRYPTO_PRICE_USD, so
    // on such a run this is computed; an unverifiable here is a property
    // of hand-built evidence — or of the settled runs, which bought 5
    // calls and no spot price — not of a run through the current code.
    return {
      ...base,
      status: "unverifiable",
      reason: "No independent spot-price evidence was bought in this run — the execution quote cannot be checked against spot, so the allocation cannot clear.",
    };
  }
  const route = ev.route ?? null;
  if (
    price === null ||
    typeof price.price_usd !== "number" ||
    !Number.isFinite(price.price_usd) ||
    price.price_usd <= 0
  ) {
    return {
      ...base,
      status: "unverifiable",
      reason: "Independent spot price returned no usable ETH/USD figure.",
    };
  }
  // The spot price must name the asset it prices: a price for another
  // asset (or an unnamed one) cannot validate an ETH/USDC quote. The
  // route's base asset is the trade pair's base (ETH for ETH/USDC).
  const baseAsset = input.trade_pair.split("/")[0] ?? "ETH";
  if (typeof price.symbol !== "string" || !price.symbol.trim()) {
    return {
      ...base,
      status: "unverifiable",
      reason: "Independent spot price names no symbol, so it cannot be bound to the ETH route — a price for an unknown asset cannot validate the quote.",
    };
  }
  if (price.symbol.trim().toUpperCase() !== baseAsset) {
    return {
      ...base,
      status: "hold",
      reason: `Independent spot price is for ${price.symbol.trim().toUpperCase()}, not ${baseAsset} — it cannot validate an ${input.trade_pair} execution quote.`,
    };
  }
  if (!route || typeof route.amount_out !== "number" || !Number.isFinite(route.amount_out)) {
    return {
      ...base,
      status: "unverifiable",
      reason: "No execution quote to compare against the spot price.",
    };
  }
  const implied = route.amount_out / 1_000_000;
  const deviation = Math.abs(implied - price.price_usd) / price.price_usd;
  if (deviation > M13_MAX_ROUTE_DEVIATION) {
    return {
      ...base,
      status: "hold",
      reason: `Execution quote $${implied.toLocaleString("en-US", { maximumFractionDigits: 2 })} deviates ${(deviation * 100).toFixed(2)}% from independent spot $${price.price_usd.toLocaleString("en-US", { maximumFractionDigits: 2 })} (limit ${(M13_MAX_ROUTE_DEVIATION * 100).toFixed(0)}%).`,
    };
  }
  return {
    ...base,
    status: "pass",
    reason: `Execution quote $${implied.toLocaleString("en-US", { maximumFractionDigits: 2 })} is within ${(deviation * 100).toFixed(2)}% of independent spot $${price.price_usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}.`,
  };
}

/**
 * Evaluate a Mission 13 allocation. Pure function: no I/O, no randomness.
 * Throws ApiError on invalid inputs (400/422) — a refusal, never a verdict.
 */
export function evaluateM13(rawInput: M13Input, evidence: M13Evidence): M13Result {
  const input = validateM13Input(rawInput);
  const checks: M13Check[] = [
    checkTxStatus(input, evidence),
    checkTxChain(input, evidence),
    checkTxHash(input, evidence),
    checkSanctions(input, evidence),
    checkFilings(input, evidence),
    checkTvl(input, evidence),
    checkRoute(input, evidence),
    checkRouteVsSpot(input, evidence),
  ];

  let verdict: M13Verdict = "APPROVE";
  if (checks.some((c) => c.status === "reject")) verdict = "REJECT";
  else if (checks.some((c) => c.status === "hold" || c.status === "unverifiable")) verdict = "HOLD";

  const why = checks.map(
    (c) => `${c.status === "pass" ? "PASS" : c.status.toUpperCase()} — ${c.name}: ${c.reason}`,
  );
  return { verdict, checks, why, input };
}
