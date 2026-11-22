// One direct, escrow-paid research request. No registration or backend writes.
import { randomUUID } from "node:crypto";
import { escrowAskMiner, type Fetch, type Payer, type RawResponse } from "./client.js";
import { DESK_DAILY_CAP_UUSDC, VERIRECEIPT_MINER_ID, VERIRECEIPT_ONCHAIN_MINER_IDS } from "./constants.js";
import { checkDelivery, checkEpochConsistency, deliveryIsOk, merkleProofShapeOk, verifyPurchase } from "./verify.js";
import type { FieldStatus } from "../../src/core/shapedFields.js";
import { evaluateResearch, RESEARCH_INTENT, validateResearchPlan, type ResearchPlan } from "./research.js";

export async function runResearch(p: ResearchPlan, hash: string, payer: Payer, opts: {
  spentTodayUusdc: bigint;
  /** Persist a conservative spend reservation BEFORE signing. Must throw if persistence fails. */
  beforeSign: (reservation: { plan_hash: string; at: string; reserved_uusdc: string; nonce: string }) => void | Promise<void>;
  /** Hosted service may supply a separately approved cap; local CLI default is unchanged. */
  dailyCapUusdc?: bigint;
  onRawResponse: (raw: RawResponse) => void | Promise<void>;
  f?: Fetch;
  now?: () => Date;
}) {
  const now = opts.now ?? (() => new Date());
  validateResearchPlan(p, hash, now());
  const nonce = `vr-research-${hash}-${randomUUID()}`;
  const f: Fetch = opts.f ?? ((input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(45000) }));
  const paid = await escrowAskMiner(VERIRECEIPT_MINER_ID, { intent: RESEARCH_INTENT, params: p.params }, {
    address: payer.address,
    signMessage: async message => {
      // Recheck the frozen object immediately before signing, not just at entry.
      validateResearchPlan(p, hash, now());
      await opts.beforeSign({ plan_hash: hash, at: now().toISOString(), reserved_uusdc: p.maximum_call_uusdc, nonce });
      return payer.signMessage(message);
    },
  }, { spentTodayUusdc: opts.spentTodayUusdc, dailyCapUusdc: opts.dailyCapUusdc ?? DESK_DAILY_CAP_UUSDC,
    minerIds: VERIRECEIPT_ONCHAIN_MINER_IDS, f, now: () => now().getTime(), nonce: () => nonce, onRawResponse: opts.onRawResponse });
  const body = paid.body as { result?: Record<string, unknown>; signal_hash?: string; field_status?: Record<string, FieldStatus> };
  const verified = await verifyPurchase({ payer: payer.address, minerSlug: "verireceipt", signalHash: String(body.signal_hash ?? ""),
    valueField: "filing_count", engineResult: body.result ?? {}, intent: RESEARCH_INTENT, fieldStatus: body.field_status }, f);
  const result = await evaluateResearch(p, verified, f, now());
  const receiptTime = paid.receipt.timestamp * 1000;
  const timingOk = Number.isFinite(receiptTime) && receiptTime >= Math.floor(Date.parse(p.created_at) / 1000) * 1000 && receiptTime <= now().getTime() + 5000 && now().getTime() - receiptTime <= p.max_age_seconds * 1000;
  const delivery = await checkDelivery(paid.receipt.epoch_id, paid.receipt.receipt_hash, f);
  const epoch = await checkEpochConsistency({ claimedEpoch: paid.receipt.epoch_id, receiptTimeMs: receiptTime }, f);
  const receiptOk = paid.receipt.intent === RESEARCH_INTENT && timingOk;
  const deliveryOk = deliveryIsOk(delivery, paid.receipt, payer.address, RESEARCH_INTENT) &&
    (delivery.status !== "included" || delivery.epochId === paid.receipt.epoch_id && merkleProofShapeOk(delivery));
  result.checks.push({ name: "receipt intent and timestamp match frozen research", ok: receiptOk },
    { name: "delivery identity/proof shape or official pending state", ok: deliveryOk }, { name: "epoch is consistent with receipt time", ok: epoch.ok });
  if (!receiptOk || !deliveryOk || !epoch.ok) {
    result.status = "HOLD"; result.reason = "Receipt, delivery or epoch verification incomplete or inconsistent"; result.observed_count = null; result.rows = [];
  }
  return { version: "research-run-v1", plan: p, plan_hash: hash, completed_at: now().toISOString(),
    result, testnet_amount_uusdc: paid.receipt.amount_uusdc, nonce, receipt: paid.receipt,
    signal_hash: body.signal_hash, verification_checks: verified.checks, delivery, epoch,
    accounting_limit: "Official pending is not inclusion or finalized settlement. Proof shape is checked, not a local Merkle walk.",
    source_limit: "Own team's direct purchase. No independent-use or ranked-routing claim." };
}
