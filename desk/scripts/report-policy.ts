// Read-only report. Does not load a payer key, buy, sign, trade or mutate the ledger.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readLedger } from "../src/ledger.js";
import { DEMO_POLICY, reportPurchase } from "../src/policy.js";
import { uniquePurchaseIds } from "../src/verify.js";

const path = join(dirname(fileURLToPath(import.meta.url)), "..", "ledger", "purchases.jsonl");
const bytes = readFileSync(path);
const rows = readLedger(path);
if (rows.length === 0) throw new Error("No purchases to report");
const unique = uniquePurchaseIds(rows);
if (!unique.ok) throw new Error(`Duplicate purchase identity: ${unique.failures.join(", ")}`);
const results = [];
for (const row of rows) results.push(await reportPurchase(row));
console.log(JSON.stringify({
  mode: "retrospective_demo", generated_at: new Date().toISOString(),
  policy: DEMO_POLICY, ledger_sha256: createHash("sha256").update(bytes).digest("hex"),
  disclosures: [
    "Related-party direct testnet purchases. No independent demand or ranked-routing claim.",
    "Thresholds were chosen after purchase for demonstration, not precommitted trading or dispatch instructions.",
    "RUN/CURTAIL and PASS/HOLD classify historical answers only. No action is executed and no current recommendation is made.",
    "M13 is a TVL screen only, not a complete asset-management or compliance decision.",
    "Proofs are checked for identity and shape, not independently walked as a Merkle tree.",
    "The private paid response binds receipt hash to signal hash; that binding cannot be fully re-derived from public endpoints.",
  ],
  purchase_count: results.length,
  evidence_passed: results.filter(r => r.evidence_ok).length,
  applicable_count: results.filter(r => r.outcome !== "NOT_APPLICABLE").length,
  results,
}, null, 2));
if (results.some(r => !r.evidence_ok)) process.exitCode = 1;
