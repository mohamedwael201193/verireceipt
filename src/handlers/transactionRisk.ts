// TRANSACTION_RISK_GENERAL — GET /v1/transaction-risk?transaction=<0x…>
//
// Zero-LLM. A deterministic, fully-disclosed risk read of an ethereum
// mainnet transaction from sources already verified in-repo: the
// 2-of-N RPC quorum (txLookup doctrine) for the tx + receipt, and the
// OFAC SDN list's Digital Currency Address entries for counterparty
// screening. SHA-256 receipt over the exact upstream bodies.
//
// Intent contract (read 2026-11-23): request transaction (string);
// scored risk_level (enum LOW/MEDIUM/HIGH/CRITICAL); off-chain
// risk_score (0..1), signals, summary.
//
// HONESTY DOCTRINE (maintainer ruling 2026-11-23): every signal is
// named with its evidence, and nothing heuristic is presented as
// ground truth. The ONLY ground-truth signal here is an exact address
// match against the OFAC SDN list. Everything else (reverted status,
// zero-value calls, large transfers, contract creation) is a
// heuristic flag whose rubric weight is published in the receipt; a
// LOW grade is "no listed signal fired", never "this tx is safe".
//
// NARROWING (disclosed in every answer and receipt): ethereum mainnet
// only in this slice; a hash that does not resolve there is
// TX_NOT_FOUND, not a cross-chain guess.
//
// RUBRIC (published verbatim in the receipt):
//   sanctioned counterparty (exact OFAC SDN address match) -> 1.0 CRITICAL
//   reverted (receipt status 0)                            -> +0.3
//   contract creation (to == null)                         -> +0.1
//   zero value with no logs                                -> +0.1
//   value >= 100 ETH                                       -> +0.1
//   levels: >=0.75 CRITICAL, >=0.5 HIGH, >=0.25 MEDIUM, else LOW
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { CHAIN_RPCS } from "../config/chains";

const RPC_TIMEOUT_MS = 12000;
const SDN_TIMEOUT_MS = 15000;
const UA = "VeriReceipt/2.0 transaction-risk observer (+https://verireceipt.vercel.app)";
const SDN_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
const LARGE_VALUE_WEI = 100n * 10n ** 18n;

export const INTENT = "TRANSACTION_RISK_GENERAL";

export const RUBRIC =
  "sanctioned counterparty (exact OFAC SDN Digital Currency Address match) = 1.0 CRITICAL; " +
  "reverted (status 0) +0.3; contract creation +0.1; zero value with no logs +0.1; value >= 100 ETH +0.1; " +
  "levels: >=0.75 CRITICAL, >=0.5 HIGH, >=0.25 MEDIUM, else LOW; heuristic-only combinations (no ground-truth signal) are capped at 0.4, never reaching HIGH";

async function rpcCall(url: string, method: string, params: unknown[]): Promise<{ body: string; result: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const parsed = JSON.parse(body) as { result?: unknown };
    return { body, result: parsed.result ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/** 2-of-N quorum returning the agreed parsed result plus every leg's raw body (copied txLookup doctrine). */
async function quorumRpc(rpcs: string[], method: string, params: unknown[]):
  Promise<{ result: Record<string, unknown>; bodies: Record<string, string>; legs: number }> {
  const settled = await Promise.allSettled(rpcs.map((url) => rpcCall(url, method, params)));
  const ok = settled.filter((s): s is PromiseFulfilledResult<{ body: string; result: unknown }> => s.status === "fulfilled").map((s) => s.value);
  if (ok.length < 2) {
    throw upstreamUnavailable("RPC_QUORUM_UNREACHABLE", `fewer than two ethereum RPC legs answered ${method} (${ok.length}/${rpcs.length})`);
  }
  // Agree on the normalized JSON of the result; null results agree too.
  const groups = new Map<string, { result: unknown; bodies: Record<string, string>; n: number }>();
  ok.forEach((r, i) => {
    const key = JSON.stringify(r.result);
    const g = groups.get(key) ?? { result: r.result, bodies: {}, n: 0 };
    g.bodies[`leg${i}`] = r.body;
    g.n += 1;
    groups.set(key, g);
  });
  const best = [...groups.values()].sort((a, b) => b.n - a.n)[0];
  if (best.n < 2) {
    throw upstreamUnavailable("RPC_QUORUM_DISAGREEMENT", `the ethereum RPC legs returned different ${method} results; no value is guessed`);
  }
  if (best.result === null) {
    throw unprocessable("TX_NOT_FOUND", "no ethereum mainnet transaction with that hash (2-of-N quorum agreement); this slice covers ethereum mainnet only");
  }
  return { result: best.result as Record<string, unknown>, bodies: best.bodies, legs: ok.length };
}

/** Exact 0x addresses listed as OFAC SDN Digital Currency Address features. */
export function extractSdnCryptoAddresses(raw: string): string[] {
  const out = new Set<string>();
  for (const m of raw.matchAll(/Digital Currency Address - [A-Z0-9]+ (0x[a-fA-F0-9]{40})/g)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

async function fetchSdnAddresses(): Promise<{ addresses: string[]; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SDN_TIMEOUT_MS);
  try {
    const res = await fetch(SDN_URL, { signal: controller.signal, headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    return { addresses: extractSdnCryptoAddresses(body), body };
  } finally {
    clearTimeout(timer);
  }
}

export function riskLevel(score: number): string {
  return score >= 0.75 ? "CRITICAL" : score >= 0.5 ? "HIGH" : score >= 0.25 ? "MEDIUM" : "LOW";
}

export async function handleTransactionRisk(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const txHash = query.transaction?.trim().toLowerCase();
  if (!txHash) throw badRequest("MISSING_PARAM", "transaction is required as an ethereum mainnet tx hash (0x + 64 hex)");
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw badRequest("INVALID_TX_HASH", "transaction must be a tx hash: 0x followed by 64 lowercase hex characters; this slice covers ethereum mainnet only");
  const fetchedAt = new Date().toISOString();
  const rpcs = CHAIN_RPCS.ethereum;
  let sdn: { addresses: string[]; body: string };
  try {
    sdn = await fetchSdnAddresses();
  } catch {
    // A risk grade without the sanctions leg is incomplete; fail closed.
    throw upstreamUnavailable("SANCTIONS_UNAVAILABLE", "the OFAC SDN list could not be fetched; a risk grade without sanctions screening is never served");
  }
  const tx = await quorumRpc(rpcs, "eth_getTransactionByHash", [txHash]);
  const receipt = await quorumRpc(rpcs, "eth_getTransactionReceipt", [txHash]);
  const from = String(tx.result.from ?? "").toLowerCase();
  const to = tx.result.to === null || tx.result.to === undefined ? null : String(tx.result.to).toLowerCase();
  const valueWei = BigInt(String(tx.result.value ?? "0x0"));
  // txLookup's effectiveStatus doctrine: a pre-Byzantium receipt carries
  // `root` instead of `status` and means success; neither field means
  // failure. Never default a missing status to success.
  const statusRaw = receipt.result.status;
  const root = receipt.result.root;
  const reverted = typeof statusRaw === "string" ? statusRaw === "0x0" : typeof root !== "string";
  const logs = Array.isArray(receipt.result.logs) ? receipt.result.logs : [];
  const listed = new Set(sdn.addresses);
  const sanctionedFrom = listed.has(from);
  const sanctionedTo = to !== null && listed.has(to);
  const signals: { signal: string; evidence: string; weight: number; ground_truth: boolean }[] = [];
  let score = 0;
  if (sanctionedFrom || sanctionedTo) {
    signals.push({ signal: "SANCTIONED_COUNTERPARTY",
      evidence: `${sanctionedFrom ? `sender ${from}` : `recipient ${to}`} appears verbatim in the OFAC SDN list's Digital Currency Address entries (${sdn.addresses.length} addresses, list SHA-256 in receipt)`,
      weight: 1, ground_truth: true });
    score = 1;
  } else {
    if (reverted) { signals.push({ signal: "TX_REVERTED", evidence: "receipt status 0x0 (execution reverted)", weight: 0.3, ground_truth: false }); score += 0.3; }
    if (to === null) { signals.push({ signal: "CONTRACT_CREATION", evidence: "tx.to is null: this transaction deploys a contract", weight: 0.1, ground_truth: false }); score += 0.1; }
    if (valueWei === 0n && logs.length === 0) { signals.push({ signal: "ZERO_VALUE_NO_LOGS", evidence: "0 wei transferred and no logs emitted", weight: 0.1, ground_truth: false }); score += 0.1; }
    if (valueWei >= LARGE_VALUE_WEI) { signals.push({ signal: "LARGE_VALUE", evidence: `value ${valueWei} wei >= 100 ETH`, weight: 0.1, ground_truth: false }); score += 0.1; }
    score = Math.min(score, 0.4); // heuristic-only reads never reach HIGH
  }
  score = Math.round(score * 1e6) / 1e6;
  const level = riskLevel(score);
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ transaction: txHash, chain: "ethereum", as_of: asOf,
    narrowing: "ethereum mainnet only in this slice",
    rubric: RUBRIC,
    heuristic_notice: "only the OFAC SDN exact address match is ground truth; every other signal is a heuristic flag with a published weight, and a LOW grade means no listed signal fired, never that the transaction is safe",
    from, to, value_wei: valueWei.toString(), reverted, log_count: logs.length,
    sdn_crypto_addresses: sdn.addresses.length, sanctioned_from: sanctionedFrom, sanctioned_to: sanctionedTo,
    raw_bodies: { tx: tx.bodies, receipt: receipt.bodies, sdn: sdn.body }, fetched_at: fetchedAt });
  const receipt_ = makeReceipt(INTENT, `ethereum RPC quorum + ${SDN_URL}`, evidence, "2-of-N RPC quorum (txLookup doctrine) + OFAC SDN exact address screening; rubric published in evidence");
  receipt_.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt_, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const signalText = signals.length
    ? signals.map((s) => `${s.signal} (${s.evidence})`).join("; ")
    : "no rubric signal fired";
  const summary = `Tx ${txHash.slice(0, 10)}… on ethereum: risk ${level} (score ${score}). Signals: ${signalText}. ` +
    `Only an exact OFAC SDN address match is ground truth; the rest are disclosed heuristics, and ${level === "LOW" ? "LOW means no listed signal fired, not that the transaction is safe" : "the rubric is published in the receipt"}.`;
  return envelope(INTENT, {
    risk_level: level,
    risk_score: score,
    signals: signals.map((s) => `${s.signal}: ${s.evidence}`),
    summary,
  }, receipt_, { answer: summary, verdict: "verified", confidence: 0.9,
    source: `ethereum RPC quorum (${rpcs.join(", ")}) + OFAC SDN ${SDN_URL}; ethereum mainnet only; fetched ${fetchedAt}` });
}
