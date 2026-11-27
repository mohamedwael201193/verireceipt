import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/sanctions-legal-form-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => resetSanctionsCacheForTests({ sdn: 1, un: 1 })); // fixtures are real-format excerpts
afterEach(() => { vi.unstubAllGlobals(); resetSanctionsCacheForTests(); });
import { handleSanctionsScreen, matchScore, resetSanctionsCacheForTests } from "../src/handlers/sanctionsScreening";
import { getReceiptEvidence } from "../src/core/storage";
// Real rows from the OFAC SDN list and its alias file, retrieved
// 2026-11-27 (SHA-256 89b2a6d6d825d3a0a5033c9d523ef8a5e05a0b766ccff1ad934aea7436da49b9
// for SDN.CSV and 2e342dc26cd1df3e11efba14d54d61d9290e255b502667b5eb2244e203b3ff5a
// for ALT.CSV) — the exact list bytes recorded in graded receipt
// rcpt_2ZJWV2G5XZDSTWD2YZK98VEJIF, where the query "MTS BANK" answered
// matched=false with best score 0.8 against the SDN alias "PJSC MTS BANK":
// the Dice score on {mts, bank} vs {pjsc, mts, bank} is 0.8, under the
// 0.85 threshold, on the legal-form token alone.
//
// The rule is deliberately narrow (reviewer measurement on the real SDN+ALT
// lists, 39,528 names): scoring any stripped PAIR would have put 1,908
// different-core pairs newly at or above 0.85 (e.g. "AL RAWDA EXCHANGE AND
// MONEY TRANSFERS" vs "AL-FADEL EXCHANGE AND MONEY TRANSFER COMPANY",
// 0.727 -> 0.865). Only an exactly equal stripped core scores 1; every
// other pair keeps its raw score. Measured on the same lists under this
// rule: 1,195 same-core pairs newly score 1 (the intended true matches,
// e.g. "TAJCO" vs "TAJCO COMPANY LLC") and zero different-core pairs
// move to or above 0.85.
const sdnMts = readFileSync(join(__dirname, "fixtures/sanctions/sdn-mts-excerpt.csv"), "utf8");
const altMts = readFileSync(join(__dirname, "fixtures/sanctions/alt-mts-excerpt.csv"), "utf8");
const un = readFileSync(join(__dirname, "fixtures/sanctions/un-excerpt.xml"), "utf8");
function stubMts(): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    const body = u.includes("SDN.CSV") ? sdnMts : u.includes("ALT.CSV") ? altMts : un;
    return new Response(body, { status: 200 });
  });
}
describe("sanctions legal-form token stripping", () => {
  it("the graded receipt pair: MTS BANK scores 1.0 against the PJSC alias and the primary", () => {
    expect(matchScore("MTS BANK", "PJSC MTS BANK")).toBe(1);
    expect(matchScore("MTS BANK", "PUBLIC JOINT STOCK COMPANY MTS BANK")).toBe(1);
    // Other legal forms from the token list fold the same way (real SDN alias spellings).
    expect(matchScore("VTB BANK", "VTB BANK PAO")).toBe(1);
    expect(matchScore("MUSTERMANN GMBH", "MUSTERMANN")).toBe(1);
    // The same fold through LTD: dropping "ltd" from the token list must
    // turn this RED (raw Dice on {mts, bank} vs {mts, bank, ltd} is 0.8).
    expect(matchScore("MTS BANK", "MTS BANK LTD")).toBe(1);
    // The core comparison is a token SET: word order inside the core does not matter.
    expect(matchScore("BANK MTS", "MTS BANK PJSC")).toBe(1);
  });
  it("a stripped core that is not exactly equal scores the raw comparison, never more", () => {
    // Raw Levenshtein 6/7 = 0.857143; the stripped cores ("cobank" vs
    // "bank") differ, so the raw score stands and is not lifted to 1.
    expect(matchScore("CoBank", "CO BANK")).toBe(0.857143);
    // "open" is not a legal form: the cores {open, mts, bank} and
    // {mts, bank} differ, so the fka alias stays a raw-scored near match.
    expect(matchScore("MTS BANK", "OPEN JOINT STOCK COMPANY MTS BANK")).toBe(0.5);
    // The reviewer's two measured false positives keep their raw scores.
    expect(matchScore("AL RAWDA EXCHANGE AND MONEY TRANSFERS", "AL-FADEL EXCHANGE AND MONEY TRANSFER COMPANY")).toBe(0.727273);
    expect(matchScore("A A TRADING FZCO", "A WEE TRADING CO LTD")).toBe(0.666667);
  });
  it("guard: 'bank of x' vs 'bank of y' does not newly match, with or without legal forms", () => {
    expect(matchScore("BANK OF AMERICA", "BANK OF CHINA")).toBe(0.666667);
    expect(matchScore("BANK OF AMERICA CORP", "BANK OF CHINA LTD")).toBe(0.55);
  });
  it("guard: a legal-form-only query stays unmatched and never collapses to an empty name", () => {
    expect(matchScore("llc", "PJSC MTS BANK")).toBeLessThan(0.5);
    expect(matchScore("LLC", "LTD")).toBe(0.333333);
    // Both sides are legal-form-only: stripping must not make them identical.
    expect(matchScore("LLC LTD", "LLC")).toBe(0.666667);
  });
  it("look-alike real SDN banks keep their raw scores and stay under the threshold", () => {
    // The look-alike candidates of the graded receipt have different
    // cores, so their scores are the raw ones and no new false match
    // appears.
    expect(matchScore("MTS BANK", "MB BANK")).toBe(0.75);
    expect(matchScore("MTS BANK", "T-BANK")).toBe(0.75);
    expect(matchScore("MTS BANK", "MRB BANK")).toBe(0.75);
    expect(matchScore("MTS BANK", "VTB BANK")).toBe(0.75);
    expect(matchScore("MTS BANK", "VTB BANK PUBLIC JOINT STOCK COMPANY")).toBe(0.25);
  });
  it("the graded query MTS BANK now matches against the real list bytes", async () => {
    stubMts();
    const result = await handleSanctionsScreen({ name: "MTS BANK" });
    expect(result.matched).toBe(true);
    expect(result.match_score).toBe(1);
    const matches = result.matches as { name: string; kind: string; score: number; above_threshold: boolean }[];
    const pjsc = matches.find((m) => m.name === "PJSC MTS BANK");
    expect(pjsc).toMatchObject({ kind: "alias", score: 1, above_threshold: true });
    const primary = matches.find((m) => m.name === "PUBLIC JOINT STOCK COMPANY MTS BANK");
    expect(primary).toMatchObject({ kind: "primary", score: 1, above_threshold: true });
    // Every non-MTS look-alike in the report stays under the threshold.
    for (const m of matches.filter((x) => !x.name.includes("MTS"))) {
      expect(m.above_threshold).toBe(false);
      expect(m.score).toBeLessThan(0.85);
    }
    // The evidence keeps the exact raw list lines of the candidates.
    const receipt = result.receipt as { receipt_id: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.candidate_raw_lines.some((l: string) => l.includes('"PJSC MTS BANK"') && l.includes("alias of SDN #40718"))).toBe(true);
    expect(body.scoring).toContain("legal-form");
  });
  it("two empty names score 0", () => {
    expect(matchScore("", "")).toBe(0);
  });
  it("a legal-form-only query against the real list bytes stays unmatched", async () => {
    stubMts();
    const result = await handleSanctionsScreen({ name: "llc" });
    expect(result.matched).toBe(false);
    expect(result.match_score).toBeLessThan(0.85);
    expect(String(result.answer)).toContain("NOT a legal clearance");
  });
});
