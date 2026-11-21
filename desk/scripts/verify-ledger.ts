// Re-verifies every ledger purchase from public data only (no key needed)
// and records the epoch inclusion proof once the node has recorded the
// epoch's block: GET /v1/blocks/{epoch}/deliveries/{receipt_hash}.
//
//   npm run verify            # read-only report
//   npm run verify -- --write # also store delivery_proof in the ledger
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLedger, writeLedger } from "../src/ledger.js";
import {
  checkDelivery, checkEpochConsistency, deliveryIsOk, deliveryProofToStore,
  storedDeliveryAgrees, storedLedgerAgrees, uniquePurchaseIds, verifyPurchase,
} from "../src/verify.js";
import type { FieldStatus } from "../../src/core/shapedFields.js";

const here = dirname(fileURLToPath(import.meta.url));
const ledgerFile = join(here, "..", "ledger", "purchases.jsonl");
const write = process.argv.includes("--write");
const recs = readLedger(ledgerFile);
let failures = 0;
const uniq = uniquePurchaseIds(recs);
if (!uniq.ok) {
  failures++;
  for (const f of uniq.failures) console.log(`FAIL ledger ${f}`);
}
for (const r of recs) {
  // Pin r.value onto value_field so a forged r.value cannot hide behind a stored
  // engine.result (J1 Fields H1). Other engine.result fields are used to reconcile
  // shaped / recovered fields. storedLedgerAgrees also compares r.value with v.payloadValue.
  // engine.result itself was backfilled from the captured paid replies (not fully public).
  const v = await verifyPurchase({
    payer: r.payer,
    minerSlug: "verireceipt",
    signalHash: r.signal_hash,
    valueField: r.value_field,
    engineResult: { ...(r.engine.result ?? {}), [r.value_field]: r.value },
    intent: r.intent,
    fieldStatus: r.engine.field_status as Record<string, FieldStatus>,
  });
  const d = await checkDelivery(r.telegraph_receipt.epoch_id, r.telegraph_receipt.receipt_hash);
  const deliveryOk = deliveryIsOk(d, r.telegraph_receipt, r.payer, r.intent);
  const receiptTimeMs = typeof r.telegraph_receipt.timestamp === "number" ? r.telegraph_receipt.timestamp * 1000 : Date.parse(r.bought_at);
  const epoch = await checkEpochConsistency({ claimedEpoch: r.telegraph_receipt.epoch_id, receiptTimeMs });
  const agree = storedLedgerAgrees(r, v);
  const delAgree = storedDeliveryAgrees(r.delivery_proof, d, r);
  if (!v.verified || !deliveryOk || !agree.ok || !epoch.ok || !delAgree.ok) failures++;
  console.log(
    `${r.task_id} ${r.telegraph_receipt.receipt_hash} re-verify=${v.verified ? "PASS" : "FAIL"} delivery=${d.status}${d.status === "included" ? (deliveryOk ? " (payer+usdc match)" : " (MISMATCH)") : d.status === "error" ? " (not OK)" : ""}${agree.ok ? "" : " ledger=FAIL"}${epoch.ok ? "" : " epoch=FAIL"}${delAgree.ok ? "" : delAgree.stale ? " delivery=STALE" : " delivery=FAIL"}`,
  );
  for (const c of v.checks.filter((c) => !c.ok)) console.log(`  FAIL ${c.name}: ${c.detail}`);
  for (const f of agree.failures) console.log(`  FAIL ledger ${f}`);
  for (const f of epoch.failures) console.log(`  FAIL epoch ${f}`);
  for (const f of delAgree.failures) console.log(`  FAIL delivery ${f}`);
  if (v.fields) {
    const recovered = Object.entries(v.fields).filter(([, f]) => f.source === "raw");
    if (recovered.length) {
      console.log(`  recovered from hash-verified raw: ${recovered.map(([k, f]) => `${k}=${JSON.stringify(f.value)}`).join(", ")}`);
    }
  }
  if (write) {
    const stored = deliveryProofToStore(d, deliveryOk, new Date().toISOString());
    if (stored) r.delivery_proof = stored;
    if (v.fields) r.recovered_fields = v.fields;
  }
}
if (write) writeLedger(ledgerFile, recs);
process.exitCode = failures ? 1 : 0;
