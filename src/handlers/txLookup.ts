// ONCHAIN_TX_LOOKUP_GENERAL — GET /v1/tx?tx_hash=&chain=
//
// Zero-LLM. Looks a transaction up on 2-of-3 archive RPCs (CHAIN_RPCS[chain])
// and returns exact tx_hash, status, from, to, block_number, value_eth plus a
// SHA-256 receipt over the exact receipt-call response text, so a judge can
// recompute the hash within 30 seconds. Fails closed: on RPC outage it throws
// 502 and NEVER claims not_found.
import { badRequest } from "../core/errors";
import { envelope, makeReceipt, type Receipt } from "../core/receipt";
import { quorum2of3 } from "../core/quorum";
import { CHAIN_RPCS } from "../config/chains";
import { saveReceipt } from "../core/db";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const SUPPORTED_CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon", "sepolia"];
const OP_STACK_CHAINS = new Set(["base", "optimism"]);
const RPC_TIMEOUT_MS = 4500;
const INTENT = "ONCHAIN_TX_LOOKUP_GENERAL";

interface RpcTx {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  blockNumber: string | null;
}

interface RpcReceipt {
  status: string;
  blockNumber: string;
  from: string;
  to: string;
  l1Fee?: string;
}

interface RpcOutcome {
  rpcUrl: string;
  tx: RpcTx | null;
  receipt: RpcReceipt | null;
  /** Exact JSON-RPC response text of the eth_getTransactionReceipt call. */
  receiptRaw: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asHexString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parseTx(result: unknown): RpcTx | null {
  if (result === null) return null;
  if (!isRecord(result)) throw new Error("malformed eth_getTransactionByHash result");
  const hash = asHexString(result.hash);
  const from = asHexString(result.from);
  const value = asHexString(result.value);
  if (hash === null || from === null || value === null) {
    throw new Error("malformed eth_getTransactionByHash result: missing hash/from/value");
  }
  const to = result.to === null ? null : asHexString(result.to);
  const blockNumber = result.blockNumber === null ? null : asHexString(result.blockNumber);
  return { hash, from, to, value, blockNumber };
}

function parseReceipt(result: unknown): RpcReceipt | null {
  if (result === null) return null;
  if (!isRecord(result)) throw new Error("malformed eth_getTransactionReceipt result");
  const status = asHexString(result.status);
  const blockNumber = asHexString(result.blockNumber);
  const from = asHexString(result.from);
  const to = asHexString(result.to);
  if (status === null || blockNumber === null || from === null || to === null) {
    throw new Error("malformed eth_getTransactionReceipt result: missing status/blockNumber/from/to");
  }
  const receipt: RpcReceipt = { status, blockNumber, from, to };
  // OP-stack chains report the L1 data fee on the receipt; keep it verbatim.
  if (typeof result.l1Fee === "string") receipt.l1Fee = result.l1Fee;
  return receipt;
}

async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
  signal: AbortSignal,
): Promise<{ result: unknown; rawText: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} from ${url}`);
  const rawText = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`RPC invalid JSON from ${url}`);
  }
  if (!isRecord(parsed)) throw new Error(`RPC malformed response from ${url}`);
  if (parsed.error !== undefined && parsed.error !== null) {
    throw new Error(`RPC error from ${url}: ${JSON.stringify(parsed.error)}`);
  }
  if (!("result" in parsed)) throw new Error(`RPC response without result from ${url}`);
  return { result: parsed.result, rawText };
}

async function rpcBatchCall(
  url: string,
  calls: Array<{ method: string; params: unknown[] }>,
  signal: AbortSignal,
): Promise<unknown[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params })),
    ),
    signal,
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} from ${url}`);
  const rawText = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`RPC invalid JSON from ${url}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`RPC batch response not an array from ${url}`);
  return parsed.map((entry) => {
    if (!isRecord(entry)) throw new Error(`RPC malformed batch entry from ${url}`);
    if (entry.error !== undefined && entry.error !== null) {
      throw new Error(`RPC error from ${url}: ${JSON.stringify(entry.error)}`);
    }
    if (!("result" in entry)) throw new Error(`RPC batch entry without result from ${url}`);
    return entry.result;
  });
}

async function fetchFromRpc(rpcUrl: string, txHash: string): Promise<RpcOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    // Two concurrent requests per RPC (not three): one batch carrying
    // eth_getTransactionByHash + eth_blockNumber, and one individual
    // eth_getTransactionReceipt call whose exact response text becomes the
    // receipt raw body. The public endpoints throttle concurrent connections
    // from one IP, so fewer parallel calls per RPC is measurably more
    // reliable inside the 4.5s budget (verified live 2026-11-20).
    const batchP = rpcBatchCall(
      rpcUrl,
      [
        { method: "eth_getTransactionByHash", params: [txHash] },
        { method: "eth_blockNumber", params: [] },
      ],
      controller.signal,
    );
    const rcP = rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash], controller.signal);
    const [batchResults, rcRes] = await Promise.all([batchP, rcP]);
    return {
      rpcUrl,
      tx: parseTx(batchResults[0]),
      receipt: parseReceipt(rcRes.result),
      receiptRaw: rcRes.rawText,
    };
  } finally {
    clearTimeout(timer);
  }
}

function hexToNumber(hex: string): number {
  return parseInt(hex, 16);
}

/** Quorum equality: tx hash + blockNumber, receipt status + blockNumber. */
function outcomesEqual(a: RpcOutcome, b: RpcOutcome): boolean {
  if ((a.tx === null) !== (b.tx === null)) return false;
  if ((a.receipt === null) !== (b.receipt === null)) return false;
  if (a.tx !== null && b.tx !== null) {
    if (a.tx.hash.toLowerCase() !== b.tx.hash.toLowerCase()) return false;
    if (a.tx.blockNumber !== b.tx.blockNumber) return false;
  }
  if (a.receipt !== null && b.receipt !== null) {
    if (hexToNumber(a.receipt.status) !== hexToNumber(b.receipt.status)) return false;
    if (hexToNumber(a.receipt.blockNumber) !== hexToNumber(b.receipt.blockNumber)) return false;
  }
  return true;
}

/** Convert a wei hex quantity to whole native units, exactly (BigInt math). */
export function weiToEth(weiHex: string): number {
  const wei = BigInt(weiHex);
  const ONE_ETH = 10n ** 18n;
  const whole = wei / ONE_ETH;
  const frac = wei % ONE_ETH;
  if (frac === 0n) return Number(whole);
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return Number(`${whole.toString()}.${fracStr}`);
}

export async function handleTx(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const txHash = query.tx_hash?.trim();
  const chain = query.chain?.trim().toLowerCase();
  if (!txHash || !chain) {
    throw badRequest("MISSING_PARAM", "tx_hash and chain are required query parameters");
  }
  if (!TX_HASH_RE.test(txHash)) {
    throw badRequest(
      "INVALID_TX_HASH",
      "tx_hash must be a 0x-prefixed 64-hex-character transaction hash",
    );
  }
  const rpcs = CHAIN_RPCS[chain];
  if (!rpcs || !SUPPORTED_CHAINS.includes(chain)) {
    throw badRequest(
      "UNSUPPORTED_CHAIN",
      `unsupported chain: ${chain}; expected one of ${SUPPORTED_CHAINS.join(", ")}`,
    );
  }

  // 2-of-3 quorum over the chain's archive RPCs. quorum2of3 throws 502 when
  // fewer than 2 RPCs are healthy or none agree — never a not_found claim.
  const { value, votes } = await quorum2of3(
    rpcs.map((rpcUrl) => () => fetchFromRpc(rpcUrl, txHash)),
    outcomesEqual,
    RPC_TIMEOUT_MS,
  );

  const tx = value.tx;
  const receipt = value.receipt;

  let status: "confirmed" | "reverted" | "pending" | "not_found";
  let verdict: string;
  let confidence: number;
  let answer: string;
  if (receipt !== null) {
    const blockNumber = hexToNumber(receipt.blockNumber);
    if (hexToNumber(receipt.status) === 1) {
      status = "confirmed";
      verdict = "verified";
      confidence = 1.0;
      answer = `Transaction ${txHash} on ${chain} is confirmed in block ${blockNumber}.`;
    } else {
      status = "reverted";
      verdict = "reverted";
      confidence = 1.0;
      answer = `Transaction ${txHash} on ${chain} was reverted in block ${blockNumber}.`;
    }
  } else if (tx !== null) {
    status = "pending";
    verdict = "pending";
    confidence = 0.9;
    answer = `Transaction ${txHash} on ${chain} is pending and has not yet been included in a block.`;
  } else {
    status = "not_found";
    verdict = "not_found";
    confidence = 1.0;
    answer = `Transaction ${txHash} was not found on ${chain}.`;
  }

  const blockNumber =
    receipt !== null
      ? hexToNumber(receipt.blockNumber)
      : tx !== null && tx.blockNumber !== null
        ? hexToNumber(tx.blockNumber)
        : null;
  const valueEth = tx !== null ? weiToEth(tx.value) : null;
  const from = tx?.from ?? receipt?.from ?? null;
  const to = tx?.to ?? receipt?.to ?? null;

  const fields: Record<string, unknown> = {
    tx_hash: txHash,
    status,
    from,
    to,
    block_number: blockNumber,
    value_eth: valueEth,
  };
  // OP-stack L1 data fee: include it (converted to whole native units) when
  // the receipt carries it. The raw receipt body hashed below already
  // contains the original l1Fee hex.
  if (receipt !== null && OP_STACK_CHAINS.has(chain) && receipt.l1Fee !== undefined) {
    fields.l1_fee_eth = weiToEth(receipt.l1Fee);
  }

  const receiptDoc: Receipt = makeReceipt(INTENT, value.rpcUrl, value.receiptRaw, votes);
  try {
    saveReceipt(receiptDoc);
  } catch {
    // Persistence must never fail the answer; the coordinator wires it.
  }

  return envelope(INTENT, fields, receiptDoc, {
    answer,
    verdict,
    confidence,
    source: `Archive RPC quorum (${chain}, 2-of-3)`,
  });
}
