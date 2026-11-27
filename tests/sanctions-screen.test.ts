import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/sanctions-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => resetSanctionsCacheForTests({ sdn: 1, un: 1 })); // fixtures are real-format excerpts
afterEach(() => { vi.unstubAllGlobals(); resetSanctionsCacheForTests(); });
import { handleSanctionsScreen, matchScore, parseSdn, parseAlt, parseUn, resetSanctionsCacheForTests } from "../src/handlers/sanctionsScreening";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real-format excerpts of the OFAC SDN list, OFAC aliases and the UN
// consolidated list, retrieved 2026-11-23.
const sdn = readFileSync(join(__dirname, "fixtures/sanctions/sdn-excerpt.csv"), "utf8");
const alt = readFileSync(join(__dirname, "fixtures/sanctions/alt-excerpt.csv"), "utf8");
const un = readFileSync(join(__dirname, "fixtures/sanctions/un-excerpt.xml"), "utf8");
function stub(opts: { sdn?: string; alt?: string; un?: string } = {}): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    const body = u.includes("SDN.CSV") ? (opts.sdn ?? sdn) : u.includes("ALT.CSV") ? (opts.alt ?? alt) : (opts.un ?? un);
    if (body === "ERR") throw new Error("test outage");
    return new Response(body, { status: 200 });
  });
}
describe("SANCTIONS_SCREENING_MATCH_GENERAL", () => {
  it("parses the real list formats", () => {
    expect(parseSdn(sdn).entries.get("36")).toBe("AEROCARIBBEAN AIRLINES");
    expect(parseAlt(alt)[0]).toMatchObject({ altNum: "36", name: "AERO-CARIBBEAN" });
    const unNames = parseUn(un).map((x) => x.name);
    expect(unNames).toContain("ERIC BADEGE");
  });
  it("score: exact is 1, near spellings score high, unrelated names score low", () => {
    expect(matchScore("Aerocaribbean Airlines", "AEROCARIBBEAN AIRLINES")).toBe(1);
    expect(matchScore("Eric Badege", "ERIC BADEGE")).toBe(1);
    expect(matchScore("Badege Eric", "ERIC BADEGE")).toBe(1); // token-set dice is order-insensitive
    expect(matchScore("Aero Caribbean", "AERO-CARIBBEAN")).toBe(1); // normalization folds punctuation
    expect(matchScore("John Smith", "AEROCARIBBEAN AIRLINES")).toBeLessThan(0.5);
  });
  it("pins MATCH_THRESHOLD 0.85: the reviewer control scores 0.57, is reported as a candidate, and matched stays false", async () => {
    // Reviewer control pair: a near-but-different name must land below the
    // threshold and still be disclosed as a candidate. The reviewer's memo
    // quoted 0.57, which is this pair's Sørensen-Dice component; the
    // documented score is max(Dice, normalized Levenshtein) = 0.666667.
    // Legal-form stripping ("co", "ltd") does NOT lift this pair: the
    // stripped cores ("anglo caribbean shipping" vs "anglo caribbean")
    // are not equal, so the raw score stands.
    expect(matchScore("ANGLO CARIBBEAN SHIPPING", "ANGLO-CARIBBEAN CO., LTD.")).toBe(0.666667);
    stub();
    const result = await handleSanctionsScreen({ name: "ANGLO CARIBBEAN SHIPPING" });
    expect(result.matched).toBe(false);
    const matches = result.matches as { name: string; score: number; above_threshold: boolean }[];
    const anglo = matches.find((m) => m.name.includes("ANGLO-CARIBBEAN"));
    expect(anglo).toBeDefined();
    expect(anglo!.score).toBe(0.666667);
    expect(anglo!.above_threshold).toBe(false);
    expect(String(result.answer)).toContain("threshold 0.85");
  });
  it("validates before fetching", async () => {
    await expect(handleSanctionsScreen({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleSanctionsScreen({ name: "!!!" })).rejects.toMatchObject({ status: 400, code: "INVALID_NAME" });
  });
  it("an exact listed name matches with the scoring disclosed and false-positive wording", async () => {
    stub();
    const result = await handleSanctionsScreen({ name: "Aerocaribbean Airlines" });
    expect(result.matched).toBe(true);
    expect(result.match_score).toBe(1);
    const matches = result.matches as { list: string; name: string; score: number }[];
    expect(matches[0].list).toBe("OFAC SDN");
    expect(matches[0].name).toBe("AEROCARIBBEAN AIRLINES");
    const ans = String(result.answer);
    expect(ans).toContain("NOT identity confirmation");
    expect(ans).toContain("false positives are common");
    expect(ans).toContain("NOT a legal clearance");
    expect(ans).toContain("not legal advice");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("SANCTIONS_SCREENING_MATCH_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.lists).toHaveLength(3);
    expect(body.candidate_raw_lines[0]).toContain("AEROCARIBBEAN AIRLINES");
  });
  it("a UN-listed individual matches via the UN list", async () => {
    stub();
    const result = await handleSanctionsScreen({ name: "Eric Badege" });
    expect(result.matched).toBe(true);
    const matches = result.matches as { list: string }[];
    expect(matches.some((m) => m.list === "UN Consolidated")).toBe(true);
  });
  it("an alias carries the match and is labelled as an alias", async () => {
    stub();
    const result = await handleSanctionsScreen({ name: "Aero Caribbean" });
    expect(result.matched).toBe(true);
    const matches = result.matches as { kind: string; name: string }[];
    expect(matches[0].kind).toBe("alias");
  });
  it("an unrelated name does not match, with candidates honestly empty", async () => {
    stub();
    const result = await handleSanctionsScreen({ name: "Zelda Quixotic Fandango" });
    expect(result.matched).toBe(false);
    expect(result.match_score).toBe(0);
    expect(result.matches).toEqual([]);
    expect(String(result.answer)).toContain("NOT a legal clearance");
  });
  it("a truncated list is refused, never screened against", async () => {
    resetSanctionsCacheForTests({ sdn: 100, un: 1 }); // fixture has 5 SDN rows
    stub();
    await expect(handleSanctionsScreen({ name: "Aerocaribbean Airlines" }))
      .rejects.toMatchObject({ status: 502, code: "SDN_LIST_DEGRADED" });
  });
  it("a list outage is an honest 502", async () => {
    stub({ sdn: "ERR" });
    await expect(handleSanctionsScreen({ name: "Aerocaribbean Airlines" }))
      .rejects.toMatchObject({ status: 502, code: "SANCTIONS_LISTS_UNREACHABLE" });
  });
  it("GET /v1/sanctions-screen is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/sanctions-screen" })).toBe(true);
    stub();
    const res = await app.inject({ method: "GET", url: "/v1/sanctions-screen?name=Eric%20Badege" });
    expect(res.statusCode).toBe(200);
    expect(res.json().matched).toBe(true);
    await app.close();
  });
});
