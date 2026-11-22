// Runs the frozen benchmark's gate arm: one fresh paid auto-routed probe per
// case (Sepolia testnet), then scores both arms and writes a report to
// desk/benchmark/results/. The frontier arm's answers are imported, never
// produced here, and are validated BEFORE any paid run.
//
//   DESK_SECRETS_FILE=/path/to/env.txt npm run benchmark -- [--frontier answers.json]
//   npm run benchmark -- --export-questions questions.json     (no key, no spend)
//
// Payer key handling is identical to run-gate.ts (in-process only, pinned
// address). The case set is pinned to the committed hash, so
// DESK_BENCHMARK_CASES cannot swap the gold answers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertCommittedCases,
  assertSnapshotsCover,
  buildReport,
  exportQuestionPacket,
  loadCaseSet,
  loadSnapshotSet,
  renderMarkdown,
  validateFrontierAnswers,
  type FrontierAnswers,
} from "../src/benchmark.js";
import { runProbe, spendLedgerFromFiles, type ProbeRun } from "../src/gate.js";
import { normalizePrivateKey, readSecret } from "../src/secrets.js";

const here = dirname(fileURLToPath(import.meta.url));
const ledgerDir = process.env.DESK_LEDGER_DIR ?? join(here, "..", "ledger");
const casesFile = process.env.DESK_BENCHMARK_CASES ?? join(here, "..", "benchmark", "cases.v1.json");
const snapshotsFile = process.env.DESK_BENCHMARK_SNAPSHOTS ?? join(here, "..", "benchmark", "snapshots.v1.json");
const ledgerFile = process.env.DESK_BENCHMARK_LEDGER ?? join(ledgerDir, "benchmark-runs.jsonl");
const resultsDir = join(here, "..", "benchmark", "results");
const expected = (process.env.DESK_PAYER_ADDRESS ?? "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3").toLowerCase();

const frontierIdx = process.argv.indexOf("--frontier");
const frontierFile = frontierIdx >= 0 ? process.argv[frontierIdx + 1] : undefined;
const exportIdx = process.argv.indexOf("--export-questions");
const exportFile = exportIdx >= 0 ? process.argv[exportIdx + 1] : undefined;
if (!exportFile && process.argv.includes("--export-questions")) throw new Error("--export-questions takes a file");

// Freeze enforcement first: the committed case set, covered by snapshots.
const { caseSet, hash } = loadCaseSet(casesFile);
assertCommittedCases(hash);
assertSnapshotsCover(caseSet, loadSnapshotSet(snapshotsFile));

// Question-only export needs no key and no spend.
if (exportFile) {
  writeFileSync(exportFile, JSON.stringify(exportQuestionPacket(caseSet, hash), null, 2) + "\n");
  console.log(`wrote ${caseSet.cases.length} questions (cases_hash ${hash.slice(0, 12)}…) to ${exportFile}`);
  process.exit(0);
}

// Validate the frontier file and schema BEFORE any paid run.
const frontier: FrontierAnswers | null = frontierFile
  ? validateFrontierAnswers(JSON.parse(readFileSync(frontierFile, "utf8")), caseSet.cases, hash, caseSet.frozen_at)
  : null;

const secrets = process.env.DESK_SECRETS_FILE;
if (!secrets) throw new Error("set DESK_SECRETS_FILE");
const account = privateKeyToAccount(normalizePrivateKey(readSecret(secrets, "private_key")));
if (account.address.toLowerCase() !== expected) throw new Error("payer key does not match DESK_PAYER_ADDRESS; refusing to sign");
mkdirSync(ledgerDir, { recursive: true });

const spend = spendLedgerFromFiles({
  reservationsFile: join(ledgerDir, "reservations.jsonl"),
  lockFile: join(ledgerDir, "spend.lock"),
  purchasesFile: join(ledgerDir, "purchases.jsonl"),
  runLedgerFiles: [join(ledgerDir, "gate-runs.jsonl"), join(ledgerDir, "benchmark-runs.jsonl")],
});

const runs: ProbeRun[] = [];
for (const c of caseSet.cases) {
  const rec = await runProbe(
    { id: c.id, intent: c.intent, params: c.params, valueField: c.value_field, question: c.question },
    { address: account.address, signMessage: (m) => account.signMessage({ message: m }) },
    { frozenCaseSet: caseSet, casesVersion: caseSet.version, casesHash: hash, ledgerFile, spend },
  );
  runs.push(rec);
  console.log(`${c.id}: ${rec.outcome} value=${JSON.stringify(rec.value)}${rec.record_appended ? "" : " (AUDIT APPEND FAILED)"}`);
}

const report = buildReport(caseSet, hash, runs, frontier);
mkdirSync(resultsDir, { recursive: true });
const stamp = report.generated_at.replace(/[:.]/g, "-");
writeFileSync(join(resultsDir, `${stamp}.json`), JSON.stringify(report, null, 2));
writeFileSync(join(resultsDir, `${stamp}.md`), renderMarkdown(report, caseSet.cases));
console.log(`gate accuracy ${report.gate.correct}/${report.gate.total}, false passes ${report.gate.false_passes}, attempts ${report.gate.attempts}, cost ${report.gate.cost_usd}`);
if (report.frontier) console.log(`frontier accuracy ${report.frontier.correct}/${report.frontier.total}, false passes ${report.frontier.false_passes}`);
if (runs.some((r) => !r.record_appended)) process.exit(1);
