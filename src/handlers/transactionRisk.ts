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
// Hash lookup is ethereum mainnet; free-text mode is an unverified
// local scenario assessment and performs no chain or sanctions lookup.
//
// NARROWING (disclosed in every hash answer and receipt): ethereum mainnet
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
import { receiptQuorum } from "../core/receiptQuorum";
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

async function rpcCall(url: string, method: string, params: unknown[], timeoutMs=RPC_TIMEOUT_MS): Promise<{ body: string; result: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const parsed = JSON.parse(body);
    if(parsed.error || !Object.prototype.hasOwnProperty.call(parsed,"result"))throw new Error("invalid RPC response");
    return { body, result: parsed.result };
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


/** A rubric assessment of supplied assertions, not an observed transaction or sanctions check. */
export async function scenarioRisk(description: string): Promise<Record<string, unknown>> {
  const signals: {signal: string; weight: number; evidence: string}[] = [];
  // Only complete declarative clauses are recognized. Negated, conditional and
  // prospective clauses are not positive signals; unsupported prose stays unassessed.
  const clauses = description.split(/(?:[;!\n]+|\.(?=\s|$))/).map(x => x.trim()).filter(Boolean);
  const asserted = clauses.filter(x => !/\b(?:not|no|never|without|if|unless|would|could|may|might|will|should|maybe|possibly|whether)\b|\?/i.test(x));
  const add = (signal: string, weight: number, match: string | undefined) => {if (match) signals.push({signal, weight, evidence: 'User-supplied assertion only: ' + match});};
  add('TX_REVERTED', .3, asserted.find(x => /^(?:the )?(?:tx|transaction|execution) (?:has |was )?(?:reverted|failed)$/i.test(x) || /^receipt status (?:is |was )?0x0$/i.test(x)));
  add('CONTRACT_CREATION', .1, asserted.find(x => /^(?:the )?(?:tx|transaction) (?:deploys|creates) (?:a |an |the )?(?:new )?(?:smart )?contract$/i.test(x) || /^contract (?:creation|deployment)$/i.test(x)));
  add('ZERO_VALUE_NO_LOGS', .1, asserted.find(x => /^(?:the )?(?:tx|transaction) (?:transfers|transferred) 0 (?:ETH|wei) (?:with|and) (?:zero|0) logs$/i.test(x)));
  const large = asserted.find(x => {
    const m = /^(?:(?:the )?(?:tx|transaction) (?:transfers|transferred) |value (?:is |was )?)([0-9]{1,12}(?:\.[0-9]{1,18})?) ETH$/i.exec(x);
    return !!m && Number(m[1]) >= 100;
  });
  add('LARGE_VALUE', .1, large);
  const score = Math.round(Math.min(.4, signals.reduce((n,s) => n+s.weight,0)) * 1e6) / 1e6;
  const level = riskLevel(score);
  const now = new Date().toISOString();
  const notice = 'Scenario rubric only, based on supplied assertions; no RPC lookup, sanctions screening or independent verification. Unsupported details are not assessed. LOW means no recognized rubric signal, never safe.';
  const summary = `Scenario risk ${level} (rubric score ${score}): ${signals.length ? signals.map(s => s.signal).join(', ') : 'no recognized rubric signal'}. ${notice}`;
  const evidence = JSON.stringify({mode:'scenario', description, rubric:RUBRIC, notice, signals, risk_score:score, assessed_at:now});
  const receipt = makeReceipt(INTENT, 'local:transaction-risk-disclosed-rubric', evidence, 'No external source; user-supplied scenario assertions only');
  receipt.fetched_at = now;
  try {await saveReceipt(receipt,evidence);}
  catch {throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
  return envelope(INTENT,{risk_level:level,risk_score:score,signals:signals.map(s=>s.signal+': '+s.evidence),summary,assessment_mode:'scenario',sanctions_screened:false},receipt,
    {answer:summary,verdict:'unverified',confidence:0,source:'Supplied description + disclosed local rubric; no external evidence'});
}

export async function handleTransactionRisk(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const input = query.transaction?.trim();
  if (!input) throw badRequest("MISSING_PARAM", "transaction is required as a hash or description");
  if (input.length > 2000 || /[\x00-\x1f]/.test(input)) throw badRequest("INVALID_TRANSACTION", "transaction must be at most 2000 printable characters");
  const normalized = input.toLowerCase();
  const txHash = /^(?:0x)?[0-9a-f]{64}$/.test(normalized) ? '0x' + normalized.replace(/^0x/, '') : null;
  if (!txHash) {
    // Never reinterpret malformed hash-shaped input as a narrative assessment.
    if (/^(?:0x)?[a-f0-9]+$/i.test(input) || /^0x\S+$/i.test(input)) throw badRequest("INVALID_TX_HASH", "hash lookup requires exactly 64 hex characters, with an optional 0x prefix");
    return scenarioRisk(input);
  }
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
  const receipt = await receiptQuorum(rpcs,txHash,url=>rpcCall(url,"eth_getTransactionReceipt",[txHash],4000),{legacyRootBeforeBlock:4370000n});
  if(!receipt.result)throw unprocessable("TX_NOT_FOUND","receipt not found by two-source agreement");
  const from = String(tx.result.from ?? "").toLowerCase();
  const to = tx.result.to === null || tx.result.to === undefined ? null : String(tx.result.to).toLowerCase();
  const valueWei = BigInt(String(tx.result.value ?? "0x0"));
  // txLookup's effectiveStatus doctrine: a pre-Byzantium receipt carries
  // `root` instead of `status` and means success; neither field means
  // failure. Never default a missing status to success.
  const statusRaw = receipt.result.status;
  const root = receipt.result.root;
  const reverted = typeof statusRaw === "string" ? BigInt(statusRaw) === 0n : typeof root !== "string";
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
    rubric: RUBRIC,receipt_quorum_policy:receipt.policy,
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
