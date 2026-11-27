import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/sanctions-patronymic-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => resetSanctionsCacheForTests({ sdn: 1, un: 1, cons: 1 })); // fixtures are real-format excerpts
afterEach(() => { vi.unstubAllGlobals(); resetSanctionsCacheForTests(); });
import { handleSanctionsScreen, matchScore, resetSanctionsCacheForTests } from "../src/handlers/sanctionsScreening";
import { getReceiptEvidence } from "../src/core/storage";
// Real rows from the OFAC SDN list and its alias file, retrieved
// 2026-11-27 (SHA-256 89b2a6d6d825d3a0a5033c9d523ef8a5e05a0b766ccff1ad934aea7436da49b9
// for SDN.CSV and 2e342dc26cd1df3e11efba14d54d61d9290e255b502667b5eb2244e203b3ff5a
// for ALT.CSV): SDN #23343 "KADYROV, Ramzan Akhmatovich" and its alias
// #48091 "KADYROV, Ramzan Akhmadovitch". Graded evidence: prod answered
// matched=false, best 0.8, for the exact public name "Ramzan Kadyrov"
// against SDN #23343 — tokens {ramzan,kadyrov} vs
// {kadyrov,ramzan,akhmatovich}, Dice 4/5 = 0.8 under the 0.85 threshold,
// on the patronymic alone.
//
// The rule is deliberately narrow (measurement on the real SDN+ALT+UN
// lists, 43,038 handler candidate names, 2026-11-27): a plain subset rule
// newly lifts 4,419 cross-entity pairs to >=0.85. Requiring the query
// core (2+ tokens, 3+ chars each) to be contained in the listed core with
// only Slavic-patronymic extra tokens, forward direction only, leaves 19
// cross-entity crossings — 6 the same person listed on both the UN and
// OFAC lists, 13 a first+last name shared by two genuinely listed
// individuals (the name itself is listed, so the match decision stands;
// the receipt keeps the raw candidate lines for DOB disambiguation).
const sdnKadyrov = readFileSync(join(__dirname, "fixtures/sanctions/sdn-kadyrov-excerpt.csv"), "utf8");
const altKadyrov = readFileSync(join(__dirname, "fixtures/sanctions/alt-kadyrov-excerpt.csv"), "utf8");
const un = readFileSync(join(__dirname, "fixtures/sanctions/un-excerpt.xml"), "utf8");
const consPrim = readFileSync(join(__dirname, "fixtures/sanctions/cons-prim-excerpt.csv"), "utf8");
const consAlt = readFileSync(join(__dirname, "fixtures/sanctions/cons-alt-excerpt.csv"), "utf8");
function stubKadyrov(): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    // CONS_ALT.CSV contains the substring "ALT.CSV", so the consolidated
    // URLs must be routed first.
    const body = u.includes("CONS_PRIM.CSV") ? consPrim
      : u.includes("CONS_ALT.CSV") ? consAlt
      : u.includes("SDN.CSV") ? sdnKadyrov
      : u.includes("ALT.CSV") ? altKadyrov
      : un;
    return new Response(body, { status: 200 });
  });
}
describe("sanctions patronymic-core rule", () => {
  it("the graded pair: Ramzan Kadyrov scores 0.9 against the patronymic-full SDN name and alias", () => {
    expect(matchScore("Ramzan Kadyrov", "KADYROV, Ramzan Akhmatovich")).toBe(0.9);
    // The alias's alternate transliteration (-ovitch) folds the same way.
    expect(matchScore("Ramzan Kadyrov", "KADYROV, Ramzan Akhmadovitch")).toBe(0.9);
    // Female patronymic forms (-ovna) fold too.
    expect(matchScore("Maria Zakharova", "ZAKHAROVA, Maria Vladimirovna")).toBe(0.9);
    // The floor is 0.9 even when the raw comparison is lower.
    expect(matchScore("UMAROV, Doku", "DOKU KHAMATOVICH UMAROV")).toBe(0.9);
  });
  it("guard: a single shared token never fires the rule", () => {
    expect(matchScore("ivan ivanovich", "ivan petrov")).toBe(0.5);
    // Both tokens shared but the extra token is no patronymic: raw stands.
    expect(matchScore("ivan ivanovich", "petrov ivan ivanovich")).toBe(0.8);
  });
  it("guard: a one-token query never takes this path", () => {
    expect(matchScore("kadyrov", "KADYROV, Ramzan Akhmatovich")).toBe(0.5);
    // Even when every extra token is a patronymic: raw stands (Dice 2/3).
    expect(matchScore("ivanov", "IVANOV, Sergeevich")).toBe(0.666667);
  });
  it("guard: the reverse direction (short listed alias inside a longer query) never fires", () => {
    expect(matchScore("YASIN, Abdul Rahman", "Abdul Rahman")).toBe(0.8);
  });
  it("guard: tokens shorter than 3 characters never participate", () => {
    // "al" is 2 chars: even with an all-patronymic extra, raw stands.
    expect(matchScore("al omar", "OMAR, Al Akhmatovich")).toBe(0.8);
  });
  it("guard: the measured false-positive class stays raw", () => {
    // Different listed person whose name only shares common tokens: the
    // extra token is no patronymic, so the raw score stands (a plain
    // subset rule scored this 0.9 in the 2026-11-27 measurement).
    expect(matchScore("OMAR, Mohammed", "MOHAMMED, Shariff Omar")).toBe(0.8);
    // Not a subset at all: no relation between the cores.
    expect(matchScore("Ramzan Kadyrov", "KADYROVA, Aymani Nesievna")).toBe(0.208333);
  });
  it("the graded query Ramzan Kadyrov now matches against the real list bytes", async () => {
    stubKadyrov();
    const result = await handleSanctionsScreen({ name: "Ramzan Kadyrov" });
    expect(result.matched).toBe(true);
    expect(result.match_score).toBe(0.9);
    const matches = result.matches as { name: string; kind: string; score: number; above_threshold: boolean }[];
    const primary = matches.find((m) => m.name === "KADYROV, Ramzan Akhmatovich");
    expect(primary).toMatchObject({ kind: "primary", score: 0.9, above_threshold: true });
    const alias = matches.find((m) => m.name === "KADYROV, Ramzan Akhmadovitch");
    expect(alias).toMatchObject({ kind: "alias", score: 0.9, above_threshold: true });
    // The evidence keeps the exact raw list line of the candidate.
    const receipt = result.receipt as { receipt_id: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.candidate_raw_lines.some((l: string) => l.includes('"KADYROV, Ramzan Akhmatovich"') && l.startsWith("23343,"))).toBe(true);
    expect(body.scoring).toContain("patronymic");
  });
  it("a one-token Kadyrov query against the real list bytes stays unmatched", async () => {
    stubKadyrov();
    const result = await handleSanctionsScreen({ name: "Kadyrov" });
    expect(result.matched).toBe(false);
    expect(result.match_score).toBeLessThan(0.85);
    expect(String(result.answer)).toContain("NOT a legal clearance");
  });
});
