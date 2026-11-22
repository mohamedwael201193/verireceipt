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
// `transfer_fee_usd` is an optional off_chain estimate that needs a
// price feed and is NOT served (omitting an optional field is honest;
// inventing one is not).
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
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, type Receipt } from "../core/receipt";
import { CHAIN_RPCS } from "../config/chains";
import { saveReceipt } from "../core/storage";
import { HEX_QTY_RE, rpcCall } from "../core/evmRpc";
import { normalizeChain } from "./txLookup";

export const INTENT = "GAS_PRICE_GENERAL";

/** Same chains txLookup serves — every CHAIN_RPCS key. */
const SUPPORTED_CHAINS = [
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "sepolia",
  "base-sepolia",
];

/** Intent contract upper range bound for gas_price_gwei. */
const MAX_GAS_GWEI = 100000;
const MAX_GAS_WEI = BigInt(MAX_GAS_GWEI) * 1_000_000_000n;

/** Delay before the single re-poll of a split round (txLookup uses 800 ms). */
const REPOLL_DELAY_MS = 800;

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

export async function handleGasPrice(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const chainRaw = query.chain?.trim();
  const chain = normalizeChain(chainRaw);
  if (!chain) {
    throw badRequest("MISSING_PARAM", "chain is a required query parameter");
  }
  const rpcs = CHAIN_RPCS[chain];
  if (!rpcs || !SUPPORTED_CHAINS.includes(chain)) {
    throw badRequest(
      "UNSUPPORTED_CHAIN",
      `unsupported chain: ${chain}; expected one of ${SUPPORTED_CHAINS.join(", ")}`,
    );
  }
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

  const winner = round.successes.find((leg) => leg.weiHex === pair!.weiHex)!;
  const votes = `${pair.count}/${total} sources agreed`;
  const gasPriceGwei = Math.round((Number(winner.wei) / 1e9) * 1e6) / 1e6;
  const asOf = new Date().toISOString();

  const fields: Record<string, unknown> = {
    chain,
    gas_price_gwei: gasPriceGwei,
    as_of: asOf,
  };

  const receiptDoc: Receipt = makeReceipt(INTENT, winner.rpcUrl, winner.rawText, votes);
  try {
    await saveReceipt(receiptDoc, winner.rawText);
  } catch (err) {
    console.warn(
      `verireceipt: failed to persist GAS_PRICE receipt ${receiptDoc.receipt_id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return envelope(INTENT, fields, receiptDoc, {
    answer: `Current gas price on ${chain}: ${gasPriceGwei} gwei (${votes}).`,
    verdict: "verified",
    confidence: pair.count === total ? 1.0 : 0.9,
    source: `EVM RPC quorum (${chain}, 2-of-${total})`,
  });
}
