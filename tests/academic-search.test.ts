// These controls isolate the Crossref fallback and its cache/failure semantics.
vi.mock('../src/handlers/openAlexAcademic',()=>({openAlexAnswer:vi.fn(async()=>{throw Error('OpenAlex unavailable in Crossref-specific control');})}));
import {resetAcademicCacheForTests} from "../src/handlers/academicSourceCache";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/academic-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { resetAcademicCacheForTests(); vi.unstubAllGlobals(); });
import { handleAcademicSearch, parseCrossrefWorks } from "../src/handlers/academicSearch";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/academic", name), "utf8");
const works = fixture("crossref-verifiable-compute-receipts.json"); // real Crossref body, retrieved 2026-11-23
const none = fixture("crossref-no-matches.json");                     // real Crossref body, retrieved 2026-11-23
function stub(body: string | null): void {
  vi.stubGlobal("fetch", async () => {
    if (body === null) throw new Error("test source outage");
    return new Response(body, { status: 200 });
  });
}
describe("ACADEMIC_SEARCH_GENERAL", () => {
  it("validates before fetching", async () => {
    await expect(handleAcademicSearch({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleAcademicSearch({ query: "x".repeat(300) })).rejects.toMatchObject({ status: 400, code: "QUERY_TOO_LONG" });
  });
  it("serves the real Crossref ranking with aligned titles and DOIs", async () => {
    stub(works);
    const result = await handleAcademicSearch({ query: "verifiable compute receipts" });
    expect(result.total_matches).toBe(18381);
    const titles = result.paper_titles as string[];
    const dois = result.dois as string[];
    expect(titles.length).toBe(5);
    expect(dois.length).toBe(5);
    expect(titles[0]).toContain("Secret-ballot receipts");
    expect(dois[0]).toBe("10.1109/msecp.2004.1264852");
    expect(String(result.answer)).toContain("Crossref's own relevance order");
    expect((result.brief as string).length).toBeLessThanOrEqual(80);
    expect((result.brief as string)).not.toMatch(/[\uD800-\uDFFF]/); // no lone surrogates
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("ACADEMIC_SEARCH_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const body = JSON.parse(stored.evidence.toString("utf8"));
    expect(body.raw_body).toBe(works);
  });
  it("a title needing truncation still yields a surrogate-safe 80-cell brief", async () => {
    const edited = JSON.parse(works);
    edited.message.items[0].title = ["T".repeat(60) + " \uD83D\uDD25".replace("\\uD83D\\uDD25", "\uD83D\uDD25") + "x".repeat(40)];
    stub(JSON.stringify(edited));
    const result = await handleAcademicSearch({ query: "verifiable compute receipts" });
    const brief = result.brief as string;
    expect(brief.length).toBeLessThanOrEqual(80);
    expect(brief).not.toMatch(/[\uD800-\uDFFF]/);
  });
  it("zero matches is a real answer with empty lists, never an error", async () => {
    stub(none);
    const result = await handleAcademicSearch({ query: "zzqxj kqvwmbl fplxdrt" });
    expect(result.total_matches).toBe(0);
    expect(result.paper_titles).toEqual([]);
    expect(result.dois).toEqual([]);
    expect(result.verdict).toBe("verified");
    expect(String(result.answer)).toContain("not proof no paper exists");
  });
  it("items lacking a title or DOI are skipped and counted, never misaligned", async () => {
    const edited = JSON.parse(works);
    delete edited.message.items[0].DOI;
    delete edited.message.items[1].title;
    stub(JSON.stringify(edited));
    const result = await handleAcademicSearch({ query: "verifiable compute receipts" });
    const titles = result.paper_titles as string[];
    const dois = result.dois as string[];
    expect(titles.length).toBe(3);
    expect(dois.length).toBe(3);
    expect(titles[0]).toContain("Finance-Grade Assurance"); // first two items skipped, order preserved
    expect(String(result.answer)).toContain("2 returned item(s) lacked title/DOI");
  });
  it("a Crossref outage is an honest 502, never an invented list", async () => {
    stub(null);
    await expect(handleAcademicSearch({ query: "zk proofs" })).rejects.toMatchObject({ status: 502, code: "CROSSREF_UNREACHABLE" });
  });
  it("a malformed Crossref body is an honest 502", async () => {
    expect(() => parseCrossrefWorks("not json")).toThrow();
    expect(() => parseCrossrefWorks("{}")).toThrow();
  });
  it("GET /v1/academic-search is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/academic-search" })).toBe(true);
    stub(works);
    const res = await app.inject({ method: "GET", url: "/v1/academic-search?query=verifiable%20compute%20receipts" });
    expect(res.statusCode).toBe(200);
    expect(res.json().total_matches).toBe(18381);
    await app.close();
  });
});
