// Explicit two-command workflow. 'plan' never loads a key or reaches the network.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { readLedger, spentOnUtcDay } from "../src/ledger.js";
import { normalizePrivateKey, readSecret } from "../src/secrets.js";
import { makeResearchPlan, planHash, researchMarkdown, validateResearchPlan, type ResearchPlan } from "../src/research.js";
import { runResearch } from "../src/researchAgent.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, arg, dest, ...extra] = process.argv.slice(2);
if (extra.length || !arg || !["plan", "buy"].includes(command) || (command === "plan" ? !dest : !!dest)) {
  throw new Error("Usage: npm run research -- plan input.json NEW_RUN_DIRECTORY | buy RUN_DIRECTORY");
}
if (command === "plan") {
  const input = JSON.parse(readFileSync(resolve(arg), "utf8"));
  if (Object.keys(input).sort().join(",") !== "cik,form,minimum_count,year") throw new Error("Input must contain only cik, form, minimum_count, year");
  const plan = makeResearchPlan(input);
  const dir = resolve(dest);
  mkdirSync(dir); // Never reuse or overwrite a plan directory.
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
  writeFileSync(join(dir, "plan.sha256"), planHash(plan) + "\n", { flag: "wx" });
  console.log(`Plan only, no purchase. SHA256 ${planHash(plan)}. Inspect plan.json before using buy. Local hash is not an independent timestamp.`);
} else {
  const dir = resolve(arg);
  const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as ResearchPlan;
  const hash = readFileSync(join(dir, "plan.sha256"), "utf8").trim();
  validateResearchPlan(plan, hash);
  const secrets = process.env.DESK_SECRETS_FILE;
  const expected = process.env.DESK_PAYER_ADDRESS;
  if (!secrets || !expected || !/^0x[0-9a-fA-F]{40}$/.test(expected)) throw new Error("Set DESK_SECRETS_FILE and explicit DESK_PAYER_ADDRESS; no key in CLI arguments");
  const account = privateKeyToAccount(normalizePrivateKey(readSecret(secrets, "private_key")));
  if (account.address.toLowerCase() !== expected.toLowerCase()) throw new Error("Payer key/address mismatch");
  const journalDir = join(root, "research-runs");
  mkdirSync(journalDir, { recursive: true });
  const lock = join(journalDir, "purchase.lock");
  const fd = openSync(lock, "wx"); // Serialize research purchases; never steal a stale lock automatically.
  try {
    writeFileSync(join(dir, "attempt.json"), JSON.stringify({ started_at: new Date().toISOString(), plan_hash: hash, network: plan.network }) + "\n", { flag: "wx" });
    const journal = join(journalDir, "reservations.jsonl");
    const day = new Date().toISOString().slice(0, 10);
    const reservations = existsSync(journal) ? readFileSync(journal, "utf8").split("\n").filter(Boolean).map(x => JSON.parse(x) as { at: string; reserved_uusdc: string }) : [];
    const reserved = reservations.filter(x => x.at.slice(0, 10) === day).reduce((sum, x) => sum + BigInt(x.reserved_uusdc), 0n);
    const canonicalSpent = spentOnUtcDay(readLedger(join(root, "ledger", "purchases.jsonl")), new Date());
    const run = await runResearch(plan, hash, { address: account.address, signMessage: message => account.signMessage({ message }) }, {
      spentTodayUusdc: canonicalSpent + reserved,
      beforeSign: reservation => {
        const reservationFd = openSync(journal, "a");
        try { appendFileSync(reservationFd, JSON.stringify(reservation) + "\n"); fsyncSync(reservationFd); }
        finally { closeSync(reservationFd); }
      },
      onRawResponse: raw => writeFileSync(join(dir, "paid-response.json"), JSON.stringify({ status: raw.status,
        receipt_header: raw.headers["x-payment-response"] ?? null, body: raw.bodyText, authorization: raw.authorization,
        signed_message: raw.signedMessage }, null, 2) + "\n", { flag: "wx" }),
    });
    writeFileSync(join(dir, "report.json"), JSON.stringify(run, null, 2) + "\n", { flag: "wx" });
    const appendix = researchMarkdown(plan, hash, run.result) + `\n## Payment evidence\n\nSepolia test amount: ${run.testnet_amount_uusdc} micro-USDC.\n\nSignal: ${run.signal_hash}\n\nReceipt: ${run.receipt.receipt_hash}; epoch ${run.receipt.epoch_id}; delivery ${run.delivery.status}.\n\n${run.accounting_limit}\n`;
    writeFileSync(join(dir, "appendix.md"), appendix, { flag: "wx" });
    console.log(JSON.stringify({ status: run.result.status, reason: run.result.reason, count: run.result.observed_count,
      testnet_uusdc: run.testnet_amount_uusdc, delivery: run.delivery.status, plan_hash: hash }, null, 2));
  } catch (error) {
    // A post-sign error can be charged or pending. Never assert 'no charge' or retry automatically.
    writeFileSync(join(dir, "incomplete.json"), JSON.stringify({ status: "HOLD", reason: "Run interrupted or failed. Inspect captured response, reservation and live accounting before any new attempt.",
      recorded_at: new Date().toISOString() }) + "\n", { flag: "wx" });
    throw new Error("Research run incomplete. Payment/accounting may be pending or charged. Inspect local evidence and live records; do not retry automatically.");
  } finally { closeSync(fd); unlinkSync(lock); }
}
