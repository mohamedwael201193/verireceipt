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
  // Pass r.value as the engine value for the pinned field so a forged r.value cannot hide
  // behind a stored engine.result. storedLedgerAgrees also compares r.value with v.payloadValue.
  const v = await verifyPurchase({
    payer: r.payer,
    minerSlug: "verireceipt",
    signalHash: r.signal_hash,
    valueField: r.value_field,
    engineResult: { [r.value_field]: r.value },
    intent: r.intent,
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
  if (write) {
    const stored = deliveryProofToStore(d, deliveryOk, new Date().toISOString());
    if (stored) r.delivery_proof = stored;
  }
}
if (write) writeLedger(ledgerFile, recs);
process.exitCode = failures ? 1 : 0;
