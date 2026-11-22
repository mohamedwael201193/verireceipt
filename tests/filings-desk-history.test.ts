// Cross-layer regression fixtures only. Every fetch is intercepted; no SEC or paid call.
import { describe, expect, it } from "vitest";
import { handleFilings } from "../src/handlers/filings";
import { makeResearchPlan, evaluateResearch } from "../desk/src/research";
import type { VerifyOutput } from "../desk/src/verify";
import type { Receipt } from "../src/core/receipt";
const row = (accession: string, filingDate: string, form = "10-Q") => ({ accessionNumber: [accession], filingDate: [filingDate], form: [form], primaryDocument: ["fixture.htm"] });
const mainUrl = "https://data.sec.gov/submissions/CIK0001318605.json";
const pageUrl = "https://data.sec.gov/submissions/CIK0001318605-submissions-001.json";
const joinRows = (...items: ReturnType<typeof row>[]) => ({ accessionNumber: items.flatMap(r => r.accessionNumber), filingDate: items.flatMap(r => r.filingDate), form: items.flatMap(r => r.form), primaryDocument: items.flatMap(r => r.primaryDocument) });
for (const scenario of ["neighbor-probe", "slack-boundary"] as const) {
  describe(`actual backend + independent Desk ${scenario}`, () => {
    it("retains source probe bytes and independently supports the count", async () => {
      const previous = process.env.SEC_USER_AGENT; process.env.SEC_USER_AGENT = "VeriReceipt test fixture contact@unit.test";
      try {
        const plan = makeResearchPlan({ cik: "1318605", year: 2019, form: "10-Q", minimum_count: 3 });
        const january = row("0001318605-19-000001", "2019-01-02");
        const rest = joinRows(row("0001318605-19-000002", "2019-05-01"), row("0001318605-19-000003", "2019-08-01"));
        const page = scenario === "neighbor-probe" ? row("0001318605-18-000001", "2018-06-16", "8-K") : january;
        const main = { cik: "1318605", name: "Test-only issuer fixture", filings: { recent: scenario === "neighbor-probe" ? joinRows(january, rest) : rest,
          files: [{ name: "CIK0001318605-submissions-001.json", filingFrom: "2018-01-01", filingTo: scenario === "neighbor-probe" ? "2018-06-16" : "2018-12-31", filingCount: 1 }] } };
        let stored: { receipt: Receipt; body: string; pages: string[] } | undefined;
        const fetchSource = (async (input: string | URL | Request) => {
          const url = String(input);
          if (url === "https://www.sec.gov/files/company_tickers.json") return new Response(JSON.stringify({ "0": { cik_str: 1318605, ticker: "ZZZFIX", title: "Test-only issuer fixture" } }));
          if (url === mainUrl) return new Response(JSON.stringify(main));
          if (url === pageUrl) return new Response(JSON.stringify(page));
          throw new Error("Unexpected test source URL");
        }) as typeof fetch;
        const answer = await handleFilings(plan.params, { fetchImpl: fetchSource, saveReceiptImpl: (receipt, evidence, pages) => {
          stored = { receipt, body: Buffer.isBuffer(evidence) ? evidence.toString("utf8") : String(evidence), pages: (pages ?? []).map(p => Buffer.isBuffer(p.body) ? p.body.toString("utf8") : String(p.body)) };
        } });
        expect(answer.filing_count).toBe(3); expect(answer.upstream_pages).toHaveLength(1); expect(stored).toBeDefined(); expect(stored!.pages).toHaveLength(1);
        const v: VerifyOutput = { verified: true, checks: [], minerReceipt: stored!.receipt, rawSha256: stored!.receipt.raw_response_sha256, rawBytes: Buffer.byteLength(stored!.body),
          payloadValue: 3, intentId: "REGULATORY_FILING_MONITOR_GENERAL", request: "test-only source replay", requestParams: plan.params, signalTimestamp: new Date().toISOString(), fields: null, payloadResponse: answer };
        const fetchStored = (async (input: string | URL | Request) => {
          const url = String(input); const match = /\/pages\/(\d+)\/raw$/.exec(url);
          return new Response(match ? stored!.pages[Number(match[1])] : stored!.body);
        }) as typeof fetch;
        const result = await evaluateResearch(plan, v, fetchStored, new Date()); expect(result.status).toBe("SUPPORTED"); expect(result.observed_count).toBe(3);
        const missing = { ...v, payloadResponse: { ...answer, upstream_pages: [] } };
        expect((await evaluateResearch(plan, missing, fetchStored, new Date())).status).toBe("HOLD");
      } finally { if (previous === undefined) delete process.env.SEC_USER_AGENT; else process.env.SEC_USER_AGENT = previous; }
    });
  });
}
