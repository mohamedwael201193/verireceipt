import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/sanctions-consolidated-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => resetSanctionsCacheForTests({ sdn: 1, un: 1 })); // fixtures are real-format excerpts
afterEach(() => { vi.unstubAllGlobals(); resetSanctionsCacheForTests(); });
import { handleSanctionsScreen, matchScore, parseSdn, resetSanctionsCacheForTests, SANCTIONS_LIST_FLOORS } from "../src/handlers/sanctionsScreening";
import { getReceiptEvidence } from "../src/core/storage";
// Real rows from the OFAC Consolidated (non-SDN) list, retrieved
// 2026-11-27 (SHA-256 4fe4f7faf8c5c329bb9f7cd5e145794aa267b21ec2ee5df82bacdd1d60a20545
// for CONS_PRIM.CSV and 106ba0e33579c5d20693e414ad66a9145329f1db012a18c3bdc8f84491a32b81
// for CONS_ALT.CSV, from
// https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONS_PRIM.CSV
// and .../CONS_ALT.CSV). Entry 30946, "HANGZHOU HIKVISION DIGITAL
// TECHNOLOGY CO., LTD." (program CMIC-EO13959), is the graded epoch-67
// SANCTIONS call that answered matched=false at 0.727 when only the SDN
// and UN lists were screened: the company is not on the SDN list, only
// on the Consolidated (non-SDN) list.
const sdn = readFileSync(join(__dirname, "fixtures/sanctions/sdn-excerpt.csv"), "utf8");
const alt = readFileSync(join(__dirname, "fixtures/sanctions/alt-excerpt.csv"), "utf8");
const un = readFileSync(join(__dirname, "fixtures/sanctions/un-excerpt.xml"), "utf8");
const consPrim = readFileSync(join(__dirname, "fixtures/sanctions/cons-prim-excerpt.csv"), "utf8");
const consAlt = readFileSync(join(__dirname, "fixtures/sanctions/cons-alt-excerpt.csv"), "utf8");
function stub(opts: { consPrim?: string; consAlt?: string } = {}): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    // CONS_ALT.CSV contains the substring "ALT.CSV", so the consolidated
    // URLs must be routed first.
    const body = u.includes("CONS_PRIM.CSV") ? (opts.consPrim ?? consPrim)
      : u.includes("CONS_ALT.CSV") ? (opts.consAlt ?? consAlt)
      : u.includes("SDN.CSV") ? sdn
      : u.includes("ALT.CSV") ? alt
      : un;
    if (body === "ERR") throw new Error("test outage");
    return new Response(body, { status: 200 });
  });
}
describe("OFAC Consolidated (non-SDN) screening", () => {
  it("parses the real consolidated format: entry 30946 is Hikvision, CMIC-EO13959", () => {
    const cons = parseSdn(consPrim);
    expect(cons.entries.get("30946")).toBe("HANGZHOU HIKVISION DIGITAL TECHNOLOGY CO., LTD.");
    expect(cons.lines.get("30946")).toContain("CMIC-EO13959");
  });
  it("the graded name matches at 1.0, labelled OFAC Consolidated (non-SDN)", async () => {
    stub();
    const result = await handleSanctionsScreen({ name: "Hangzhou Hikvision Digital Technology Co., Ltd." });
    expect(result.matched).toBe(true);
    expect(result.match_score).toBe(1);
    const matches = result.matches as { list: string; name: string; kind: string; score: number; above_threshold: boolean }[];
    expect(matches[0]).toMatchObject({ list: "OFAC Consolidated (non-SDN)", kind: "primary", score: 1, above_threshold: true });
    expect(matches[0].name).toBe("HANGZHOU HIKVISION DIGITAL TECHNOLOGY CO., LTD.");
    // The published alias "HANGZHOU HIKVISION DIGITAL TECHNOLOGY" equals
    // the stripped core of the full name, so it matches at 1.0 too.
    expect(matches.some((m) => m.kind === "alias" && m.name === "HANGZHOU HIKVISION DIGITAL TECHNOLOGY" && m.list === "OFAC Consolidated (non-SDN)" && m.score === 1)).toBe(true);
    // The evidence keeps the exact raw consolidated list line.
    const receipt = result.receipt as { receipt_id: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.candidate_raw_lines.some((l: string) => l.includes("CMIC-EO13959"))).toBe(true);
    expect(body.candidate_raw_lines.some((l: string) => l.includes('alias of Consolidated #30946'))).toBe(true);
    // The answer names the three screened lists truthfully.
    const ans = String(result.answer);
    expect(ans).toContain("OFAC SDN, OFAC Consolidated (non-SDN) and UN consolidated sanctions lists");
  });
  it("the alias alone carries the match and is labelled as an alias of the consolidated entry", async () => {
    stub();
    const result = await handleSanctionsScreen({ name: "Hikvision" });
    expect(result.matched).toBe(true);
    const matches = result.matches as { list: string; kind: string; name: string; score: number }[];
    expect(matches[0]).toMatchObject({ list: "OFAC Consolidated (non-SDN)", kind: "alias", name: "HIKVISION", score: 1 });
  });
  it("the lists output and receipt evidence carry the new list with its label", async () => {
    stub();
    const result = await handleSanctionsScreen({ name: "Hikvision" });
    expect(result.lists).toEqual(["OFAC SDN", "OFAC SDN aliases", "UN Consolidated", "OFAC Consolidated (non-SDN)", "OFAC Consolidated (non-SDN) aliases"]);
    const receipt = result.receipt as { receipt_id: string };
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.lists).toHaveLength(5);
    const cons = body.lists.find((l: { list: string }) => l.list === "OFAC Consolidated (non-SDN)");
    expect(cons.url).toContain("CONS_PRIM.CSV");
    expect(cons.sha256).toMatch(/^[0-9a-f]{64}$/);
    const consAliases = body.lists.find((l: { list: string }) => l.list === "OFAC Consolidated (non-SDN) aliases");
    expect(consAliases.url).toContain("CONS_ALT.CSV");
  });
  it("Stripe, Inc. stays unmatched against the combined lists", async () => {
    stub();
    const result = await handleSanctionsScreen({ name: "Stripe, Inc." });
    expect(result.matched).toBe(false);
    expect(result.match_score).toBeLessThan(0.85);
    const matches = result.matches as { above_threshold: boolean }[];
    expect(matches.every((m) => !m.above_threshold)).toBe(true);
    expect(String(result.answer)).toContain("only these three lists were screened");
  });
  it("Harborlight Procurement Solutions Ltd. stays unmatched against the combined lists", async () => {
    stub();
    const result = await handleSanctionsScreen({ name: "Harborlight Procurement Solutions Ltd." });
    expect(result.matched).toBe(false);
    expect(result.match_score).toBeLessThan(0.85);
    const matches = result.matches as { above_threshold: boolean }[];
    expect(matches.every((m) => !m.above_threshold)).toBe(true);
  });
  it("a consolidated alias whose parent entry is absent is never a candidate", async () => {
    // The cons-alt excerpt lists aliases of entry 19675, which is not in
    // the cons-prim excerpt: they must be skipped, exactly like SDN
    // aliases with a missing parent.
    stub();
    const result = await handleSanctionsScreen({ name: "GAZPROM KAPITAL" });
    const matches = result.matches as { name: string }[];
    expect(matches.some((m) => m.name.includes("GAZPROM"))).toBe(false);
    expect(result.matched).toBe(false);
  });
  it("a truncated consolidated list is refused, never screened against", async () => {
    resetSanctionsCacheForTests({ sdn: 1, un: 1, cons: 10 }); // prim excerpt has 3 rows
    stub();
    await expect(handleSanctionsScreen({ name: "Hikvision" }))
      .rejects.toMatchObject({ status: 502, code: "CONS_LIST_DEGRADED" });
  });
  it("the production default floors are pinned and restored by a bare reset", async () => {
    // The cons default sits under the real list size (486 primaries on
    // 2026-11-27) so a delisting round never trips it.
    expect(SANCTIONS_LIST_FLOORS).toEqual({ sdn: 1000, un: 100, cons: 300 });
    resetSanctionsCacheForTests(); // bare: production defaults return
    stub();
    await expect(handleSanctionsScreen({ name: "Hikvision" }))
      .rejects.toMatchObject({ status: 502, code: "SDN_LIST_DEGRADED" });
  });
  it("the default cons floor of 300 refuses a short consolidated list", async () => {
    resetSanctionsCacheForTests({ sdn: 1, un: 1, cons: SANCTIONS_LIST_FLOORS.cons }); // prim excerpt has 3 rows
    stub();
    await expect(handleSanctionsScreen({ name: "Hikvision" }))
      .rejects.toMatchObject({ status: 502, code: "CONS_LIST_DEGRADED" });
  });
  it("a consolidated alias parent comes from the consolidated primaries, never the SDN list", async () => {
    // Entry 36 is AEROCARIBBEAN AIRLINES on the SDN fixture; it is NOT in
    // the consolidated primaries, so a consolidated alias pointing at 36
    // has no parent and must never be screened.
    stub({ consAlt: '36,1,"aka","AEROCARIBBEAN HOLDINGS CONS",-0- \n' });
    const result = await handleSanctionsScreen({ name: "AEROCARIBBEAN HOLDINGS CONS" });
    const matches = result.matches as { name: string }[];
    expect(matches.some((m) => m.name === "AEROCARIBBEAN HOLDINGS CONS")).toBe(false);
    expect(result.matched).toBe(false);
  });
  it("a consolidated list outage is an honest 502", async () => {
    stub({ consPrim: "ERR" });
    await expect(handleSanctionsScreen({ name: "Hikvision" }))
      .rejects.toMatchObject({ status: 502, code: "SANCTIONS_LISTS_UNREACHABLE" });
  });
  it("score: the graded pair through the scorer, with and without legal forms", () => {
    expect(matchScore("Hangzhou Hikvision Digital Technology Co., Ltd.", "HANGZHOU HIKVISION DIGITAL TECHNOLOGY CO., LTD.")).toBe(1);
    // The published alias equals the stripped core of the full name.
    expect(matchScore("Hangzhou Hikvision Digital Technology Co., Ltd.", "HANGZHOU HIKVISION DIGITAL TECHNOLOGY")).toBe(1);
    expect(matchScore("Hikvision", "HIKVISION")).toBe(1);
  });
});
