import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCommittedCases, assertSnapshotsCover, buildReport, COMMITTED_CASES_SHA256, exportQuestionPacket, gradeValue,
  loadCaseSet, loadSnapshotSet, probeValues, renderMarkdown, scoreValues, validateCaseSet, validateFrontierAnswers, validateSnapshotSet,
} from "../src/benchmark";
import { probeInputHash, type ProbeRun } from "../src/gate";

const casesFile = join(__dirname, "..", "benchmark", "cases.v1.json");
const snapshotsFile = join(__dirname, "..", "benchmark", "snapshots.v1.json");
const { caseSet, hash } = loadCaseSet(casesFile);
const snapshots = loadSnapshotSet(snapshotsFile);

function probe(over: Partial<ProbeRun>): ProbeRun {
  const c = caseSet.cases.find((c) => c.id === over.case_id) ?? caseSet.cases[0];
  return {
    version: 1, kind: "benchmark-probe", case_id: "x", cases_version: "frontier-benchmark-v1", cases_hash: hash,
    evaluated_at: new Date().toISOString(), question: c.question, intent: c.intent, params: c.params, value_field: c.value_field, case_input_hash: probeInputHash({ id: c.id, intent: c.intent, params: c.params, valueField: c.value_field, question: c.question }), payer: "0x" + "11".repeat(20),
    purchase: { routed: "auto", quoted_uusdc: "10000", paid_uusdc: "10000", worst_case_uusdc: null, receipt_hash: null, epoch_id: 1, serving_miner: "6160", serving_miner_slug: "verireceipt", duration_ms: 1000, nonce: "n" },
    signal_hash: null, value: null, delivery_status: "included", node_checks: [], miner_chain: "passed", miner_checks: [],
    outcome: "ANSWERED", reasons: [], limits: [], record_appended: true, ...over,
  } as ProbeRun;
}

describe("committed frozen case set", () => {
  it("loads eight cases with unique ids, each with a cited reference bound to a snapshot", () => {
    expect(caseSet.cases).toHaveLength(8);
    expect(new Set(caseSet.cases.map((c) => c.id)).size).toBe(8);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    for (const c of caseSet.cases) {
      expect(c.reference.source.length).toBeGreaterThan(0);
      expect(c.question.length).toBeGreaterThan(20);
      expect(c.reference.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
  it("is pinned by the committed anchor (DESK_BENCHMARK_CASES cannot swap gold)", () => {
    expect(hash).toBe(COMMITTED_CASES_SHA256);
    expect(() => assertCommittedCases("0".repeat(64))).toThrow(/does not match the committed benchmark cases/);
  });
  it("has a stable hash for unchanged bytes", () => {
    expect(loadCaseSet(casesFile).hash).toBe(hash);
  });
  it("rejects duplicate ids, unknown graders, missing references and missing snapshot bindings", () => {
    const good = JSON.parse(readFileSync(casesFile, "utf8"));
    expect(() => validateCaseSet({ ...good, cases: [...good.cases, good.cases[0]] })).toThrow(/duplicate/);
    const bad = JSON.parse(JSON.stringify(good));
    bad.cases[0].grader = { type: "fuzzy" };
    expect(() => validateCaseSet(bad)).toThrow(/unknown grader/);
    const noref = JSON.parse(JSON.stringify(good));
    delete noref.cases[0].reference;
    expect(() => validateCaseSet(noref)).toThrow(/reference/);
    const nosnap = JSON.parse(JSON.stringify(good));
    delete nosnap.cases[0].reference.snapshot_sha256;
    expect(() => validateCaseSet(nosnap)).toThrow(/snapshot_sha256/);
  });
  it("every reference's hex-to-decimal conversion agrees with the grader (raw-reference conversion check)", () => {
    for (const c of caseSet.cases) {
      const m = /(0x[0-9a-f]+) = (\d+)/.exec(c.reference.detail);
      if (!m) continue;
      expect(parseInt(m[1], 16)).toBe(Number(m[2]));
      if (c.grader.type === "exact_number") expect(Number(m[2])).toBe(c.grader.expected);
    }
    // The two tx cases must carry such a conversion in their reference detail.
    const tx = caseSet.cases.filter((c) => c.intent === "ONCHAIN_TX_LOOKUP_GENERAL");
    expect(tx).toHaveLength(2);
    for (const c of tx) expect(c.reference.detail).toMatch(/0x[0-9a-f]+ = \d+/);
  });
});

describe("versioned primary snapshots", () => {
  it("cover every case exactly once with matching hashes and a revision policy", () => {
    expect(snapshots.revision_policy.length).toBeGreaterThan(20);
    expect(() => assertSnapshotsCover(caseSet, snapshots)).not.toThrow();
  });
  it("reject tampered evidence and unknown or uncovered cases", () => {
    const tampered = JSON.parse(JSON.stringify(snapshots));
    tampered.snapshots[0].evidence += " ";
    expect(() => validateSnapshotSet(tampered)).toThrow(/sha256 does not match/);
    const unknown = JSON.parse(JSON.stringify(snapshots));
    unknown.snapshots[0].case_id = "nope";
    unknown.snapshots[0].sha256 = unknown.snapshots[1].sha256;
    expect(() => assertSnapshotsCover(caseSet, validateSnapshotSet(unknown))).toThrow();
    const missing = { ...snapshots, snapshots: snapshots.snapshots.slice(1) };
    expect(() => assertSnapshotsCover(caseSet, missing)).toThrow(/no primary snapshot/);
  });
});

describe("gradeValue", () => {
  it("exact and tolerance grading", () => {
    expect(gradeValue({ type: "exact_number", expected: 12176453 }, 12176453)).toBe("correct");
    expect(gradeValue({ type: "exact_number", expected: 12176453 }, 12176454)).toBe("incorrect");
    expect(gradeValue({ type: "numeric_tolerance", expected: 100, tolerance_pct: 1 }, 100.5)).toBe("correct");
    expect(gradeValue({ type: "numeric_tolerance", expected: 100, tolerance_pct: 1 }, 102)).toBe("incorrect");
  });
  it("null, strings and NaN abstain, never count as wrong", () => {
    expect(gradeValue({ type: "exact_number", expected: 1 }, null)).toBe("abstain");
    expect(gradeValue({ type: "exact_number", expected: 1 }, "1")).toBe("abstain");
    expect(gradeValue({ type: "exact_number", expected: 1 }, NaN)).toBe("abstain");
  });
});

describe("scoreValues", () => {
  const c = caseSet.cases;
  it("counts correct/incorrect/abstain and false passes honestly", () => {
    const values = new Map<string, unknown>([[c[0].id, c[0].grader.expected], [c[1].id, 1], [c[2].id, null]]);
    const s = scoreValues(c.slice(0, 3), values);
    expect([s.correct, s.incorrect, s.abstain]).toEqual([1, 1, 1]);
    expect(s.false_passes).toBe(1);
    expect(s.accuracy).toBeCloseTo(1 / 3);
    expect(s.precision_when_answered).toBeCloseTo(1 / 2);
  });
});

describe("probeValues (strict)", () => {
  it("an ABSTAIN record abstains; an ANSWERED record uses its verified value", () => {
    const m = probeValues([probe({ case_id: caseSet.cases[0].id, outcome: "ANSWERED", value: 5 }), probe({ case_id: caseSet.cases[1].id, outcome: "ABSTAIN", value: 5 })], caseSet.cases, hash);
    expect(m.get(caseSet.cases[0].id)).toBe(5);
    expect(m.get(caseSet.cases[1].id)).toBeNull();
  });
  it.each([
    { intent: "TVL_LOOKUP_GENERAL" }, { params: { protocol: "aave-v3" } },
    { value_field: "tvl_usd" }, { question: "A different question" }, { case_input_hash: "0".repeat(64) },
  ])("rejects relabelled frozen input at scoring: %j", (mutation) => {
    const c = caseSet.cases[1];
    const r = probe({ case_id: c.id, value: c.grader.expected, ...mutation });
    expect(() => buildReport(caseSet, hash, [r], null)).toThrow(/probe input/);
  });
  it("rejects duplicates, unknown cases and records from another case set", () => {
    const a = probe({ case_id: caseSet.cases[0].id });
    expect(() => probeValues([a, a], caseSet.cases, hash)).toThrow(/duplicate/);
    expect(() => probeValues([probe({ case_id: "nope" })], caseSet.cases, hash)).toThrow(/unknown case/);
    expect(() => probeValues([probe({ case_id: caseSet.cases[0].id, cases_hash: "0".repeat(64) })], caseSet.cases, hash)).toThrow(/cases_hash/);
    expect(() => probeValues([probe({ case_id: caseSet.cases[0].id, kind: "gate" as never })], caseSet.cases, hash)).toThrow(/not a benchmark probe/);
  });
});

describe("validateFrontierAnswers", () => {
  const base = {
    version: "frontier-benchmark-v1", cases_hash: hash, model: "m", provider: "p",
    ran_at: "2026-11-23T00:00:00Z", web_search: true, provenance: "chat ref",
    answers: caseSet.cases.map((c) => ({ case_id: c.id, value: null })),
  };
  it("accepts a full null-answer file with provenance", () => {
    expect(validateFrontierAnswers(base, caseSet.cases, hash, caseSet.frozen_at).answers).toHaveLength(8);
  });
  it("rejects empty or incomplete frontier answers, including omitted abstains", () => {
    for (const answers of [[], base.answers.slice(1)]) {
      expect(() => validateFrontierAnswers({ ...base, answers }, caseSet.cases, hash, caseSet.frozen_at)).toThrow(/every case/);
    }
  });
  it("rejects a cases_hash binding to another case set", () => {
    expect(() => validateFrontierAnswers({ ...base, cases_hash: "0".repeat(64) }, caseSet.cases, hash, caseSet.frozen_at)).toThrow(/cases_hash/);
  });
  it("rejects answers produced before the freeze", () => {
    expect(() => validateFrontierAnswers({ ...base, ran_at: "2020-01-01T00:00:00Z" }, caseSet.cases, hash, caseSet.frozen_at)).toThrow(/precedes the case-set freeze/);
    expect(() => validateFrontierAnswers({ ...base, ran_at: "not a date" }, caseSet.cases, hash, caseSet.frozen_at)).toThrow(/timestamp/);
  });
  it("rejects unknown case ids, undeclared web_search and non-finite values", () => {
    expect(() => validateFrontierAnswers({ ...base, answers: [{ case_id: "nope", value: 1 }] }, caseSet.cases, hash, caseSet.frozen_at)).toThrow(/unknown/);
    expect(() => validateFrontierAnswers({ ...base, web_search: undefined }, caseSet.cases, hash, caseSet.frozen_at)).toThrow(/web_search/);
    const bad = JSON.parse(JSON.stringify(base));
    bad.answers[0].value = "3";
    expect(() => validateFrontierAnswers(bad, caseSet.cases, hash, caseSet.frozen_at)).toThrow(/finite number or null/);
    const dup = JSON.parse(JSON.stringify(base));
    dup.answers.push(dup.answers[0]);
    expect(() => validateFrontierAnswers(dup, caseSet.cases, hash, caseSet.frozen_at)).toThrow(/duplicate/);
  });
});

describe("exportQuestionPacket", () => {
  it("contains questions only, never expected values or snapshot evidence, with a presentation protocol", () => {
    const p = exportQuestionPacket(caseSet, hash);
    expect(p.cases_hash).toBe(hash);
    expect(p.questions).toHaveLength(8);
    expect(p.protocol.length).toBeGreaterThan(2);
    const text = JSON.stringify(p);
    for (const c of caseSet.cases) {
      const expected = c.grader.type === "exact_number" ? c.grader.expected : c.grader.expected;
      expect(text).not.toContain(`"expected":${JSON.stringify(expected)}`);
    }
    expect(text).not.toContain('"expected"');
    expect(text).not.toContain("snapshot_sha256");
    for (const c of caseSet.cases) expect(text).not.toContain(c.reference.snapshot_sha256);
  });
});

describe("buildReport + renderMarkdown", () => {
  it("does not count no-purchase preflight abstentions as paid attempts", () => {
    const c = caseSet.cases[0];
    const r = probe({ case_id:c.id, outcome:"ABSTAIN", value:null, purchase:{ routed:"auto", quoted_uusdc:"0", paid_uusdc:null, worst_case_uusdc:null, receipt_hash:null, epoch_id:null, serving_miner:null, serving_miner_slug:null, duration_ms:null, nonce:null } });
    const report = buildReport(caseSet,hash,[r],null);
    expect(report.gate.evaluations).toBe(1);
    expect(report.gate.attempts).toBe(0);
    expect(report.gate.cost_uusdc).toBe("0");
  });

  it("sums cost across paid and worst-case runs, discloses attempts, labels latency, renders the comparison", () => {
    const runs = caseSet.cases.map((c, i) => probe({
      case_id: c.id, value: c.grader.expected, outcome: "ANSWERED",
      purchase: { routed: "auto", quoted_uusdc: "10000", paid_uusdc: i === 7 ? null : "10000", worst_case_uusdc: i === 7 ? "10000" : null, receipt_hash: null, epoch_id: 1, serving_miner: "6160", serving_miner_slug: "verireceipt", duration_ms: 1000 + i, nonce: "n" },
    }));
    const frontier = {
      version: "frontier-benchmark-v1" as const, cases_hash: hash, model: "frontier-x", provider: "p",
      ran_at: "2026-11-23T00:00:00Z", web_search: true, provenance: "chat ref",
      answers: caseSet.cases.map((c) => ({ case_id: c.id, value: (c.grader.expected as number) + 1 })),
    };
    const report = buildReport(caseSet, hash, runs, frontier, new Date("2026-11-25T00:00:00Z"));
    expect(report.gate.correct).toBe(8);
    expect(report.gate.attempts).toBe(8);
    expect(report.gate.cost_uusdc).toBe("80000");
    expect(report.gate.cost_usd).toBe("$0.08");
    expect(report.gate.paid_request_latency_ms.min).toBe(1000);
    expect(report.frontier!.incorrect).toBe(8);
    const md = renderMarkdown(report, caseSet.cases);
    expect(md).toContain("Frontier benchmark");
    expect(md).toContain("| VeriReceipt Gate | 8 (100.0%)");
    expect(md).toContain("frontier-x (web search: on) | 0 (0.0%)");
    expect(md).toContain("8 paid/uncertain-cost attempt(s) disclosed");
    expect(md).toContain("Paid request round-trip ms");
    expect(md).toContain("ABSTAIN counts against accuracy");
  });
});
