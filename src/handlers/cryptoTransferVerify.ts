// CRYPTO_TRANSFER_VERIFY_GENERAL — GET /v1/crypto-transfer?tx_hash=<h>&chain=<c>[&token=<addr>&from=<addr>&to=<addr>&amount=<base_units>]
//
// Zero-LLM. Verifies a transfer from the on-chain transaction receipt:
// an ERC-20 Transfer log (when `token` is given) or the native value
// transfer (otherwise). SHA-256 receipt over the quorum-agreed evidence.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/CRYPTO_TRANSFER_VERIFY_GENERAL,
// read 2026-11-22): registered bootstrap intent with no response format
// yet; the family shape is tx_hash + chain in, verified bool out.
//
// QUORUM (copied from txLookup's reviewed doctrine, not refactored):
// the chain's configured public RPCs are polled SEQUENTIALLY, one POST
// at a time with a 12s budget each (concurrent fan-out self-times-out);
// an answer needs at least two legs whose answer-relevant receipt
// projection (effective status, from, to, logs) is identical, else an
// honest 502. Endpoint-dependent envelope fields (l1Fee, pre-Byzantium
// root-vs-status) are excluded from the projection on purpose.
//
// MATCHING: only what the receipt carries is verified. Expectations not
// provided are not checked; every checked field is named in the answer.
// A successful receipt without a matching transfer is verified=false
// with the reason, never an error. `amount` is always base units
// (wei for native, the token's smallest unit for ERC-20) — decimal
// scaling is never guessed.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, stableStringify } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { CHAIN_RPCS } from "../config/chains";
import { normalizeChain } from "./txLookup";

const RPC_TIMEOUT_MS = 12000;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export const INTENT = "CRYPTO_TRANSFER_VERIFY_GENERAL";
export const SUPPORTED = Object.keys(CHAIN_RPCS);

interface RpcLog { address: string; topics: string[]; data: string }
interface ReceiptProjection { status: number; from: string; to: string | null; logs: { address: string; topics: string[]; data: string }[] }

/** Effective status: 1/0 from `status`, 1 when only pre-Byzantium `root` is present (copied from txLookup's receipt doctrine). */
export function effectiveStatus(receipt: Record<string, unknown>): number {
  if (typeof receipt.status === "string") return receipt.status === "0x1" ? 1 : 0;
  if (typeof receipt.root === "string") return 1;
  return 0;
}

export function projectReceipt(receipt: Record<string, unknown>): ReceiptProjection {
  const logs = (Array.isArray(receipt.logs) ? receipt.logs : []) as Record<string, unknown>[];
  return {
    status: effectiveStatus(receipt),
    from: String(receipt.from ?? "").toLowerCase(),
    to: typeof receipt.to === "string" ? receipt.to.toLowerCase() : null,
    logs: logs.map((l) => ({
      address: String(l.address ?? "").toLowerCase(),
      topics: (Array.isArray(l.topics) ? l.topics : []).map((t) => String(t).toLowerCase()),
      data: String(l.data ?? "0x").toLowerCase(),
    })),
  };
}

export interface TransferMatch { kind: "erc20" | "native"; from: string; to: string; amount_base_units: string; token?: string }

export function findMatchingTransfer(
  projection: ReceiptProjection, txTo: string | null, txValueWei: string | null,
  want: { token?: string; from?: string; to?: string; amount?: string },
): TransferMatch | null {
  if (want.token) {
    const token = want.token.toLowerCase();
    for (const l of projection.logs) {
      if (l.address !== token || l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue;
      const from = `0x${l.topics[1].slice(26)}`;
      const to = `0x${l.topics[2].slice(26)}`;
      const amount = BigInt(l.data).toString(10);
      if (want.from && from !== want.from.toLowerCase()) continue;
      if (want.to && to !== want.to.toLowerCase()) continue;
      if (want.amount && amount !== want.amount) continue;
      return { kind: "erc20", from, to, amount_base_units: amount, token };
    }
    return null;
  }
  if (projection.to === null || txValueWei === null) return null;
  const from = projection.from;
  const to = projection.to;
  const amount = BigInt(txValueWei).toString(10);
  if (amount === "0") return null;
  if (want.from && from !== want.from.toLowerCase()) return null;
  if (want.to && to !== want.to.toLowerCase()) return null;
  if (want.amount && amount !== want.amount) return null;
  return { kind: "native", from, to, amount_base_units: amount };
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = JSON.parse(await res.text()) as { result?: unknown; error?: unknown };
    if (d.error) throw new Error("rpc error");
    return d.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleCryptoTransferVerify(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const txHash = query.tx_hash?.trim();
  if (!txHash) throw badRequest("MISSING_PARAM", "tx_hash is required");
  if (!TX_HASH_RE.test(txHash)) throw badRequest("INVALID_TX_HASH", "tx_hash must be a 0x-prefixed 64-hex hash");
  const chain = normalizeChain(query.chain);
  if (!chain) throw badRequest("MISSING_PARAM", "chain is required");
  const rpcs = CHAIN_RPCS[chain];
  if (!rpcs) throw badRequest("UNSUPPORTED_CHAIN", `unsupported chain: ${chain}; expected one of ${SUPPORTED.join(", ")}`);
  const want: { token?: string; from?: string; to?: string; amount?: string } = {};
  for (const k of ["token", "from", "to"] as const) {
    const v = query[k]?.trim();
    if (v) {
      if (!ADDR_RE.test(v)) throw badRequest("INVALID_ADDRESS", `${k} must be a 0x-prefixed 20-byte address`);
      want[k] = v;
    }
  }
  const amount = query.amount?.trim();
  if (amount) {
    if (!/^\d+$/.test(amount)) throw badRequest("INVALID_AMOUNT", "amount must be an integer in base units (wei for native, smallest token unit for ERC-20)");
    want.amount = amount;
  }
  // Sequential legs, one POST at a time (txLookup A2 doctrine).
  const legs: { url: string; projection: string; receiptResult: unknown; txResult: unknown }[] = [];
  let errored = 0;
  for (const url of rpcs) {
    try {
      const receiptResult = await rpcCall(url, "eth_getTransactionReceipt", [txHash]);
      if (!receiptResult || typeof receiptResult !== "object") { legs.push({ url, projection: "null", receiptResult: null, txResult: null }); continue; }
      const txResult = await rpcCall(url, "eth_getTransactionByHash", [txHash]);
      legs.push({ url, projection: stableStringify(projectReceipt(receiptResult as Record<string, unknown>)), receiptResult, txResult });
    } catch {
      errored++;
    }
  }
  const byProjection = new Map<string, typeof legs>();
  for (const l of legs) {
    if (l.projection === "null") continue;
    byProjection.set(l.projection, [...(byProjection.get(l.projection) ?? []), l]);
  }
  const winner = [...byProjection.values()].find((g) => g.length >= 2);
  if (!winner) {
    const nullLegs = legs.filter((l) => l.projection === "null").length;
    if (nullLegs >= 2) {
      throw unprocessable("TX_NOT_FOUND", `${nullLegs} of ${rpcs.length} legs returned no receipt for this hash on ${chain}; the transfer is not verified`);
    }
    throw upstreamUnavailable("QUORUM_NOT_REACHED", `fewer than 2 agreeing legs (${legs.length} answered, ${errored} errored on ${chain}); never verified from one leg`);
  }
  const receiptResult = winner[0].receiptResult as Record<string, unknown>;
  const txResult = (winner[0].txResult ?? null) as Record<string, unknown> | null;
  const projection = projectReceipt(receiptResult);
  const txValueWei = txResult && typeof txResult.value === "string" ? txResult.value : null;
  const blockNumber = typeof receiptResult.blockNumber === "string" ? parseInt(receiptResult.blockNumber, 16) : null;
  const match = projection.status === 1
    ? findMatchingTransfer(projection, projection.to, txValueWei, want)
    : null;
  const checked = Object.keys(want);
  const verified = match !== null;
  const fetchedAt = new Date().toISOString();
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ tx_hash: txHash, chain, expectations: want, as_of: asOf,
    quorum: { chain_rpcs: rpcs.length, answered: legs.length, errored, agreeing: winner.length },
    projection: JSON.parse(stableStringify(projection)), tx_result: txResult,
    matched_transfer: match,
    source_policy: "2-of-N identical answer-relevant receipt projections over the chain's configured public RPCs, sequential legs; only receipt-carried facts verified; amounts in base units",
    fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, winner[0].url, evidence, "2-of-N public-RPC receipt quorum; receipt-carried facts only");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer = projection.status !== 1
    ? `Transfer NOT verified: the transaction's receipt shows a FAILED execution on ${chain} (block ${blockNumber}), confirmed by ${winner.length} of ${rpcs.length} RPC legs.`
    : verified
      ? `Transfer verified on ${chain} (block ${blockNumber}, ${winner.length}/${rpcs.length} legs agreeing): ${match.kind === "erc20" ? `ERC-20 transfer on ${match.token}` : "native transfer"} of ${match.amount_base_units} base units from ${match.from} to ${match.to}` +
        `${checked.length ? `; checked: ${checked.join(", ")}` : "; no expectations given, so the receipt's own transfer is reported"}. Amounts are base units.`
      : `Transfer NOT verified: the receipt on ${chain} (block ${blockNumber}, ${winner.length}/${rpcs.length} legs agreeing) executed successfully but carries no ${want.token ? `Transfer log on ${want.token}` : "native value transfer"} matching the given expectations (${checked.join(", ") || "none"}). The receipt's facts are never bent to fit.`;
  return envelope(INTENT, {
    verified,
    tx_hash: txHash,
    chain,
    block_number: blockNumber,
    status: projection.status,
    legs_agreeing: winner.length,
    legs_total: rpcs.length,
    matched_transfer: match,
  }, receipt, { answer, verdict: verified ? "verified" : "refuted", confidence: 0.9,
    source: `${winner.length}/${rpcs.length} agreeing public RPC legs on ${chain}; receipt-carried facts only; fetched ${fetchedAt}` });
}
