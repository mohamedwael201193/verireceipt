// Retrospective demonstration only. No current dispatch, allocation or trade advice.
import type { PurchaseRecord } from "./ledger.js";
import type { Fetch } from "./client.js";
import { checkDelivery, checkEpochConsistency, deliveryIsOk, merkleProofShapeOk, storedLedgerAgrees, verifyPurchase } from "./verify.js";
import type { FieldStatus } from "../../src/core/shapedFields.js";

export const DEMO_POLICY = Object.freeze({
  version: "demo-paid-policy-v1",
  label: "Illustrative thresholds chosen after purchase, not an operator instruction or official mission requirement",
  grid_max_usd_per_mwh: 100,
  tvl_min_usd: 10_000_000_000,
});

export function classifyDemo(taskId: string, value: unknown, evidenceOk: boolean): {
  outcome: "RUN" | "CURTAIL" | "PASS" | "HOLD" | "NOT_APPLICABLE";
  rule: string;
} {
  const grid = taskId === "m12-caiso-np15" || taskId === "m12-nyiso-zone-j";
  const tvl = taskId === "m13-tvl-aave-v3";
  if (!grid && !tvl) return { outcome: "NOT_APPLICABLE", rule: "No demo rule for this task; not a mission success claim" };
  if (!evidenceOk || typeof value !== "number" || !Number.isFinite(value) || (tvl && value < 0)) {
    return { outcome: "HOLD", rule: "Missing, invalid or unverified evidence" };
  }
  return grid
    ? { outcome: value <= DEMO_POLICY.grid_max_usd_per_mwh ? "RUN" : "CURTAIL", rule: "Historical grid price <= demo maximum, USD/MWh" }
    : { outcome: value >= DEMO_POLICY.tvl_min_usd ? "PASS" : "HOLD", rule: "Historical protocol TVL >= demo minimum, USD; not an allocation decision" };
}

export async function reportPurchase(r: PurchaseRecord, f: Fetch = fetch) {
  let evidenceOk = false;
  let liveValue: unknown = null;
  const failures: string[] = [];
  try {
    const v = await verifyPurchase({ payer: r.payer, minerSlug: "verireceipt", signalHash: r.signal_hash,
      valueField: r.value_field, engineResult: { ...(r.engine.result ?? {}), [r.value_field]: r.value },
      intent: r.intent, fieldStatus: r.engine.field_status as Record<string, FieldStatus> }, f);
    const ledger = storedLedgerAgrees(r, v);
    const d = await checkDelivery(r.telegraph_receipt.epoch_id, r.telegraph_receipt.receipt_hash, f);
    const epoch = await checkEpochConsistency({ claimedEpoch: r.telegraph_receipt.epoch_id,
      receiptTimeMs: r.telegraph_receipt.timestamp * 1000 }, f);
    if (!v.verified) failures.push(...v.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`));
    failures.push(...ledger.failures, ...epoch.failures);
    if (d.status !== "included" || !deliveryIsOk(d, r.telegraph_receipt, r.payer, r.intent) || d.epochId !== r.telegraph_receipt.epoch_id || !merkleProofShapeOk(d)) failures.push("Included delivery with exact identity, epoch and proof shape required");
    evidenceOk = v.verified && ledger.ok && epoch.ok && failures.length === 0;
    liveValue = v.payloadValue;
  } catch {
    failures.push("Live verification failed or unavailable");
  }
  return {
    task_id: r.task_id, mission: r.mission, purchased_at: r.bought_at,
    basis: "Historical paid answer, reverified now; not current market data",
    receipt_hash: r.telegraph_receipt.receipt_hash, signal_hash: r.signal_hash,
    receipt_id: r.miner_receipt?.receipt_id ?? null,
    paid_uusdc: r.telegraph_receipt.amount_uusdc, epoch: r.telegraph_receipt.epoch_id,
    measured_field: r.value_field, measured_value: evidenceOk ? liveValue : null,
    evidence_ok: evidenceOk, failures,
    ...classifyDemo(r.task_id, liveValue, evidenceOk),
    signal_url: `https://devnode.telegraphprotocol.com/engine/v1/signal/${r.signal_hash}`,
    delivery_url: `https://devnode.telegraphprotocol.com/v1/blocks/${r.telegraph_receipt.epoch_id}/deliveries/${r.telegraph_receipt.receipt_hash}`,
  };
}
