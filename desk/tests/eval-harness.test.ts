// The cost-per-verified-verdict harness (mission #198): exact verdict
// classification against the disclosed key bands, unknown never counted as
// incorrect, skipped-budget never counted as a run, exact cost math, request
// binding to the on-chain signal params, honest recording of failed payments
// and failed verifications, and case-file validation that fails red on mutants.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { costPerCorrect, evalSetDefect, loadEvalSet, runEvalHarness, RATINGS, type EvalCase, type EvalSet } from "../src/evalHarness";
import type { SpendLedger } from "../src/gate";
import { paramsEqual, type verifyPurchase } from "../src/verify";

const live402 = readFileSync(join(__dirname, "fixtures", "challenge-774921.json"), "utf8");
const acct = privateKeyToAccount(generatePrivateKey());
const makePayer = () => ({ address: acct.address, signMessage: vi.fn((message: string) => acct.signMessage({ message })) });
const from = acct.address.toLowerCase();

const SET: EvalSet = {
  version: 1,
  label: "test eval set",
  cases: [
    { id: "c-pass", task: "2+2? Number only.", output: "4", key: "pass", rationale: "right" },
    { id: "c-fail", task: "3+3? Number only.", output: "7", key: "fail", rationale: "wrong" },
    { id: "c-unknown", task: "Unanswerable future price?", output: "Cannot be determined.", key: "pass", rationale: "honest unknown" },
  ],
};
const hash = (miner: string, caseId: string) => "0x" + createHash("sha256").update(`${miner}:${caseId}`).digest("hex");

// plan[miner][caseId] = rating to serve (null = omit the rating field).
// Cases are matched on the (task, output) pair: the shipped set reuses one
// task with different candidate outputs on purpose.
function node(plan: Record<string, Record<string, string | null>>, opts: { failPaidFor?: string; cases?: EvalCase[]; omitSignalHash?: boolean } = {}) {
  const cases = opts.cases ?? SET.cases;
  const sent = new Map<string, Record<string, string>>();
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/v1/ledger/account/")) return new Response(JSON.stringify({ available: "1000000", balance: "1", deposited: "1", unbilled: "0", charged: "0" }));
    const miner = /\/v1\/ask\/([^/?]+)/.exec(url)?.[1] ?? "?";
    const h = new Headers(init?.headers);
    if (!h.get("X-PAYMENT")) return new Response(live402.replaceAll("/v1/ask/774921", `/v1/ask/${miner}`), { status: 402 });
    if (opts.failPaidFor === miner) return new Response("upstream down", { status: 503 });
    const params = JSON.parse(String(init?.body ?? "{}"))?.params ?? {};
    const c = cases.find((x) => x.task === params.task && x.output === params.output)!;
    const rating = plan[miner]?.[c.id];
    const receipt = Buffer.from(JSON.stringify({
      receipt_hash: "0x" + "ab".repeat(32), rail: "escrow", payer: from, miner, intent: "LLM_OUTPUT_EVALUATION_GENERAL",
      amount_uusdc: "10000", epoch_id: 31, settlement: "epoch", chain: "telegraph", timestamp: Math.floor(Date.now() / 1000),
    })).toString("base64");
    const result: Record<string, unknown> = rating === null || rating === undefined ? {} : { rating };
    const sh = hash(miner, c.id);
    sent.set(sh, { task: params.task, output: params.output });
    const body: Record<string, unknown> = { miner_id: miner, result, field_status: {} };
    if (!opts.omitSignalHash) body.signal_hash = sh;
    return new Response(JSON.stringify(body), { status: 200, headers: { "x-payment-response": receipt } });
  });
  return { f: f as unknown as typeof fetch, sent };
}

function verifyStub(
  plan: Record<string, Record<string, string | null>>,
  sent: Map<string, Record<string, string>>,
  opts: { failVerify?: boolean; bareValue?: boolean; wrongTask?: boolean } = {},
) {
  return vi.fn(async (input: { signalHash: string }) => {
    const found = Object.entries(plan).flatMap(([m, cases]) => Object.keys(cases).map((c) => [m, c] as const)).find(([m, c]) => hash(m, c) === input.signalHash);
    const rating = found ? plan[found[0]][found[1]] : null;
    const params = sent.get(input.signalHash) ?? null;
    return {
      verified: !opts.failVerify,
      checks: [{ name: "stub", ok: !opts.failVerify, detail: opts.failVerify ? "raw bytes differ" : "injected verifier" }],
      minerReceipt: null, rawSha256: null, rawBytes: null, payloadValue: rating,
      intentId: "LLM_OUTPUT_EVALUATION_GENERAL", request: null,
      requestParams: params ? (opts.wrongTask ? { ...params, task: "0+0? Number only." } : params) : null,
      signalTimestamp: "2026-11-25T08:00:00Z",
      fields: rating === null || rating === undefined ? {} : opts.bareValue ? { rating } : { rating: { value: rating } },
      payloadResponse: null,
    };
  }) as unknown as typeof verifyPurchase;
}

const dirs: string[] = [];
function workspace() {
  const d = mkdtempSync(join(tmpdir(), "evalh-"));
  dirs.push(d);
  const spend: SpendLedger = {
    reservationsFile: join(d, "reservations.jsonl"),
    lockFile: join(d, "spend.lock"),
    readSettlementSnapshot: () => ({ settledTodayUusdc: 0n, settledNonces: new Set<string>() }),
    settledTodayUusdc: () => 0n,
    settledNonces: () => new Set<string>(),
  };
  return { dir: d, outDir: join(d, "out"), spend };
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const NOW = new Date("2026-11-25T08:00:00Z");
const correctPlan = { "111": { "c-pass": "Excellent", "c-fail": "Fails", "c-unknown": "Good" } };

describe("costPerCorrect exact math", () => {
  it("divides exactly with 2dp truncation and never floats", () => {
    expect(costPerCorrect(30000n, 2)).toBe("15000.00");
    expect(costPerCorrect(10000n, 3)).toBe("3333.33");
    expect(costPerCorrect(10001n, 2)).toBe("5000.50");
    expect(costPerCorrect(10000n, 6)).toBe("1666.66");
    expect(costPerCorrect(10000n, 0)).toBeNull();
  });
});

describe("evalSetDefect", () => {
  it("accepts the shipped mission case set", () => {
    const shipped = loadEvalSet(join(__dirname, "..", "eval", "cases.json"));
    expect(evalSetDefect(shipped)).toBeNull();
    expect(shipped.cases.length).toBeGreaterThanOrEqual(6);
    expect(shipped.label).toMatch(/testnet/);
  });
  it.each([
    [{ ...SET, cases: [] }, /non-empty/],
    [{ ...SET, cases: [{ id: "x", task: "t", output: "o", key: "maybe", rationale: "r" }] }, /key must be/],
    [{ ...SET, cases: [SET.cases[0], SET.cases[0]] }, /unique/],
    [{ ...SET, cases: [{ id: "x", task: "t", output: "o", key: "pass", rationale: "" }] }, /rationale/],
    [{ ...SET, cases: [{ id: "x", task: "", output: "o", key: "pass", rationale: "r" }] }, /task/],
  ])("rejects a mutated set", (set, re) => {
    expect(evalSetDefect(set)).toMatch(re);
  });
});

describe("runEvalHarness", () => {
  it("classifies verdicts exactly and reports per-provider cost per verified correct verdict", async () => {
    const w = workspace();
    const plan = {
      "111": { "c-pass": "Excellent", "c-fail": "Fails", "c-unknown": "Good" },
      "222": { "c-pass": "Poor", "c-fail": "Good", "c-unknown": null },
    };
    const n = node(plan);
    const report = await runEvalHarness(makePayer(), SET, ["111", "222"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(plan, n.sent), now: () => NOW });
    const p1 = report.providers[0];
    expect(p1).toMatchObject({ provider: "111", cases_run: 3, correct: 3, incorrect: 0, unusable: 0, skipped_budget: 0, spend_uusdc: "30000", reserved_uusdc: "30000", cost_per_correct_uusdc: "10000.00" });
    const p2 = report.providers[1];
    // c-pass rated Poor vs key pass -> incorrect; c-fail rated Good vs key fail -> incorrect; c-unknown rating omitted -> unusable (unknown, NOT incorrect)
    expect(p2).toMatchObject({ provider: "222", cases_run: 3, correct: 0, incorrect: 2, unusable: 1, skipped_budget: 0, spend_uusdc: "30000", reserved_uusdc: "30000", cost_per_correct_uusdc: null });
    expect(report.totals).toEqual({ spend_uusdc: "60000", reserved_uusdc: "60000", correct: 3, cases_run: 6, skipped_budget: 0 });
    expect(report.testnet).toBe(true);
    expect(report.disclosure.join("\n")).toMatch(/no statistical significance/);
    const v = report.verdicts.find((x) => x.provider === "222" && x.case_id === "c-unknown")!;
    expect(v.status).toBe("unusable");
    expect(v.reason).toMatch(/no rating field/);
    expect(JSON.parse(readFileSync(join(w.outDir, "eval-report.json"), "utf8")).totals.spend_uusdc).toBe("60000");
  });
  it.each(RATINGS)("band edge: rating %s classifies exactly against both keys", async (rating) => {
    const w = workspace();
    const plan = { "111": { "c-pass": rating, "c-fail": rating, "c-unknown": rating } };
    const n = node(plan);
    const report = await runEvalHarness(makePayer(), SET, ["111"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(plan, n.sent), now: () => NOW });
    const passCase = report.verdicts.find((x) => x.case_id === "c-pass")!;
    const failCase = report.verdicts.find((x) => x.case_id === "c-fail")!;
    expect(passCase.status).toBe(["Excellent", "Good", "Acceptable"].includes(rating) ? "correct" : "incorrect");
    expect(failCase.status).toBe(["Poor", "Fails"].includes(rating) ? "correct" : "incorrect");
  });
  it("rejects a non-enum rating as unusable, never as incorrect", async () => {
    const w = workspace();
    const plan = { "111": { "c-pass": "Superb", "c-fail": "Fails", "c-unknown": "Good" } };
    const n = node(plan);
    const report = await runEvalHarness(makePayer(), SET, ["111"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(plan, n.sent), now: () => NOW });
    expect(report.providers[0]).toMatchObject({ correct: 2, incorrect: 0, unusable: 1 });
    expect(report.verdicts.find((x) => x.case_id === "c-pass")!.reason).toMatch(/outside the published enum/);
  });
  it("rejects a wrong-case rating ('excellent') as unusable", async () => {
    const w = workspace();
    const plan = { "111": { "c-pass": "excellent", "c-fail": "Fails", "c-unknown": "Good" } };
    const n = node(plan);
    const report = await runEvalHarness(makePayer(), SET, ["111"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(plan, n.sent), now: () => NOW });
    expect(report.verdicts.find((x) => x.case_id === "c-pass")!.status).toBe("unusable");
    expect(report.providers[0]).toMatchObject({ correct: 2, incorrect: 0, unusable: 1 });
  });
  it("accepts a bare-value rating field as well as a {value} wrapper", async () => {
    const w = workspace();
    const n = node(correctPlan);
    const report = await runEvalHarness(makePayer(), SET, ["111"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(correctPlan, n.sent, { bareValue: true }), now: () => NOW });
    expect(report.providers[0]).toMatchObject({ correct: 3, incorrect: 0, unusable: 0 });
  });
  it("fails verification when the paid reply carries no signal_hash", async () => {
    const w = workspace();
    const n = node(correctPlan, { omitSignalHash: true });
    const report = await runEvalHarness(makePayer(), SET, ["111"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(correctPlan, n.sent), now: () => NOW });
    expect(report.providers[0]).toMatchObject({ correct: 0, failed_verification: 3, spend_uusdc: "30000" });
    expect(report.verdicts[0].reason).toMatch(/no signal_hash/);
  });
  it("fails verification when the verified answer belongs to a different request", async () => {
    const w = workspace();
    const n = node(correctPlan);
    const report = await runEvalHarness(makePayer(), SET, ["111"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(correctPlan, n.sent, { wrongTask: true }), now: () => NOW });
    expect(report.providers[0]).toMatchObject({ correct: 0, incorrect: 0, failed_verification: 3, spend_uusdc: "30000" });
    expect(report.verdicts[0].reason).toMatch(/different request/);
  });
  it("records a failed payment honestly; the reservation stands but no receipt does", async () => {
    const w = workspace();
    const plan = { "111": { "c-pass": "Excellent", "c-fail": "Fails", "c-unknown": "Good" }, "222": { "c-pass": "Good", "c-fail": "Poor", "c-unknown": "Good" } };
    const n = node(plan, { failPaidFor: "222" });
    const report = await runEvalHarness(makePayer(), SET, ["111", "222"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(plan, n.sent), now: () => NOW });
    expect(report.providers[1]).toMatchObject({ provider: "222", failed_payment: 3, spend_uusdc: "0", reserved_uusdc: "30000", cost_per_correct_uusdc: null });
    expect(report.totals.spend_uusdc).toBe("30000");
    expect(report.totals.reserved_uusdc).toBe("60000");
  });
  it("records a failed verification with the charge standing", async () => {
    const w = workspace();
    const n = node(correctPlan);
    const report = await runEvalHarness(makePayer(), SET, ["111"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(correctPlan, n.sent, { failVerify: true }), now: () => NOW });
    expect(report.providers[0]).toMatchObject({ correct: 0, failed_verification: 3, spend_uusdc: "30000" });
    expect(report.verdicts[0].receipts).toHaveLength(1);
  });
  it("skips with 'not run' when the shared daily cap is already exhausted and signs nothing", async () => {
    const w = workspace();
    writeFileSync(w.spend.reservationsFile, JSON.stringify({ kind: "gate", nonce: "g", amount_uusdc: "100000", reserved_at: NOW.toISOString() }) + "\n");
    const payer = makePayer();
    const n = node(correctPlan);
    const report = await runEvalHarness(payer, SET, ["111"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(correctPlan, n.sent), now: () => NOW });
    expect(report.providers[0]).toMatchObject({ cases_run: 0, skipped_budget: 3, spend_uusdc: "0", reserved_uusdc: "0" });
    expect(report.verdicts[0].status).toBe("skipped-budget");
    expect(report.verdicts[0].reason).toMatch(/not run: remaining shared daily cap 0/);
    expect(report.totals).toMatchObject({ cases_run: 0, skipped_budget: 3 });
    expect(payer.signMessage).not.toHaveBeenCalled();
    expect(n.f).not.toHaveBeenCalled();
  });
  it("mid-run cap: completes provider 1, skips provider 2, signs nothing for provider 2", async () => {
    const w = workspace();
    const payer = makePayer();
    const plan = { "111": { "c-pass": "Excellent", "c-fail": "Fails", "c-unknown": "Good" }, "222": { "c-pass": "Good", "c-fail": "Poor", "c-unknown": "Good" } };
    const n = node(plan);
    const report = await runEvalHarness(payer, SET, ["111", "222"], { spend: w.spend, outDir: w.outDir, dailyCapUusdc: 35000n, f: n.f, verify: verifyStub(plan, n.sent), now: () => NOW });
    expect(report.providers[0]).toMatchObject({ provider: "111", cases_run: 3, correct: 3, spend_uusdc: "30000" });
    expect(report.providers[1]).toMatchObject({ provider: "222", cases_run: 0, skipped_budget: 3, spend_uusdc: "0", reserved_uusdc: "0" });
    expect(report.verdicts.filter((x) => x.provider === "222").every((x) => x.status === "skipped-budget")).toBe(true);
    expect(payer.signMessage).toHaveBeenCalledTimes(3);
  });
  it("rejects duplicate provider ids before any spend", async () => {
    const w = workspace();
    await expect(runEvalHarness(makePayer(), SET, ["111", "111"], { spend: w.spend, outDir: w.outDir, f: node(correctPlan).f, verify: verifyStub(correctPlan, new Map()), now: () => NOW })).rejects.toThrow(/duplicate provider ids/);
  });
  it("runs the shipped cases.json end to end, matching cases on the (task, output) pair", async () => {
    const w = workspace();
    const shipped = loadEvalSet(join(__dirname, "..", "eval", "cases.json"));
    const casesPlan = Object.fromEntries(shipped.cases.map((c) => [c.id, c.key === "pass" ? "Good" : "Poor"]));
    const plan = { "111": casesPlan };
    const n = node(plan, { cases: shipped.cases });
    const report = await runEvalHarness(makePayer(), shipped, ["111"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(plan, n.sent), now: () => NOW });
    expect(report.providers[0]).toMatchObject({ cases_run: 6, correct: 6, incorrect: 0, unusable: 0, spend_uusdc: "60000", cost_per_correct_uusdc: "10000.00" });
    // Duplicate tasks with different outputs must resolve to their own case.
    expect(new Set(report.verdicts.map((x) => x.case_id)).size).toBe(6);
  });
  it("writes the report and verdict files into the output directory", async () => {
    const w = workspace();
    const n = node(correctPlan);
    await runEvalHarness(makePayer(), SET, ["111"], { spend: w.spend, outDir: w.outDir, f: n.f, verify: verifyStub(correctPlan, n.sent), now: () => NOW });
    expect(existsSync(join(w.outDir, "eval-report.json"))).toBe(true);
    expect(readFileSync(join(w.outDir, "eval-verdicts.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  });
});

describe("eval daily cap valve", () => {
  it("honours dailyCapUusdc mid-run: two calls under cap 20,000, the third skipped-budget", async () => {
    const w = workspace();
    const payer = makePayer();
    const n = node(correctPlan);
    const report = await runEvalHarness(payer, SET, ["111"], { spend: w.spend, outDir: w.outDir, dailyCapUusdc: 20000n, f: n.f, verify: verifyStub(correctPlan, n.sent), now: () => NOW });
    expect(report.providers[0]).toMatchObject({ cases_run: 2, correct: 2, skipped_budget: 1, spend_uusdc: "20000", reserved_uusdc: "20000" });
    expect(payer.signMessage).toHaveBeenCalledTimes(2);
    expect(report.verdicts[2].status).toBe("skipped-budget");
    expect(report.verdicts[2].reason).toMatch(/not run: remaining shared daily cap 0/);
  });
});

describe("paramsEqual request binding", () => {
  it("compares key-order independently and rejects extra, missing, or different keys", () => {
    expect(paramsEqual({ task: "t", output: "o" }, { output: "o", task: "t" })).toBe(true);
    expect(paramsEqual({ task: "t", output: "o" }, { task: "t", output: "o", extra: "x" })).toBe(false);
    expect(paramsEqual({ task: "t", output: "o", extra: "x" }, { task: "t", output: "o" })).toBe(false);
    expect(paramsEqual({ task: "t", output: "o" }, { task: "t", output: "p" })).toBe(false);
    expect(paramsEqual({ task: "t", output: "o" }, null)).toBe(false);
    // Non-string values compare by strict identity, never deep-equal.
    expect(paramsEqual({ a: { x: 1 } } as unknown as Record<string, string>, { a: { x: 1 } } as unknown as Record<string, string>)).toBe(false);
  });
});

describe("run-eval-harness CLI", () => {
  const desk = resolve(__dirname, "..");
  const cli = join(desk, "scripts", "run-eval-harness.ts");
  const shippedCases = join(desk, "eval", "cases.json");
  function runCli(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: desk, encoding: "utf8", env: { ...process.env, ...env } });
  }
  const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;
  it("refuses missing args, a non-numeric provider id, and duplicate provider ids", () => {
    const d = mkdtempSync(join(tmpdir(), "evalcli-"));
    dirs.push(d);
    const noArgs = runCli([]);
    expect(noArgs.status).not.toBe(0);
    expect(out(noArgs)).toMatch(/Usage/);
    const numeric = runCli([shippedCases, join(d, "o1"), "abc"]);
    expect(numeric.status).not.toBe(0);
    expect(out(numeric)).toMatch(/must be numeric/);
    const dup = runCli([shippedCases, join(d, "o2"), "111", "111"]);
    expect(dup.status).not.toBe(0);
    expect(out(dup)).toMatch(/duplicate provider ids/);
  });
  it("refuses a non-canonical (relative) output path", () => {
    const r = runCli([shippedCases, "relative-out", "111"]);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/absolute canonical/);
  });
  it("default shared cap allows at most 10 calls: two providers of the 6-case set exceed it even with an empty ledger", () => {
    const d = mkdtempSync(join(tmpdir(), "evalcli-"));
    dirs.push(d);
    const r = runCli([shippedCases, join(d, "new-out"), "111", "222"], { DESK_LEDGER_DIR: join(d, "ledger"), DESK_SECRETS_FILE: "/intentionally-not-present", DESK_PAYER_ADDRESS: "0x0000000000000000000000000000000000000000" });
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/needs 120000 μUSDC \(2 providers x 6 cases x 10000 μUSDC per call\) but the remaining shared daily cap is 100000 μUSDC/);
    expect(existsSync(join(d, "new-out"))).toBe(false);
  });
  it("refuses before any spend when providers x cases x unit price exceeds the remaining cap, and prints the numbers", () => {
    const d = mkdtempSync(join(tmpdir(), "evalcli-"));
    dirs.push(d);
    const ledger = join(d, "ledger");
    mkdirSync(ledger, { mode: 0o700 });
    writeFileSync(join(ledger, "reservations.jsonl"), JSON.stringify({ kind: "gate", nonce: "g", amount_uusdc: "100000", reserved_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    const r = runCli([shippedCases, join(d, "new-out"), "111"], { DESK_LEDGER_DIR: ledger, DESK_SECRETS_FILE: "/intentionally-not-present", DESK_PAYER_ADDRESS: "0x0000000000000000000000000000000000000000" });
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/needs 60000 μUSDC \(1 providers x 6 cases x 10000 μUSDC per call\) but the remaining shared daily cap is 0 μUSDC/);
    expect(existsSync(join(d, "new-out"))).toBe(false);
  });
  it.each(["abc", "", "-1", "1.5"])("rejects an invalid DESK_EVAL_CAP_UUSDC value %p before any spend", (v) => {
    const d = mkdtempSync(join(tmpdir(), "evalcli-"));
    dirs.push(d);
    const r = runCli([shippedCases, join(d, "new-out"), "111"], { DESK_LEDGER_DIR: join(d, "ledger"), DESK_EVAL_CAP_UUSDC: v });
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/DESK_EVAL_CAP_UUSDC must be digits/);
    expect(existsSync(join(d, "new-out"))).toBe(false);
  });
  it("clamps a huge DESK_EVAL_CAP_UUSDC to the desk-wide 2,000,000 cap", () => {
    const d = mkdtempSync(join(tmpdir(), "evalcli-"));
    dirs.push(d);
    const ledger = join(d, "ledger");
    mkdirSync(ledger, { mode: 0o700 });
    writeFileSync(join(ledger, "reservations.jsonl"), JSON.stringify({ kind: "gate", nonce: "g", amount_uusdc: "1980000", reserved_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    const r = runCli([shippedCases, join(d, "new-out"), "111"], { DESK_LEDGER_DIR: ledger, DESK_EVAL_CAP_UUSDC: "9999999999" });
    expect(r.status).not.toBe(0);
    // Unclamped, remaining would be billions; clamped to 2,000,000 it is 20,000.
    expect(out(r)).toMatch(/remaining shared daily cap is 20000 μUSDC/);
  });
  it("a raised cap lets 2 providers x 6 cases pass pre-flight and stops at the missing-secrets error", () => {
    const d = mkdtempSync(join(tmpdir(), "evalcli-"));
    dirs.push(d);
    const r = runCli([shippedCases, join(d, "new-out"), "111", "222"], { DESK_LEDGER_DIR: join(d, "ledger"), DESK_EVAL_CAP_UUSDC: "1000000", DESK_SECRETS_FILE: "" });
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/DESK_SECRETS_FILE is required/);
    expect(out(r)).not.toMatch(/refusing before any spend/);
  });
  it("a zero cap refuses every call", () => {
    const d = mkdtempSync(join(tmpdir(), "evalcli-"));
    dirs.push(d);
    const r = runCli([shippedCases, join(d, "new-out"), "111"], { DESK_LEDGER_DIR: join(d, "ledger"), DESK_EVAL_CAP_UUSDC: "0" });
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/remaining shared daily cap is 0 μUSDC/);
    expect(existsSync(join(d, "new-out"))).toBe(false);
  });
});
