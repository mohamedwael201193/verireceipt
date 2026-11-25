// Cost per verified correct verdict (mission issue #198, Route 1): buy a
// fixed, disclosed evaluation set from each supported provider through
// escrow, verify every purchase end to end, check the returned rating
// against the disclosed key band with an exact comparator, and report each
// provider's spend and cost per verified correct verdict. Local CLI only,
// testnet only; no production earnings are claimed or implied. The harness
// never acts on results; the report is the deliverable.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ONE_CALL_UUSDC } from "./constants.js";
import { escrowAskMiner, type Fetch, type Payer } from "./client.js";
import { EscrowRefusal } from "./escrow.js";
import { committedExposureUusdc, reserveSpend, type SpendLedger } from "./gate.js";
import { paramsEqual, verifyPurchase } from "./verify.js";
import type { FieldStatus } from "../../src/core/shapedFields.js";
import type { MemoReceipt } from "./personalAgent.js";

export const EVAL_INTENT = "LLM_OUTPUT_EVALUATION_GENERAL";
/** The harness's default daily budget, its conservative share of the shared
 * desk-wide cap: at most 10 flat calls per UTC day (one provider of the
 * shipped 6-case set is 60,000). Other desk spend that day reduces it. */
export const EVAL_DAILY_CAP_UUSDC = 100_000n;
/** The published rating enum (engine response schema, processed field). */
export const RATINGS = ["Excellent", "Good", "Acceptable", "Poor", "Fails"] as const;
export type Rating = (typeof RATINGS)[number];
export const KEY_BANDS: Record<"pass" | "fail", readonly Rating[]> = {
  pass: ["Excellent", "Good", "Acceptable"],
  fail: ["Poor", "Fails"],
};

export interface EvalCase {
  id: string;
  task: string;
  output: string;
  key: "pass" | "fail";
  rationale: string;
}

export interface EvalSet {
  version: number;
  label: string;
  cases: EvalCase[];
}

/** Validation shared by the CLI and the harness; returns the defect or null. */
export function evalSetDefect(set: unknown): string | null {
  if (!set || typeof set !== "object") return "eval set must be an object";
  const cases = (set as EvalSet).cases;
  if (!Array.isArray(cases) || cases.length === 0) return "eval set must hold a non-empty cases array";
  const ids = new Set<string>();
  for (const c of cases) {
    if (!c || typeof c !== "object") return "every case must be an object";
    if (!c.id || typeof c.id !== "string" || ids.has(c.id)) return "case ids must be unique non-empty strings";
    ids.add(c.id);
    if (typeof c.task !== "string" || !c.task) return `case ${c.id}: task must be a non-empty string`;
    if (typeof c.output !== "string" || !c.output) return `case ${c.id}: output must be a non-empty string`;
    if (c.key !== "pass" && c.key !== "fail") return `case ${c.id}: key must be pass|fail`;
    if (typeof c.rationale !== "string" || !c.rationale) return `case ${c.id}: rationale is required (the key must be defensible)`;
  }
  return null;
}

export type VerdictStatus = "correct" | "incorrect" | "unusable" | "failed-payment" | "failed-verification" | "skipped-budget";

export interface VerdictRecord {
  case_id: string;
  provider: string;
  status: VerdictStatus;
  /** The verified rating when there is one; null otherwise. */
  rating: string | null;
  key: "pass" | "fail";
  reason: string | null;
  latency_ms: number | null;
  receipts: MemoReceipt[];
}

export interface ProviderScore {
  provider: string;
  /** Cases actually run (paid and answered); skipped-budget cases are not run. */
  cases_run: number;
  correct: number;
  incorrect: number;
  /** Missing or non-enum rating: the unknown bucket, never counted as incorrect. */
  unusable: number;
  failed_payment: number;
  failed_verification: number;
  /** Not run: the shared daily cap refused the purchase. Excluded from comparison. */
  skipped_budget: number;
  /** Recorded receipts only. */
  spend_uusdc: string;
  /** Journaled reservations; a reservation stands even when its call fails. */
  reserved_uusdc: string;
  /** Cost per verified correct verdict in micro-USDC, truncated to 2 decimals; null when the provider produced none. */
  cost_per_correct_uusdc: string | null;
}

export interface EvalReport {
  version: 1;
  label: string;
  intent: string;
  generated_at: string;
  testnet: true;
  /** What this report does and does not show; keep in sync with docs/cost-per-verified-verdict.md. */
  disclosure: string[];
  providers: ProviderScore[];
  totals: { spend_uusdc: string; reserved_uusdc: string; correct: number; cases_run: number; skipped_budget: number };
  verdicts: VerdictRecord[];
}

export interface EvalOptions {
  spend: SpendLedger;
  outDir: string;
  dailyCapUusdc?: bigint;
  /** Every id the node may use for a provider in receipts; defaults to the called id. */
  minerIds?: Record<string, readonly string[]>;
  now?: () => Date;
  f?: Fetch;
  /** Injected verifier for unit tests; production uses the real end-to-end verifier. */
  verify?: typeof verifyPurchase;
  log?: (line: string) => void;
}

interface AskBody {
  result?: Record<string, unknown>;
  field_status?: Record<string, FieldStatus>;
  signal_hash?: string;
}

/** Cost per correct verdict in micro-USDC, truncated to 2 decimals (never floats); null when correct is zero. */
export function costPerCorrect(spendUusdc: bigint, correct: number): string | null {
  if (correct === 0) return null;
  const per = spendUusdc / BigInt(correct);
  const rem = spendUusdc % BigInt(correct);
  const cents = (rem * 100n) / BigInt(correct);
  return `${per}.${cents.toString().padStart(2, "0")}`;
}

/** The disclosure block carried in every report and mirrored in the docs. */
export function evalDisclosure(set: EvalSet): string[] {
  const pass = set.cases.filter((c) => c.key === "pass").length;
  const fail = set.cases.length - pass;
  return [
    `${set.cases.length} synthetic cases (${pass} pass, ${fail} fail), one run; no statistical significance.`,
    "Keys are the author's judgement; each case carries its rationale in the case file.",
    "The harness measures how an evaluator's rating matches those keys, not whether the provider is a good answering model.",
    "'verified' means delivery and receipt integrity; 'correct' means the rating matches the key band.",
    "Ratings are not repeated; one noisy run can move a ranking.",
    "cost_per_correct_uusdc is in micro-USDC, truncated to 2 decimals.",
    "spend_uusdc is recorded receipts; reserved_uusdc is the journaled reservation total (a reservation stands even when its call fails).",
    "skipped-budget cases were not run: the shared daily cap refused the purchase.",
  ];
}

export async function runEvalHarness(payer: Payer, set: EvalSet, providers: string[], opts: EvalOptions): Promise<EvalReport> {
  const defect = evalSetDefect(set);
  if (defect) throw new Error(`eval set: ${defect}`);
  if (!providers.length) throw new Error("at least one provider id is required");
  if (new Set(providers).size !== providers.length) throw new Error(`duplicate provider ids: ${providers.join(", ")}`);
  const now = (opts.now ?? (() => new Date()))();
  const log = opts.log ?? (() => {});
  const cap = opts.dailyCapUusdc ?? EVAL_DAILY_CAP_UUSDC;
  const verdicts: VerdictRecord[] = [];
  const reserved = new Map<string, bigint>();
  for (const provider of providers) {
    for (const c of set.cases) {
      const started = Date.now();
      // Pre-sign cap check: never ask the node when the shared daily cap
      // cannot cover one flat call. reserveSpend inside onBeforeSign stays
      // the authoritative gate; its refusal is the same typed status.
      const remaining = cap - committedExposureUusdc(opts.spend, now);
      if (remaining < ONE_CALL_UUSDC) {
        verdicts.push({ case_id: c.id, provider, status: "skipped-budget", rating: null, key: c.key, reason: `not run: remaining shared daily cap ${remaining} μUSDC below one call ${ONE_CALL_UUSDC} μUSDC`, latency_ms: null, receipts: [] });
        log(`${provider}/${c.id}: not run (shared daily cap)`);
        continue;
      }
      let paid;
      try {
        paid = await escrowAskMiner(provider, { intent: EVAL_INTENT, params: { task: c.task, output: c.output } }, payer, {
          spentTodayUusdc: committedExposureUusdc(opts.spend, now),
          dailyCapUusdc: cap,
          minerIds: opts.minerIds?.[provider] ?? [provider],
          f: opts.f,
          onBeforeSign: ({ amountUusdc, authorization }) => {
            reserveSpend(opts.spend, "eval", amountUusdc, authorization.nonce, cap, now);
            reserved.set(provider, (reserved.get(provider) ?? 0n) + amountUusdc);
          },
        });
      } catch (e) {
        const budget = e instanceof EscrowRefusal && /daily cap/.test(e.message);
        verdicts.push({ case_id: c.id, provider, status: budget ? "skipped-budget" : "failed-payment", rating: null, key: c.key, reason: budget ? `not run: ${(e as Error).message}` : (e as Error).message, latency_ms: Date.now() - started, receipts: [] });
        log(`${provider}/${c.id}: ${budget ? "not run (shared daily cap)" : `failed payment (${(e as Error).message})`}`);
        continue;
      }
      const receipt: MemoReceipt = {
        miner_id: provider,
        nonce: paid.authorization.nonce,
        receipt_hash: paid.receipt.receipt_hash,
        charge_uusdc: String(paid.receipt.amount_uusdc),
      };
      const body = paid.body as AskBody;
      const signalHash = String(body.signal_hash ?? "");
      if (!/^0x[0-9a-f]{64}$/.test(signalHash)) {
        verdicts.push({ case_id: c.id, provider, status: "failed-verification", rating: null, key: c.key, reason: "paid reply carried no signal_hash", latency_ms: Date.now() - started, receipts: [receipt] });
        continue;
      }
      const verify = opts.verify ?? verifyPurchase;
      const v = await verify(
        { payer: paid.authorization.from, minerSlug: provider, signalHash, valueField: "rating", engineResult: body.result ?? {}, intent: EVAL_INTENT, fieldStatus: body.field_status },
        opts.f,
      );
      if (!v.verified) {
        const failed = v.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join("; ");
        verdicts.push({ case_id: c.id, provider, status: "failed-verification", rating: null, key: c.key, reason: failed, latency_ms: Date.now() - started, receipts: [receipt] });
        continue;
      }
      // The verified answer must belong to the question we sent: the on-chain
      // signal records the exact request params the miner answered. The
      // comparison is key-order independent and rejects extra or missing
      // keys (paramsEqual; unit-tested).
      if (!paramsEqual({ task: c.task, output: c.output }, v.requestParams)) {
        verdicts.push({ case_id: c.id, provider, status: "failed-verification", rating: null, key: c.key, reason: "verified answer belongs to a different request (signal request params differ)", latency_ms: Date.now() - started, receipts: [receipt] });
        continue;
      }
      const field = v.fields?.rating;
      const rating = field === undefined ? null : String(typeof field === "object" && field !== null && "value" in field ? (field as { value: unknown }).value : field);
      if (rating === null || rating === "undefined" || !(RATINGS as readonly string[]).includes(rating)) {
        verdicts.push({ case_id: c.id, provider, status: "unusable", rating, key: c.key, reason: rating === null || rating === "undefined" ? "verified answer carried no rating field" : `rating ${JSON.stringify(rating)} is outside the published enum`, latency_ms: Date.now() - started, receipts: [receipt] });
        continue;
      }
      const correct = (KEY_BANDS[c.key] as readonly string[]).includes(rating);
      verdicts.push({ case_id: c.id, provider, status: correct ? "correct" : "incorrect", rating, key: c.key, reason: null, latency_ms: Date.now() - started, receipts: [receipt] });
      log(`${provider}/${c.id}: ${rating} vs key ${c.key} -> ${correct ? "correct" : "incorrect"}`);
    }
  }
  const providersOut: ProviderScore[] = providers.map((p) => {
    const mine = verdicts.filter((r) => r.provider === p);
    const run = mine.filter((r) => r.status !== "skipped-budget");
    const count = (s: VerdictStatus) => mine.filter((r) => r.status === s).length;
    const spend = mine.reduce((sum, r) => sum + r.receipts.reduce((a, x) => a + BigInt(x.charge_uusdc), 0n), 0n);
    const correct = count("correct");
    return {
      provider: p,
      cases_run: run.length,
      correct,
      incorrect: count("incorrect"),
      unusable: count("unusable"),
      failed_payment: count("failed-payment"),
      failed_verification: count("failed-verification"),
      skipped_budget: count("skipped-budget"),
      spend_uusdc: spend.toString(),
      reserved_uusdc: (reserved.get(p) ?? 0n).toString(),
      cost_per_correct_uusdc: costPerCorrect(spend, correct),
    };
  });
  const totalSpend = verdicts.reduce((sum, r) => sum + r.receipts.reduce((a, x) => a + BigInt(x.charge_uusdc), 0n), 0n);
  const totalReserved = [...reserved.values()].reduce((a, x) => a + x, 0n);
  const run = verdicts.filter((r) => r.status !== "skipped-budget");
  const report: EvalReport = {
    version: 1,
    label: set.label,
    intent: EVAL_INTENT,
    generated_at: now.toISOString(),
    testnet: true,
    disclosure: evalDisclosure(set),
    providers: providersOut,
    totals: {
      spend_uusdc: totalSpend.toString(),
      reserved_uusdc: totalReserved.toString(),
      correct: verdicts.filter((r) => r.status === "correct").length,
      cases_run: run.length,
      skipped_budget: verdicts.filter((r) => r.status === "skipped-budget").length,
    },
    verdicts,
  };
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "eval-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  appendFileSync(join(opts.outDir, "eval-verdicts.jsonl"), verdicts.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  return report;
}

/** Load and validate a cases file (the CLI's entry point shares this). */
export function loadEvalSet(file: string): EvalSet {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as EvalSet;
  const defect = evalSetDefect(parsed);
  if (defect) throw new Error(`eval set: ${defect}`);
  return parsed;
}
