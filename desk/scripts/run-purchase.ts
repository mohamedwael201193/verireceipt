// Runs the autonomous Desk once: every planned task is bought from escrow
// on Ethereum Sepolia (testnet), verified end to end, and appended to
// desk/ledger/purchases.jsonl.
//
//   DESK_SECRETS_FILE=/path/to/env.txt npm run purchase [-- task-id ...]
//
// The payer key is read in-process from DESK_SECRETS_FILE (key
// "private_key") and never printed. DESK_PAYER_ADDRESS pins the expected
// payer; the run refuses to sign with any other key.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { runDesk } from "../src/agent.js";
import { normalizePrivateKey, readSecret } from "../src/secrets.js";

const here = dirname(fileURLToPath(import.meta.url));
const ledgerFile = join(here, "..", "ledger", "purchases.jsonl");
const secrets = process.env.DESK_SECRETS_FILE;
const expected = (process.env.DESK_PAYER_ADDRESS ?? "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3").toLowerCase();
const minerIds = (process.env.DESK_MINER_IDS ?? "774921,6152").split(",").map((s) => s.trim()).filter(Boolean);
const evidenceDir = process.env.DESK_EVIDENCE_DIR;
if (!secrets) throw new Error("set DESK_SECRETS_FILE");

const account = privateKeyToAccount(normalizePrivateKey(readSecret(secrets, "private_key")));
if (account.address.toLowerCase() !== expected) throw new Error("payer key does not match DESK_PAYER_ADDRESS; refusing to sign");
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

const records = await runDesk(
  { address: account.address, signMessage: (message) => account.signMessage({ message }) },
  {
    ledgerFile,
    minerIds,
    taskIds: process.argv.slice(2).length ? process.argv.slice(2) : undefined,
    log: (l) => console.log(l),
    onRawResponse: (task, raw) => {
      if (evidenceDir) writeFileSync(join(evidenceDir, `${task.id}-${Date.now()}.json`), JSON.stringify(raw, null, 2));
    },
  },
);
console.log(JSON.stringify(records.map((r) => ({ task: r.task_id, verdict: r.verdict, receipt_hash: r.telegraph_receipt.receipt_hash, epoch: r.telegraph_receipt.epoch_id, rcpt: r.miner_receipt?.receipt_id, value: r.value, recovered: r.recovered_fields ? Object.fromEntries(Object.entries(r.recovered_fields).filter(([, f]) => f.source === "raw").map(([k, f]) => [k, f.value])) : null })), null, 2));
