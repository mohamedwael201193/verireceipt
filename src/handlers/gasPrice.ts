import {feeContext} from './gasFeeContext';
// GAS_PRICE_GENERAL — GET /v1/gas-price?chain=
//
// Zero-LLM. Answers the current transaction fee level of a named chain
// from the chain's own verified keyless RPC legs (CHAIN_RPCS[chain]),
// as a 2-of-N exact-value quorum over eth_gasPrice, with a SHA-256
// receipt over the winning leg's exact raw response bytes. Fails closed:
// an RPC outage or a persistently split vote throws 502 and never
// guesses a fee level.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/GAS_PRICE_GENERAL,
// read 2026-11-22): input `chain` (string, required); scored output
// `gas_price_gwei` (number, unit gwei, 6 decimals, range 0..100000);
// `transfer_fee_usd` is an optional off_chain estimate; G4 serves it
// as a computed value only (live gwei x 21,000 gas x live Coinbase
// gas-token spot, formula disclosed in the answer and receipt) and
// refuses the answer outright when the spot is unavailable.
//
// Live behaviour measured 2026-11-22 before this handler was written:
// all three ethereum legs (blastapi, drpc, mevblocker) returned the
// IDENTICAL eth_gasPrice value across repeated calls (0x7b4ce61), so
// exact-value agreement is the norm. Transient splits happen when the
// fee moves mid-poll, so — like txLookup — a round with no agreeing
// pair is re-polled ONCE after 800 ms before failing closed:
//   - an agreeing pair after the re-poll wins;
//   - >= 2 successes with no agreeing pair is 502 QUORUM_DISAGREEMENT;
//   - < 2 successes is 502 QUORUM_UNREACHABLE;
//   - errored/timed-out legs are UNKNOWN, never counted either way.
// Sanity bound (intent contract range): a leg above 100000 gwei is
// absurd on every supported chain and is dropped as malformed, so the
// served answer is always inside the contract range by construction.
// G3: a served value of exactly 0 gwei fails closed with 502
// IMPLAUSIBLE_ZERO on every chain — an agreeing raw 0x0, or a dust
// value that rounds to 0 at the served 6dp precision, is a degenerate
// fee answer even where it is the true eth_gasPrice state (testnets
// with no fee market). A partial-zero split still serves the non-zero
// agreement.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, sha256Hex, type Receipt } from "../core/receipt";
import { CHAIN_RPCS } from "../config/chains";
import { saveReceipt } from "../core/storage";
import { HEX_QTY_RE, rpcCall } from "../core/evmRpc";
import { normalizeChain } from "./txLookup";

export const INTENT = "GAS_PRICE_GENERAL";

/** txLookup's chains plus avalanche (G2) and bsc: every CHAIN_RPCS key
 * with a verified keyless gas quorum. txLookup's own SUPPORTED_CHAINS
 * list is unchanged (tx verification on those chains is out of scope). */
const SUPPORTED_CHAINS = [
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "sepolia",
  "base-sepolia",
  "avalanche",
  "bsc",
];

/** Intent contract upper range bound for gas_price_gwei. */
const MAX_GAS_GWEI = 100000;
const MAX_GAS_WEI = BigInt(MAX_GAS_GWEI) * 1_000_000_000n;

/** Delay before the single re-poll of a split round (txLookup uses 800 ms). */
const REPOLL_DELAY_MS = 800;

/** Gas-token symbol per chain (L2s price gas in ETH). */
const GAS_TOKEN: Record<string, string> = {
  ethereum: "ETH",
  base: "ETH",
  arbitrum: "ETH",
  optimism: "ETH",
  polygon: "POL",
  avalanche: "AVAX",
  bsc: "BNB",
  sepolia: "ETH",
  "base-sepolia": "ETH",
};

/** USD cost of a plain 21,000-gas transfer at the given gwei level and
 * gas-token USD spot. Computed value only — never a heuristic. */
export function transferFeeUsd(gwei: number, tokenUsd: number): number {
  return (gwei * 21000 * tokenUsd) / 1e9;
}

/** Live gas-token USD spot from Coinbase (keyless, same spot source the
 * financial-data slice uses). Any failure REFUSES the whole answer
 * (502): transfer_fee_usd is a computed value and an unavailable input
 * is never estimated around. The response body is receipted. */
async function fetchGasTokenUsd(
  symbol: string,
  receiptBodies: string[],
): Promise<number> {
  const url = `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`;
  let res: Response;
  let rawText = "";
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
    rawText = await res.text();
  } catch {
    throw upstreamUnavailable(
      "SPOT_UNAVAILABLE",
      `gas-token USD spot unavailable (Coinbase ${symbol}-USD unreachable); transfer_fee_usd cannot be computed, refusing`,
    );
  }
  receiptBodies.push(rawText);
  if (!res.ok) {
    throw upstreamUnavailable(
      "SPOT_UNAVAILABLE",
      `gas-token USD spot unavailable (Coinbase ${symbol}-USD HTTP ${res.status}); transfer_fee_usd cannot be computed, refusing`,
    );
  }
  let body: { data?: { amount?: string } };
  try {
    body = JSON.parse(rawText) as { data?: { amount?: string } };
  } catch {
    throw upstreamUnavailable(
      "SPOT_UNAVAILABLE",
      `gas-token USD spot unparseable (Coinbase ${symbol}-USD not JSON); transfer_fee_usd cannot be computed, refusing`,
    );
  }
  const amount = Number(body?.data?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw upstreamUnavailable(
      "SPOT_UNAVAILABLE",
      `gas-token USD spot malformed (Coinbase ${symbol}-USD); transfer_fee_usd cannot be computed, refusing`,
    );
  }
  return amount;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GasLeg {
  rpcUrl: string;
  /** Canonical minimal hex quantity (lowercase, no leading zeros). */
  weiHex: string;
  wei: bigint;
  rawText: string;
}

/** Fetch one leg's eth_gasPrice. Throws on any RPC/parse failure. */
async function fetchGasLeg(rpcUrl: string): Promise<GasLeg> {
  const { result, rawText } = await rpcCall(rpcUrl, "eth_gasPrice", []);
  if (typeof result !== "string" || !HEX_QTY_RE.test(result)) {
    throw new Error(`malformed eth_gasPrice result from ${rpcUrl}`);
  }
  const wei = BigInt(result);
  if (wei > MAX_GAS_WEI) {
    throw new Error(`absurd eth_gasPrice result from ${rpcUrl}: ${result}`);
  }
  // Canonical form so 0x0A and 0xa from different legs compare equal.
  const weiHex = "0x" + wei.toString(16);
  return { rpcUrl, weiHex, wei, rawText };
}

interface Round {
  successes: GasLeg[];
  errored: number;
}

/** One sequential round over every leg of the chain. Never throws. */
async function fetchRound(rpcs: string[]): Promise<Round> {
  const successes: GasLeg[] = [];
  let errored = 0;
  for (const rpcUrl of rpcs) {
    try {
      successes.push(await fetchGasLeg(rpcUrl));
    } catch {
      errored++;
    }
  }
  return { successes, errored };
}

/** First value with at least two agreeing legs, else null. */
function agreeingPair(legs: GasLeg[]): { weiHex: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const leg of legs) {
    counts.set(leg.weiHex, (counts.get(leg.weiHex) ?? 0) + 1);
  }
  let best: { weiHex: string; count: number } | null = null;
  for (const [weiHex, count] of counts) {
    if (count >= 2 && (best === null || count > best.count)) {
      best = { weiHex, count };
    }
  }
  return best;
}

// Optional fee-market context is a separate exact2-of-N tuple vote. Never
// derive a priority tip by subtracting gasPrice/baseFee, or claim a fee cap.

export async function handleGasPrice(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  for (const key of Object.keys(query)) if (key !== "chain") throw badRequest("UNKNOWN_PARAM", "Only chain is supported");
  const supplied = query.chain ?? "";
  console.info(JSON.stringify({ event: "gas_chain_request", value: supplied.slice(0,80), truncated: supplied.length > 80 }));
  const chainRaw = supplied.trim();
  const normalized = normalizeChain(chainRaw);
  // Explicit identifiers for networks already backed by the existing verified RPC set.
  const ids: Record<string,string> = { "1":"ethereum", "8453":"base", "42161":"arbitrum", "10":"optimism", "137":"polygon", "11155111":"sepolia", "84532":"base-sepolia", "43114":"avalanche", "56":"bsc" };
  const requested = ids[normalized?.replace(/^eip155:/, "") ?? ""] ?? normalized;
  const unsupported = Boolean(chainRaw) && (!requested || !SUPPORTED_CHAINS.includes(requested) || !CHAIN_RPCS[requested]);
  const defaulted = !chainRaw || unsupported;
  const chain = defaulted ? "ethereum" : requested!;
  const rpcs = CHAIN_RPCS[chain];
  const total = rpcs.length;

  let round = await fetchRound(rpcs);
  let pair = agreeingPair(round.successes);
  if (pair === null) {
    // Transient fee moves split the vote; re-poll every leg ONCE after a
    // short settle, then fail closed on a still-split round (never guess).
    await sleep(REPOLL_DELAY_MS);
    round = await fetchRound(rpcs);
    pair = agreeingPair(round.successes);
  }
  if (pair === null) {
    if (round.successes.length >= 2) {
      throw upstreamUnavailable(
        "QUORUM_DISAGREEMENT",
        `quorum disagreement: ${round.successes.length} sources answered eth_gasPrice on ${chain} but no two agreed`,
      );
    }
    throw upstreamUnavailable(
      "QUORUM_UNREACHABLE",
      `quorum unreachable: only ${round.successes.length} of ${total} sources answered eth_gasPrice on ${chain}`,
    );
  }

  // Mainnet G3 keeps six-decimal zero refusal. Testnets refuse exact zero only.
  const testnet = chain === 'sepolia' || chain === 'base-sepolia';
  const winner = round.successes.find((leg) => leg.weiHex === pair!.weiHex)!;
  const gasPriceGwei = testnet ? Number(winner.wei) / 1e9 : Math.round((Number(winner.wei) / 1e9) * 1e6) / 1e6;
  if (testnet ? winner.wei === 0n : gasPriceGwei === 0) {
    throw upstreamUnavailable(
      "IMPLAUSIBLE_ZERO",
      `implausible eth_gasPrice 0 gwei on ${chain}: ${pair.count} of ${total} sources agreed on ${winner.weiHex === "0x0" ? "exactly zero" : `${winner.wei} wei, which rounds to 0 gwei`}; refusing to serve an implausible fee level`,
    );
  }
  const votes = `${pair.count}/${total} sources agreed`;
  const asOf = new Date().toISOString();

  // G4: transfer_fee_usd, computed only — live gas price x 21,000 gas
  // x live gas-token USD spot (Coinbase). The formula is disclosed in
  // the answer and the receipt; an unavailable spot refuses the answer.
  const tokenSymbol = GAS_TOKEN[chain] ?? "ETH";
  const spotBodies: string[] = [];
  const tokenUsd = testnet ? null : await fetchGasTokenUsd(tokenSymbol, spotBodies);
  const usdFee = tokenUsd === null ? null : Math.round(transferFeeUsd(gasPriceGwei, tokenUsd) * 1e6) / 1e6;
  // G4b: a computed fee outside [0, 10000] USD for a plain transfer is
  // implausible on every supported chain — refuse, never serve it.
  if (usdFee !== null && !(usdFee >= 0 && usdFee <= 10000)) {
    throw upstreamUnavailable(
      "IMPLAUSIBLE_VALUE",
      `computed transfer_fee_usd ${usdFee} USD is outside the plausible 0..10000 range; refusing to serve it`,
    );
  }
  const formula = `${gasPriceGwei} gwei x 21000 gas x ${tokenSymbol} $${Math.round((tokenUsd ?? 0) * 100) / 100} (Coinbase spot) / 1e9`;

  const context = await feeContext(rpcs);
  const fields: Record<string, unknown> = {
    base_fee_gwei:null,priority_fee_gwei:null,block_number:null,fee_context_quorum:null,
    ...(context?.fields ?? {fee_context_scope:"fee context unavailable; no agreeing fixed-block hash/base fee quorum, capacity or source unavailable; nothing estimated"}),
    chain,
    gas_price_gwei: gasPriceGwei,
    ...(testnet ? {gas_price_wei:winner.wei.toString(),transfer_fee_usd_reason:"Testnet gas token has no mainnet USD valuation; no USD fee computed"}:{}),
    transfer_fee_usd: usdFee,
    as_of: asOf,
  };

  const defaultDisclosure = unsupported ? "Requested chain was not served; defaulted to ethereum; Ethereum quorum only" : !chainRaw ? "No chain given; defaulted to ethereum" : "";
  const evidence = context ? JSON.stringify({gas_price_raw:winner.rawText,fee_context:context.evidence}) : winner.rawText;
  const receiptDoc: Receipt = makeReceipt(INTENT, winner.rpcUrl, evidence, votes + (defaultDisclosure ? `; ${defaultDisclosure}` : ""));
  if (!testnet) receiptDoc.gas_token_spot = {
    source: `Coinbase ${tokenSymbol}-USD spot`,
    token_usd: tokenUsd,
    formula: `transfer_fee_usd = ${formula}`,
    sha256: sha256Hex(spotBodies[0]),
  };
  try {
    await saveReceipt(receiptDoc, evidence);
  } catch {
    throw upstreamUnavailable(
      "RECEIPT_PERSIST_FAILED",
      "receipt evidence could not be stored; answer unavailable",
    );
  }

  return envelope(INTENT, fields, receiptDoc, {
    answer: testnet ? `${chain==='sepolia'?'Sepolia':'Base Sepolia'} testnet gas price is ${winner.wei} wei (${gasPriceGwei.toFixed(9).replace(/\.?0+$/,'')} gwei), ${votes}. Testnet gas is near zero; this is the real quorum value. USD transfer fee unavailable: testnet gas token has no mainnet USD valuation.` : (context ? `Fee context: block ${fields.block_number}, base fee ${fields.base_fee_gwei} gwei, suggested priority ${fields.priority_fee_gwei===null?'unavailable (no agreeing suggestion)':fields.priority_fee_gwei+' gwei'} (${fields.fee_context_quorum}). Priority is a contemporaneous node suggestion, not a block-bound or future quote. ` : "Base fee, priority fee and block context unavailable; not estimated. ") + (defaulted
      ? `Current gas price on ethereum: ${gasPriceGwei} gwei (${unsupported ? "Requested chain was not served; defaulted to ethereum, not a quote for the requested chain" : "no chain given; defaulted to ethereum"}. ${votes}). 21,000-gas transfer ≈ $${usdFee} = ${formula}. Not a quote for a future transaction; the price moves block to block.`
      : `Current gas price on ${chain}: ${gasPriceGwei} gwei (${votes}). 21,000-gas transfer ≈ $${usdFee} = ${formula}. Not a quote for a future transaction; the price moves block to block.`),
    verdict: "verified",
    confidence: pair.count === total ? 1.0 : 0.9,
    source: `EVM RPC quorum (${chain}, 2-of-${total})`,
  });
}
