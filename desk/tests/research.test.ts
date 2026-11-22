import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { evaluateResearch, makeResearchPlan, planHash, researchMarkdown, validateResearchPlan, type ResearchPlan } from "../src/research";
import type { VerifyOutput } from "../src/verify";

const T = new Date("2026-11-21T20:00:00Z");
const completed = new Date(T.getTime() + 2000);
const input = { cik: "320193", year: 2025, form: "10-Q", minimum_count: 3 };
const p = () => makeResearchPlan(input, T);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const rows = { form: ["10-Q", "10-Q", "10-Q", "10-Q/A", "10-Q"],
  accessionNumber: ["0000320193-25-000001", "0000320193-25-000002", "0000320193-25-000003", "0000320193-25-000004", "0000320193-24-000001"],
  filingDate: ["2025-01-31", "2025-05-02", "2025-08-01", "2025-08-02", "2024-12-31"],
  primaryDocument: ["a.htm", "b.htm", "c.htm", "d.htm", "e.htm"] };
function setup(over: { main?: unknown; answer?: Record<string, unknown>; v?: Partial<VerifyOutput>; raw?: string; pages?: string[] } = {}) {
  const main = over.main ?? { cik: "0000320193", name: "Apple Inc.", filings: { recent: rows, files: [] } };
  const raw = JSON.stringify(main);
  const receipt = { receipt_id: "rcpt_" + "A".repeat(26), raw_response_sha256: sha(raw), upstream_url: "https://data.sec.gov/submissions/CIK0000320193.json", fetched_at: "2026-11-21T20:00:01Z" };
  const answer = { filing_count: 3, form_type: "10-Q", receipt, ...over.answer };
  const v: VerifyOutput = { verified: true, checks: [], minerReceipt: receipt, rawSha256: sha(raw), rawBytes: raw.length,
    payloadValue: 3, intentId: "REGULATORY_FILING_MONITOR_GENERAL", request: "test fixture", requestParams: p().params,
    signalTimestamp: "2026-11-21T20:00:01Z", fields: null, payloadResponse: answer, ...over.v };
  const fetch = vi.fn(async (url: string) => {
    const match = /\/pages\/(\d+)\/raw$/.exec(url);
    if (match) return new Response(over.pages?.[Number(match[1])] ?? "missing", { status: over.pages?.[Number(match[1])] ? 200 : 404 });
    return new Response(over.raw ?? raw);
  }) as unknown as typeof globalThis.fetch;
  return { v, fetch, receipt, raw };
}

describe("pre-purchase research plan", () => {
  it("canonicalizes only supported input into a bounded Sepolia plan", () => {
    expect(p().params).toEqual({ entity: "Form 10-Q filings by CIK 320193", period: "calendar 2025" });
    expect(p().network).toBe("eip155:11155111");
    expect(p().maximum_call_uusdc).toBe("10000");
    expect(() => validateResearchPlan(p(), planHash(p()), completed)).not.toThrow();
  });
  it.each(["0", "0320193", "-1", "Apple", "1\n2", "1.0", "12345678901"])("refuses CIK %s", cik => {
    expect(() => makeResearchPlan({ ...input, cik }, T)).toThrow();
  });
  it.each([2026, 2027, 1993, 2025.5, NaN])("refuses incomplete or invalid year %s", year => {
    expect(() => makeResearchPlan({ ...input, year }, T)).toThrow();
  });
  it.each(["10-Q/A", "10K", "ALL", ""]) ("refuses unsupported form %s", form => {
    expect(() => makeResearchPlan({ ...input, form }, T)).toThrow();
  });
  it.each([0, -1, 1.5, 1001, NaN])("refuses arbitrary threshold %s", minimum_count => {
    expect(() => makeResearchPlan({ ...input, minimum_count }, T)).toThrow();
  });
  it("detects mutation, unknown fields, stale plans and future plans", () => {
    const plan = p(), hash = planHash(plan);
    expect(() => validateResearchPlan({ ...plan, minimum_count: 1 }, hash, completed)).toThrow();
    expect(() => validateResearchPlan({ ...plan, unknown: 1 } as ResearchPlan, hash, completed)).toThrow();
    expect(() => validateResearchPlan(plan, hash, new Date(T.getTime() + 3600001))).toThrow();
    expect(() => validateResearchPlan(plan, hash, new Date(T.getTime() - 1))).toThrow();
  });
});

describe("independent stored SEC extraction (synthetic fixtures, not live use)", () => {
  it("supports exact boundary and excludes amendments / other years", async () => {
    const x = setup(); const r = await evaluateResearch(p(), x.v, x.fetch, completed);
    expect(r.status).toBe("SUPPORTED"); expect(r.observed_count).toBe(3);
    expect(r.rows.map(x => x.filing_date)).toEqual(["2025-08-01", "2025-05-02", "2025-01-31"]);
    expect(r.source_name).toBe("Apple Inc.");
  });
  it("reports a verified negative research result, not a verification error", async () => {
    const x = setup(); const r = await evaluateResearch({ ...p(), minimum_count: 4 }, x.v, x.fetch, completed);
    expect(r.status).toBe("NOT_SUPPORTED"); expect(r.observed_count).toBe(3);
  });
  it.each([
    { verified: false }, { requestParams: { entity: "Form 10-Q filings by CIK 1318605", period: "calendar 2025" } },
    { requestParams: { ...p().params, extra: "x" } }, { signalTimestamp: "2026-11-21T19:59:59Z" },
    { signalTimestamp: "2026-11-21T21:00:00Z" }, { payloadValue: 8 },
  ])("holds for existing verification or identity/time conflict %j", async v => {
    const x = setup({ v }); const r = await evaluateResearch(p(), x.v, x.fetch, completed);
    expect(r.status).toBe("HOLD"); expect(r.rows).toEqual([]); expect(r.observed_count).toBeNull();
  });
  it("will not fetch arbitrary receipt paths or source URLs", async () => {
    const x = setup(); x.v.minerReceipt!.receipt_id = "../../other";
    expect((await evaluateResearch(p(), x.v, x.fetch, completed)).status).toBe("HOLD");
    expect(x.fetch).not.toHaveBeenCalled();
  });
  it("detects changed raw main bytes", async () => {
    const x = setup({ raw: "altered" }); expect((await evaluateResearch(p(), x.v, x.fetch, completed)).status).toBe("HOLD");
  });
  it.each([
    { filing_count: 30 }, { form_type: "10-K" }, { upstream_pages: "not an array" },
    { receipt: { fetched_at: "2026-11-21T19:59:59Z" } }, { receipt: { fetched_at: "2026-11-21T20:01:00Z" } },
  ])("holds for malformed/stale/wrong paid response %j", async answer => {
    const x = setup({ answer }); expect((await evaluateResearch(p(), x.v, x.fetch, completed)).status).toBe("HOLD");
  });
  it("holds when evidence has become too old", async () => {
    const x = setup(); expect((await evaluateResearch(p(), x.v, x.fetch, new Date(T.getTime() + 301001))).status).toBe("HOLD");
  });
  it.each([
    { cik: "0001318605", name: "Other", filings: { recent: rows, files: [] } },
    { cik: "0000320193", name: "", filings: { recent: rows, files: [] } },
    { cik: "0000320193", name: "Apple", filings: { recent: { ...rows, form: [] }, files: [] } },
    { cik: "0000320193", name: "Apple", filings: { recent: rows, files: null } },
  ])("holds on wrong CIK or malformed source", async main => {
    const x = setup({ main }); expect((await evaluateResearch(p(), x.v, x.fetch, completed)).status).toBe("HOLD");
  });
  it("requires every overlapping history page, even if paid answer omits it", async () => {
    const main = { cik: "0000320193", name: "Apple", filings: { recent: rows,
      files: [{ name: "CIK0000320193-submissions-001.json", filingFrom: "2024-01-01", filingTo: "2025-02-01" }] } };
    const x = setup({ main }); expect((await evaluateResearch(p(), x.v, x.fetch, completed)).status).toBe("HOLD");
  });
  it("replays required history bytes, rechecks digest and deduplicates accessions", async () => {
    const page = JSON.stringify(rows);
    const file = { name: "CIK0000320193-submissions-001.json", filingFrom: "2024-01-01", filingTo: "2025-12-31", filingCount: rows.form.length };
    const main = { cik: "0000320193", name: "Apple", filings: { recent: rows, files: [file] } };
    const x = setup({ main, pages: [page], answer: { upstream_pages: [{ url: `https://data.sec.gov/submissions/${file.name}`, raw_response_sha256: sha(page) }] } });
    expect((await evaluateResearch(p(), x.v, x.fetch, completed)).status).toBe("SUPPORTED");
    const bad = setup({ main, pages: [page + " "], answer: { upstream_pages: [{ url: `https://data.sec.gov/submissions/${file.name}`, raw_response_sha256: sha(page) }] } });
    expect((await evaluateResearch(p(), bad.v, bad.fetch, completed)).status).toBe("HOLD");
  });
  it("replays a valid non-overlapping drift probe instead of a false HOLD (test-only fixture)", async () => {
    const probeRows = { form: ["8-K"], accessionNumber: ["0000320193-24-999990"], filingDate: ["2024-06-16"], primaryDocument: ["probe.htm"] };
    const page = JSON.stringify(probeRows);
    const file = { name: "CIK0000320193-submissions-001.json", filingFrom: "2024-01-01", filingTo: "2024-06-16", filingCount: 1 };
    const main = { cik: "0000320193", name: "Apple", filings: { recent: rows, files: [file] } };
    const x = setup({ main, pages: [page], answer: { upstream_pages: [{ url: `https://data.sec.gov/submissions/${file.name}`, raw_response_sha256: sha(page) }] } });
    const result = await evaluateResearch(p(), x.v, x.fetch, completed);
    expect(result.status).toBe("SUPPORTED"); expect(result.observed_count).toBe(3);
  });
  it("does not treat duplicate conflicting rows as harmless", async () => {
    const changed = { ...rows, accessionNumber: [...rows.accessionNumber.slice(0, 4), rows.accessionNumber[0]] };
    const x = setup({ main: { cik: "0000320193", name: "Apple", filings: { recent: changed, files: [] } } });
    expect((await evaluateResearch(p(), x.v, x.fetch, completed)).status).toBe("HOLD");
  });

  it("accepts SEC XSL subpaths but never traversal or another document host", async () => {
    const extra = { ...rows, primaryDocument: ["xslF345X06/form4.xml", ...rows.primaryDocument.slice(1)] };
    const x = setup({ main: { cik: "0000320193", name: "Apple", filings: { recent: extra, files: [] } } });
    expect((await evaluateResearch(p(), x.v, x.fetch, completed)).status).toBe("SUPPORTED");
    const bad = setup({ answer: { filings_detail: [{ form: "10-Q", accession: rows.accessionNumber[0], filing_date: rows.filingDate[0], url: "https://example.invalid/fake" }] } });
    expect((await evaluateResearch(p(), bad.v, bad.fetch, completed)).status).toBe("HOLD");
  });
  it("keeps only source-linked paid URLs that match independent source metadata", async () => {
    const url = "https://www.sec.gov/Archives/edgar/data/320193/000032019325000001/a.htm";
    const x = setup({ answer: { filings_detail: [{ form: "10-Q", accession: rows.accessionNumber[0], filing_date: rows.filingDate[0], url }] } });
    const r = await evaluateResearch(p(), x.v, x.fetch, completed);
    expect(r.status).toBe("SUPPORTED"); expect(researchMarkdown(p(), planHash(p()), r)).toContain(url);
  });
  it("renders output as research, not investment / adoption / settlement claims", async () => {
    const x = setup(); const r = await evaluateResearch(p(), x.v, x.fetch, completed);
    const text = researchMarkdown(p(), planHash(p()), r);
    expect(text).toContain("Not an investment"); expect(text).toContain("Not independent adoption");
    expect(text).toContain("No unmeasured time or money savings");
  });
});
