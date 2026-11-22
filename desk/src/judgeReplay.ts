// Read-only historical research replay. No payer, wallet, signer or payment import.
import { evaluateResearch, RESEARCH_INTENT, validateResearchPlan, type ResearchPlan } from "./research.js";
import { checkDelivery, checkEpochConsistency, deliveryIsOk, merkleProofShapeOk, verifyPurchase, type Check } from "./verify.js";
import { MINER_BASE_URL, NODE_URL } from "./constants.js";
import type { Fetch } from "./client.js";

export interface PublishedResearch {
  plan: ResearchPlan;
  plan_hash: string;
  completed_at: string;
  signal_hash: string;
  result: { status: string; observed_count: number | null };
  receipt: { receipt_hash: string; rail: string; miner: string; intent: string; amount_uusdc: string; epoch_id: number; settlement: string; chain: string; timestamp: number };
}
export interface ReplayResult {
  ok: boolean;
  checked_at: string;
  historical_at: string;
  status: "SUPPORTED" | "NOT_SUPPORTED" | "HOLD";
  count: number | null;
  delivery: string;
  checks: Check[];
  limits: string[];
}
const LIMITS = [
  "Historical replay against the original completion time, not a fresh answer or current freshness assertion.",
  "Stored-byte integrity and independent SEC extraction, not audited source truth or filing contents.",
  "Direct related-party Sepolia testnet purchase, not ranked routing, independent adoption or customer revenue.",
  "Delivery identity and proof shape checked, not a local Merkle walk or finalized settlement.",
  "No wallet, private key, purchase, authorization signature or file write is used by this command.",
];

/** Restrict even an injected verifier to read-only public evidence origins. */
export function evidenceGet(f: Fetch = fetch): Fetch {
  const deadline = Date.now() + 90_000;
  const cache = new Map<string, Response>();
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "GET" || init?.body != null || url.username || url.password ||
        ![new URL(NODE_URL).origin, new URL(MINER_BASE_URL).origin].includes(url.origin) ||
        !(url.pathname.startsWith("/engine/v1/signal/") || url.pathname.startsWith("/receipts/") || url.pathname.startsWith("/v1/blocks/"))) {
      throw new Error("Judge replay permits only public evidence GET requests.");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Public replay time budget exceeded.");
    const cached = cache.get(url.href);
    if (cached) return cached.clone();
    const response = await f(url.href, { method: "GET", redirect: "error", signal: AbortSignal.timeout(Math.min(20_000, remaining)) });
    // Cache each successful evidence read within this replay, avoiding duplicate raw fetches.
    if (response.ok) cache.set(url.href, response.clone());
    return response;
  };
}

export async function replayResearch(record: PublishedResearch, payer: string, fetcher: Fetch = fetch): Promise<ReplayResult> {
  const checks: Check[] = [];
  const out: ReplayResult = { ok: false, checked_at: new Date().toISOString(), historical_at: record.completed_at,
    status: "HOLD", count: null, delivery: "unverified", checks, limits: [...LIMITS] };
  const add = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); return ok; };
  try {
    const historical = new Date(record.completed_at);
    validateResearchPlan(record.plan, record.plan_hash, historical);
    const identityOk = /^0x[0-9a-fA-F]{40}$/.test(payer) && /^0x[0-9a-f]{64}$/.test(record.signal_hash) &&
      /^0x[0-9a-f]{64}$/.test(record.receipt.receipt_hash) && record.receipt.intent === RESEARCH_INTENT &&
      record.receipt.rail === "escrow" && record.receipt.settlement === "epoch" &&
      record.receipt.amount_uusdc === record.plan.maximum_call_uusdc &&
      Number.isSafeInteger(record.result.observed_count) && Number(record.result.observed_count) >= 0;
    if (!add("published plan and receipt shape", identityOk, "Canonical historical policy and bounded testnet record")) return out;
    const f = evidenceGet(fetcher);
    const verified = await verifyPurchase({ payer, minerSlug: "verireceipt", signalHash: record.signal_hash,
      valueField: "filing_count", engineResult: { filing_count: record.result.observed_count }, intent: RESEARCH_INTENT }, f);
    checks.push(...verified.checks);
    const research = await evaluateResearch(record.plan, verified, f, historical);
    checks.push(...research.checks.map(c => ({ ...c, detail: "Independent extraction at original run time" })));
    add("published outcome agrees with independently recounted source", research.status === record.result.status && research.observed_count === record.result.observed_count,
      "Saved status is compared, never trusted as a verification result");
    const timingOk = Number.isFinite(record.receipt.timestamp) && record.receipt.timestamp * 1000 >= Math.floor(Date.parse(record.plan.created_at) / 1000) * 1000 &&
      record.receipt.timestamp * 1000 <= historical.getTime() + 5000 && historical.getTime() - record.receipt.timestamp * 1000 <= record.plan.max_age_seconds * 1000;
    add("receipt time belongs to original policy window", timingOk, "Historical timing, not current freshness");
    const delivery = await checkDelivery(record.receipt.epoch_id, record.receipt.receipt_hash, f);
    out.delivery = delivery.status;
    add("current included delivery matches receipt identity and proof shape", delivery.status === "included" &&
      delivery.epochId === record.receipt.epoch_id && deliveryIsOk(delivery, record.receipt, payer, RESEARCH_INTENT) && merkleProofShapeOk(delivery),
      "Must be included for this historical example; no Merkle walk claimed");
    const epoch = await checkEpochConsistency({ claimedEpoch: record.receipt.epoch_id, receiptTimeMs: record.receipt.timestamp * 1000 }, f);
    add("receipt time belongs to recorded epoch", epoch.ok, epoch.failures.join("; ") || "Epoch window agrees");
    out.ok = checks.every(c => c.ok) && research.status !== "HOLD";
    if (out.ok) { out.status = research.status; out.count = research.observed_count; }
  } catch {
    add("replay completed", false, "Evidence unavailable or inconsistent. No purchase or retry was made.");
  }
  return out;
}
