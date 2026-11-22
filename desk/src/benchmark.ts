// Frontier benchmark: frozen cases (committed before any arm answered) are
// graded for two arms - the VeriReceipt Gate (fresh paid, verified answers)
// and an external frontier model with web search (answers imported with
// provenance). Scoring is honest about abstains: a gate ABSTAIN or a
// frontier non-answer is reported separately and never counts as correct.
// Pure functions only: no network, no key handling.
//
// Freeze enforcement: the CLI pins COMMITTED_CASES_SHA256 (DESK_BENCHMARK_CASES
// cannot swap gold), every grader is bound to a versioned primary snapshot
// (snapshots.v1.json, sha256 per case, revision policy there), and imported
// frontier answers must name the same cases_hash.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalPayloadJson } from "./verify.js";
import { probeInputHash, type ProbeRun } from "./gate.js";

export const BENCHMARK_VERSION = "frontier-benchmark-v1";
export const BENCHMARK_MAX_CASE_COST_UUSDC = 10_000n;

/**
 * The freeze anchor: sha256 (canonical JSON) of desk/benchmark/cases.v1.json
 * as committed before any arm answered. The CLI refuses to run any other
 * case file, so DESK_BENCHMARK_CASES cannot swap the gold answers.
 */
export const COMMITTED_CASES_SHA256 = "31331c9f69cde1c24a8d40722a3b90a5119df739b757f42787a3526738961da1";

export function assertCommittedCases(hash: string): void {
  if (hash !== COMMITTED_CASES_SHA256) {
    throw new Error(`case-set hash ${hash} does not match the committed benchmark cases ${COMMITTED_CASES_SHA256}; refusing to grade against uncommitted gold`);
  }
}

export type Grader =
  | { type: "exact_number"; expected: number }
  | { type: "numeric_tolerance"; expected: number; tolerance_pct: number };

export interface BenchmarkCase {
  id: string;
  intent: string;
  params: Record<string, string>;
  value_field: string;
  /** The natural-language question handed to the frontier arm (no expected value). */
  question: string;
  grader: Grader;
  reference: { source: string; checked_at: string; detail: string; snapshot_sha256: string };
}

export interface CaseSet {
  version: typeof BENCHMARK_VERSION;
  frozen_at: string;
  note: string;
  cases: BenchmarkCase[];
}

export interface SnapshotSet {
  version: "frontier-benchmark-snapshots-v1";
  revision_policy: string;
  snapshots: Array<{ case_id: string; source: string; retrieved_at: string; evidence: string; sha256: string; note?: string }>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateCaseSet(raw: unknown): CaseSet {
  if (!isPlainObject(raw)) throw new Error("case set is not an object");
  if (raw.version !== BENCHMARK_VERSION) throw new Error(`case set version ${String(raw.version)} is not ${BENCHMARK_VERSION}`);
  if (typeof raw.frozen_at !== "string" || !Number.isFinite(Date.parse(raw.frozen_at))) throw new Error("frozen_at is not a timestamp");
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error("no cases");
  const ids = new Set<string>();
  for (const [i, c] of raw.cases.entries()) {
    if (!isPlainObject(c)) throw new Error(`case ${i} is not an object`);
    for (const k of ["id", "intent", "value_field", "question"] as const) {
      if (typeof c[k] !== "string" || !(c[k] as string)) throw new Error(`case ${i}: ${k} must be a non-empty string`);
    }
    if (ids.has(c.id as string)) throw new Error(`duplicate case id ${String(c.id)}`);
    ids.add(c.id as string);
    if (!isPlainObject(c.params) || Object.values(c.params).some((v) => typeof v !== "string")) throw new Error(`case ${c.id}: params must be a string map`);
    const g = c.grader;
    if (!isPlainObject(g)) throw new Error(`case ${c.id}: grader missing`);
    if (g.type === "exact_number") {
      if (!isFiniteNumber(g.expected)) throw new Error(`case ${c.id}: grader.expected must be a finite number`);
    } else if (g.type === "numeric_tolerance") {
      if (!isFiniteNumber(g.expected) || !isFiniteNumber(g.tolerance_pct) || (g.tolerance_pct as number) < 0) {
        throw new Error(`case ${c.id}: bad numeric_tolerance grader`);
      }
    } else {
      throw new Error(`case ${c.id}: unknown grader type ${String(g.type)}`);
    }
    if (!isPlainObject(c.reference) || typeof c.reference.source !== "string" || typeof c.reference.checked_at !== "string" || typeof c.reference.detail !== "string") {
      throw new Error(`case ${c.id}: reference must name source, checked_at and detail`);
    }
    if (typeof c.reference.snapshot_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.reference.snapshot_sha256)) {
      throw new Error(`case ${c.id}: reference.snapshot_sha256 must bind the case to its versioned primary snapshot`);
    }
  }
  return raw as unknown as CaseSet;
}

export function validateSnapshotSet(raw: unknown): SnapshotSet {
  if (!isPlainObject(raw)) throw new Error("snapshot set is not an object");
  if (raw.version !== "frontier-benchmark-snapshots-v1") throw new Error("snapshot set version mismatch");
  if (typeof raw.revision_policy !== "string" || !raw.revision_policy) throw new Error("snapshot set must state a revision policy");
  if (!Array.isArray(raw.snapshots) || raw.snapshots.length === 0) throw new Error("no snapshots");
  const ids = new Set<string>();
  for (const s of raw.snapshots) {
    if (!isPlainObject(s) || typeof s.case_id !== "string" || typeof s.evidence !== "string" || typeof s.source !== "string" || typeof s.retrieved_at !== "string") {
      throw new Error("malformed snapshot");
    }
    if (ids.has(s.case_id)) throw new Error(`duplicate snapshot for ${s.case_id}`);
    ids.add(s.case_id);
    const digest = createHash("sha256").update(s.evidence).digest("hex");
    if (s.sha256 !== digest) throw new Error(`snapshot ${s.case_id}: sha256 does not match the evidence bytes`);
  }
  return raw as unknown as SnapshotSet;
}

/** Every case's reference must bind to exactly one snapshot of the same hash, and vice versa. */
export function assertSnapshotsCover(caseSet: CaseSet, snapshots: SnapshotSet): void {
  const byId = new Map(snapshots.snapshots.map((s) => [s.case_id, s.sha256]));
  for (const c of caseSet.cases) {
    const sha = byId.get(c.id);
    if (sha === undefined) throw new Error(`case ${c.id} has no primary snapshot`);
    if (sha !== c.reference.snapshot_sha256) throw new Error(`case ${c.id}: reference.snapshot_sha256 does not match its snapshot`);
  }
  for (const s of snapshots.snapshots) {
    if (!caseSet.cases.some((c) => c.id === s.case_id)) throw new Error(`snapshot for unknown case ${s.case_id}`);
  }
}

export function loadCaseSet(file: string): { caseSet: CaseSet; hash: string } {
  const text = readFileSync(file, "utf8");
  const caseSet = validateCaseSet(JSON.parse(text));
  const hash = createHash("sha256").update(canonicalPayloadJson(JSON.parse(text))).digest("hex");
  return { caseSet, hash };
}

export function loadSnapshotSet(file: string): SnapshotSet {
  return validateSnapshotSet(JSON.parse(readFileSync(file, "utf8")));
}

export type Grade = "correct" | "incorrect" | "abstain";

/** Grade one answered value; null / non-finite is an abstain, never a wrong answer. */
export function gradeValue(grader: Grader, value: unknown): Grade {
  if (!isFiniteNumber(value)) return "abstain";
  if (grader.type === "exact_number") return value === grader.expected ? "correct" : "incorrect";
  const tol = Math.abs(grader.expected) * (grader.tolerance_pct / 100);
  return Math.abs(value - grader.expected) <= tol ? "correct" : "incorrect";
}

export interface ArmScore {
  correct: number;
  incorrect: number;
  abstain: number;
  total: number;
  /** correct / total (abstains count against accuracy: the question was not answered). */
  accuracy: number;
  /** correct / (correct + incorrect), the precision when the arm commits to an answer. */
  precision_when_answered: number;
  /** Confident wrong answers: the failure mode a gate exists to prevent. */
  false_passes: number;
  details: Array<{ case_id: string; value: unknown; grade: Grade }>;
}

export function scoreValues(cases: BenchmarkCase[], valuesById: ReadonlyMap<string, unknown>): ArmScore {
  const details = cases.map((c) => {
    const value = valuesById.get(c.id) ?? null;
    return { case_id: c.id, value, grade: gradeValue(c.grader, value) };
  });
  const correct = details.filter((d) => d.grade === "correct").length;
  const incorrect = details.filter((d) => d.grade === "incorrect").length;
  const abstain = details.filter((d) => d.grade === "abstain").length;
  return {
    correct, incorrect, abstain, total: cases.length,
    accuracy: cases.length ? correct / cases.length : 0,
    precision_when_answered: correct + incorrect ? correct / (correct + incorrect) : 0,
    false_passes: incorrect,
    details,
  };
}

/**
 * The gate arm's values from its probe records. Strict: every record must be
 * a benchmark probe for THIS case set (kind and cases_hash), name a known
 * case exactly once, and only an ANSWERED record contributes its value; an
 * ABSTAIN record is an abstain. Any duplicate, unknown or mismatched record
 * rejects the whole run set rather than silently keeping the last row.
 */
export function probeValues(runs: readonly ProbeRun[], cases: BenchmarkCase[], casesHash: string): Map<string, unknown> {
  const known = new Set(cases.map((c) => c.id));
  const seen = new Set<string>();
  const m = new Map<string, unknown>();
  for (const r of runs) {
    if (r.kind !== "benchmark-probe") throw new Error(`record for ${r.case_id} is not a benchmark probe`);
    if (r.cases_hash !== casesHash) throw new Error(`record for ${r.case_id} names cases_hash ${r.cases_hash}, not this case set ${casesHash}`);
    if (!known.has(r.case_id)) throw new Error(`record for unknown case ${r.case_id}`);
    const c = cases.find((c) => c.id === r.case_id)!;
    const expectedInput = { id: c.id, intent: c.intent, params: c.params, valueField: c.value_field, question: c.question };
    const recordedInput = { id: r.case_id, intent: r.intent, params: r.params, valueField: r.value_field, question: r.question };
    if (probeInputHash(recordedInput) !== probeInputHash(expectedInput) || r.case_input_hash !== probeInputHash(expectedInput)) {
      throw new Error(`probe input for ${r.case_id} does not match the frozen case`);
    }
    if (seen.has(r.case_id)) throw new Error(`duplicate probe record for case ${r.case_id}; disclose every attempt, never collapse them`);
    seen.add(r.case_id);
    m.set(r.case_id, r.outcome === "ANSWERED" ? r.value : null);
  }
  return m;
}

export interface FrontierAnswers {
  version: typeof BENCHMARK_VERSION;
  /** Must equal the frozen case-set hash; answers for another case set are rejected. */
  cases_hash: string;
  model: string;
  provider: string;
  ran_at: string;
  web_search: boolean;
  provenance: string;
  answers: Array<{ case_id: string; value: number | null }>;
}

export function validateFrontierAnswers(raw: unknown, cases: BenchmarkCase[], casesHash: string, frozenAt: string): FrontierAnswers {
  if (!isPlainObject(raw)) throw new Error("frontier answers not an object");
  if (raw.version !== BENCHMARK_VERSION) throw new Error(`frontier answers version ${String(raw.version)} is not ${BENCHMARK_VERSION}`);
  if (raw.cases_hash !== casesHash) throw new Error(`frontier answers bind cases_hash ${String(raw.cases_hash)}, not this case set ${casesHash}`);
  for (const k of ["model", "provider", "ran_at", "provenance"] as const) {
    if (typeof raw[k] !== "string" || !(raw[k] as string)) throw new Error(`frontier answers: ${k} must be a non-empty string`);
  }
  if (!Number.isFinite(Date.parse(raw.ran_at as string))) throw new Error("frontier answers: ran_at is not a timestamp");
  if (Date.parse(raw.ran_at as string) < Date.parse(frozenAt)) {
    throw new Error("frontier answers: ran_at precedes the case-set freeze; answers must be produced after the freeze");
  }
  if (typeof raw.web_search !== "boolean") throw new Error("frontier answers: web_search must be declared true or false");
  if (!Array.isArray(raw.answers)) throw new Error("frontier answers: answers must be a list");
  const known = new Set(cases.map((c) => c.id));
  const seen = new Set<string>();
  for (const a of raw.answers) {
    if (!isPlainObject(a) || typeof a.case_id !== "string" || !known.has(a.case_id)) throw new Error(`unknown or malformed case_id ${String((a as { case_id?: unknown })?.case_id)}`);
    if (seen.has(a.case_id)) throw new Error(`duplicate answer for ${a.case_id}`);
    seen.add(a.case_id);
    if (a.value !== null && !isFiniteNumber(a.value)) throw new Error(`answer ${a.case_id}: value must be a finite number or null`);
  }
  if (seen.size !== known.size) throw new Error("frontier answers: every case must be answered or explicitly abstained with null");
  return raw as unknown as FrontierAnswers;
}

export function frontierValues(a: FrontierAnswers): Map<string, unknown> {
  return new Map(a.answers.map((x) => [x.case_id, x.value]));
}

/**
 * The question-only packet handed to the frontier arm: case ids and question
 * text, never expected values, grader internals or snapshot evidence. The
 * presentation protocol is part of the packet so the answers file can be
 * checked against it.
 */
export const PRESENTATION_PROTOCOL = [
  "Ask each question verbatim, once, in a fresh session with no access to this repository, the expected values or the snapshot evidence.",
  "Record the exact model, provider, whether web search was enabled, and when the run happened (ran_at, after the freeze).",
  "Answer each case with one finite number, or null when the model will not commit; never leave a case_id out or repeat one.",
  "Bind the answers file to the packet's cases_hash.",
] as const;

export interface QuestionPacket {
  version: typeof BENCHMARK_VERSION;
  cases_hash: string;
  frozen_at: string;
  protocol: readonly string[];
  questions: Array<{ case_id: string; question: string }>;
}

export function exportQuestionPacket(caseSet: CaseSet, casesHash: string): QuestionPacket {
  return {
    version: BENCHMARK_VERSION,
    cases_hash: casesHash,
    frozen_at: caseSet.frozen_at,
    protocol: PRESENTATION_PROTOCOL,
    questions: caseSet.cases.map((c) => ({ case_id: c.id, question: c.question })),
  };
}

export interface BenchmarkReport {
  version: typeof BENCHMARK_VERSION;
  generated_at: string;
  cases_hash: string;
  frozen_at: string;
  gate: ArmScore & {
    /** Every paid probe record in this report; duplicates are rejected, never collapsed. */
    attempts: number;
    cost_uusdc: string;
    cost_usd: string;
    /** Paid request round-trip only (challenge + paid ask), excluding verification and grading. */
    paid_request_latency_ms: { min: number | null; max: number | null; mean: number | null };
  };
  frontier: (ArmScore & { model: string; provider: string; ran_at: string; web_search: boolean; provenance: string }) | null;
  limits: string[];
}

export const BENCHMARK_LIMITS = [
  "Eight frozen cases over past immutable states, chosen before any arm answered; not a claim about every question type.",
  "Each grader is bound to a versioned primary snapshot (snapshots.v1.json); if a source later revises a value, the frozen snapshot stands and the revision is documented, never silently re-frozen.",
  "The gate arm paid Sepolia testnet escrow prices ($0.01 flat per case); costs are testnet accounting, not mainnet pricing.",
  "A gate ABSTAIN counts against accuracy and is never counted as a correct answer; every paid attempt is disclosed (attempts), duplicates are rejected.",
  "Gate latency is the paid request round-trip only; verification and grading time are excluded.",
  "The frontier arm's answers are imported with their declared provenance and bound to this cases_hash; the harness scores them, it does not re-run the model.",
] as const;

export function buildReport(
  caseSet: CaseSet,
  casesHash: string,
  runs: readonly ProbeRun[],
  frontier: FrontierAnswers | null,
  now = new Date(),
): BenchmarkReport {
  if (createHash("sha256").update(canonicalPayloadJson(caseSet)).digest("hex") !== casesHash) {
    throw new Error("report case-set contents do not match cases_hash");
  }
  if (frontier) validateFrontierAnswers(frontier, caseSet.cases, casesHash, caseSet.frozen_at);
  const gate = scoreValues(caseSet.cases, probeValues(runs, caseSet.cases, casesHash));
  const lat = runs.map((r) => r.purchase.duration_ms).filter((d): d is number => typeof d === "number");
  const cost = runs.reduce((s, r) => s + BigInt(r.purchase.paid_uusdc ?? r.purchase.worst_case_uusdc ?? "0"), 0n);
  return {
    version: BENCHMARK_VERSION,
    generated_at: now.toISOString(),
    cases_hash: casesHash,
    frozen_at: caseSet.frozen_at,
    gate: {
      ...gate,
      attempts: runs.length,
      cost_uusdc: cost.toString(),
      cost_usd: `$${(Number(cost) / 1e6).toFixed(2)}`,
      paid_request_latency_ms: lat.length
        ? { min: Math.min(...lat), max: Math.max(...lat), mean: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) }
        : { min: null, max: null, mean: null },
    },
    frontier: frontier
      ? { ...scoreValues(caseSet.cases, frontierValues(frontier)), model: frontier.model, provider: frontier.provider, ran_at: frontier.ran_at, web_search: frontier.web_search, provenance: frontier.provenance }
      : null,
    limits: [...BENCHMARK_LIMITS],
  };
}

export function renderMarkdown(r: BenchmarkReport, cases: BenchmarkCase[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const rows = cases.map((c) => {
    const g = r.gate.details.find((d) => d.case_id === c.id)!;
    const f = r.frontier?.details.find((d) => d.case_id === c.id);
    const expected = c.grader.type === "exact_number" ? String(c.grader.expected) : `${c.grader.expected} ±${c.grader.tolerance_pct}%`;
    return `| ${c.id} | ${expected} | ${JSON.stringify(g.value)} (${g.grade}) | ${f ? `${JSON.stringify(f.value)} (${f.grade})` : "-"} |`;
  });
  return [
    `# Frontier benchmark (${r.version})`,
    ``,
    `Cases frozen at ${r.frozen_at} (hash ${r.cases_hash.slice(0, 12)}…), before any arm answered, each bound to a versioned primary snapshot. Report generated ${r.generated_at}.`,
    ``,
    `| Arm | Accuracy (of ${r.gate.total}) | Precision when answered | False passes | Abstains |`,
    `| --- | --- | --- | --- | --- |`,
    `| VeriReceipt Gate | ${r.gate.correct} (${pct(r.gate.accuracy)}) | ${pct(r.gate.precision_when_answered)} | ${r.gate.false_passes} | ${r.gate.abstain} |`,
    ...(r.frontier
      ? [`| ${r.frontier.model} (web search: ${r.frontier.web_search ? "on" : "off"}) | ${r.frontier.correct} (${pct(r.frontier.accuracy)}) | ${pct(r.frontier.precision_when_answered)} | ${r.frontier.false_passes} | ${r.frontier.abstain} |`]
      : []),
    ``,
    `Gate: ${r.gate.attempts} paid attempt(s) disclosed, cost ${r.gate.cost_usd} (${r.gate.cost_uusdc} μUSDC, Sepolia testnet). Paid request round-trip ms: min ${r.gate.paid_request_latency_ms.min ?? "-"}, mean ${r.gate.paid_request_latency_ms.mean ?? "-"}, max ${r.gate.paid_request_latency_ms.max ?? "-"} (verification and grading excluded).`,
    ``,
    `| Case | Expected | Gate | Frontier |`,
    `| --- | --- | --- | --- |`,
    ...rows,
    ``,
    `## Limits`,
    ...r.limits.map((l) => `- ${l}`),
    ``,
  ].join("\n");
}
