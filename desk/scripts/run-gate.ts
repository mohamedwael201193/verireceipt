// Runs one pre-execution gate task end to end: fresh auto-routed paid
// purchase on Ethereum Sepolia (testnet), layered verification, PASS/HOLD
// against the precommitted rule, record appended to desk/ledger/gate-runs.jsonl.
//
//   DESK_SECRETS_FILE=/path/to/env.txt npm run gate -- gate-tvl-floor-aave-v3 [--set key=value ...]
//
// The payer key is read in-process from DESK_SECRETS_FILE (key
// "private_key") and never printed. DESK_PAYER_ADDRESS pins the expected
// payer; the run refuses to sign with any other key. Daily-cap accounting is
// shared and durable: one reservations journal + lock across the purchases,
// gate and benchmark ledgers (spendLedgerFromFiles).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { runGate, spendLedgerFromFiles } from "../src/gate.js";
import { loadGatePolicy, assertCommittedPolicy } from "../src/gatePolicy.js";
import { normalizePrivateKey, readSecret } from "../src/secrets.js";

const here = dirname(fileURLToPath(import.meta.url));
const ledgerDir = process.env.DESK_LEDGER_DIR ?? join(here, "..", "ledger");
const policyFile = process.env.DESK_GATE_POLICY ?? join(here, "..", "policy", "gate-policy.v1.json");
const ledgerFile = process.env.DESK_GATE_LEDGER ?? join(ledgerDir, "gate-runs.jsonl");
const secrets = process.env.DESK_SECRETS_FILE;
const expected = (process.env.DESK_PAYER_ADDRESS ?? "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3").toLowerCase();
const evidenceDir = process.env.DESK_EVIDENCE_DIR;
if (!secrets) throw new Error("set DESK_SECRETS_FILE");

const taskId = process.argv[2];
if (!taskId || taskId.startsWith("-")) throw new Error("usage: npm run gate -- <gate-task-id> [--set key=value ...]");
const overrides: Record<string, string> = {};
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] !== "--set") throw new Error(`unknown argument ${process.argv[i]} (only --set key=value)`);
  const kv = process.argv[++i];
  const eq = kv?.indexOf("=") ?? -1;
  if (!kv || eq <= 0) throw new Error("--set takes key=value");
  overrides[kv.slice(0, eq)] = kv.slice(eq + 1);
}

const { policy, hash } = loadGatePolicy(policyFile);
assertCommittedPolicy(hash);
const account = privateKeyToAccount(normalizePrivateKey(readSecret(secrets, "private_key")));
if (account.address.toLowerCase() !== expected) throw new Error("payer key does not match DESK_PAYER_ADDRESS; refusing to sign");
mkdirSync(ledgerDir, { recursive: true });
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

const spend = spendLedgerFromFiles({
  reservationsFile: join(ledgerDir, "reservations.jsonl"),
  lockFile: join(ledgerDir, "spend.lock"),
  purchasesFile: join(ledgerDir, "purchases.jsonl"),
  runLedgerFiles: [join(ledgerDir, "gate-runs.jsonl"), join(ledgerDir, "benchmark-runs.jsonl")],
});

const rec = await runGate(taskId, { address: account.address, signMessage: (m) => account.signMessage({ message: m }) }, {
  policy,
  policyHash: hash,
  ledgerFile,
  overrides: Object.keys(overrides).length ? overrides : undefined,
  spend,
  onRawResponse: evidenceDir
    ? (raw) => { writeFileSync(join(evidenceDir, `${taskId}-${Date.now()}.json`), JSON.stringify(raw, null, 2)); }
    : undefined,
});
console.log(JSON.stringify(rec, null, 2));
if (!rec.record_appended) console.error("WARNING: the audit record could not be appended; the printed record is the only copy");
process.exit(rec.outcome === "PASS" && rec.record_appended ? 0 : 1);
