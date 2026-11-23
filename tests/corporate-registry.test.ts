import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/corp-reg-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
process.env.SEC_USER_AGENT = "VeriReceipt tests contact@example.com";
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => __clearCorporateRegistryCacheForTests());
afterEach(() => { vi.unstubAllGlobals(); __clearCorporateRegistryCacheForTests(); });
import { handleCorporateRegistry, parseSubmissions, __clearCorporateRegistryCacheForTests } from "../src/handlers/corporateRegistry";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real SEC bodies, retrieved 2026-11-23.
const appleSub = readFileSync(join(__dirname, "fixtures/corporate-registry/edgar-submissions-apple.json"), "utf8");
const tickers = readFileSync(join(__dirname, "fixtures/corporate-registry/company-tickers-excerpt.json"), "utf8");
function stub(opts: { sub?: string } = {}): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("company_tickers")) return new Response(tickers, { status: 200 });
    if(u.includes("api.gleif.org")) return new Response(readFileSync(join(__dirname,"fixtures/corporate-gleif/negative.json"),"utf8"));
    if (opts.sub === "ERR") throw new Error("test outage");
    return new Response(opts.sub ?? appleSub, { status: 200 });
  });
}
describe("CORPORATE_REGISTRY_LOOKUP_GENERAL", () => {
  it("validates required inputs before fetching", async () => {
    await expect(handleCorporateRegistry({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleCorporateRegistry({ company: "Apple" })).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
  });
  it("resolves a ticker and serves the real EDGAR profile with honest scoping", async () => {
    stub();
    const result = await handleCorporateRegistry({ company: "AAPL", jurisdiction: "US" });
    expect(result.legal_name).toBe("Apple Inc.");
    expect(result.registration_id).toBe("320193");
    expect(result.jurisdiction).toBe("US");
    expect(result.active).toBe(true);
    expect(result.incorporated).toBe("");
    expect(String(result.registered_address)).toContain("ONE APPLE PARK WAY");
    expect(result.state_of_incorporation).toBe("CA");
    const ans = String(result.answer);
    expect(ans).toContain("NOT a legal good-standing");
    expect(ans).toContain("does not carry the incorporation date");
    expect(ans).toContain("US SEC filers only");
    expect(result.confidence).toBe(1.0);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("CORPORATE_REGISTRY_LOOKUP_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const ev = JSON.parse(stored.evidence.toString("utf8"));
    expect(ev.raw_bodies.submissions).toBe(appleSub);
    expect(ev.tickers_sha256).toBe(sha256Hex(tickers));
    expect(ev.resolved_ticker_row).toMatchObject({ ticker: "AAPL", cik_str: 320193 });
  });
  it("resolves a CIK directly and a full title at name confidence", async () => {
    stub();
    const byCik = await handleCorporateRegistry({ company: "320193", jurisdiction: "USA" });
    expect(byCik.legal_name).toBe("Apple Inc.");
    __clearCorporateRegistryCacheForTests();
    const byName = await handleCorporateRegistry({ company: "Apple Inc.", jurisdiction: "United States" });
    expect(byName.legal_name).toBe("Apple Inc.");
    expect(byName.confidence).toBe(0.9);
  });
  it("an ambiguous name is refused, never an arbitrary pick", async () => {
    const twoAcme = JSON.parse(tickers);
    twoAcme["100"] = { cik_str: 1111111, ticker: "ACMA", title: "ACME HOLDINGS INC" };
    twoAcme["101"] = { cik_str: 2222222, ticker: "ACMB", title: "ACME INDUSTRIES CORP" };
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("company_tickers")) return new Response(JSON.stringify(twoAcme), { status: 200 });
      return new Response(appleSub, { status: 200 });
    });
    await expect(handleCorporateRegistry({ company: "Acme", jurisdiction: "US" }))
      .rejects.toMatchObject({ status: 422, code: "AMBIGUOUS_ENTITY" });
  });
  it("an unknown SEC company falls through to an honest GLEIF not_found", async () => {
    stub();
    const out=await handleCorporateRegistry({ company: "ZZQ Nonexistent Holdings", jurisdiction: "US" });
    expect(out.lookup_status).toBe("not_found");expect(out.active).toBeNull();
  });
  it("active=false when the last filing is older than the window", () => {
    const edited = JSON.parse(appleSub);
    edited.filings.recent.filingDate = edited.filings.recent.filingDate.map(() => "2020-01-01");
    const profile = parseSubmissions(JSON.stringify(edited), "0000320193", new Date().toISOString());
    expect(profile.active).toBe(false);
    expect(profile.lastFilingDate).toBe("2020-01-01");
  });
  it("a mismatched CIK in the EDGAR answer is refused", () => {
    const edited = JSON.parse(appleSub);
    edited.cik = "9999999999";
    expect(() => parseSubmissions(JSON.stringify(edited), "0000320193", new Date().toISOString())).toThrow();
  });
  it("fails closed with 502 when SEC_USER_AGENT is unset", async () => {
    const saved = process.env.SEC_USER_AGENT;
    delete process.env.SEC_USER_AGENT;
    try {
      stub();
      await expect(handleCorporateRegistry({ company: "AAPL", jurisdiction: "US" }))
        .rejects.toMatchObject({ status: 502, code: "SEC_USER_AGENT_MISSING" });
    } finally {
      process.env.SEC_USER_AGENT = saved;
    }
  });
  it("an EDGAR outage is an honest 502", async () => {
    stub({ sub: "ERR" });
    await expect(handleCorporateRegistry({ company: "AAPL", jurisdiction: "US" }))
      .rejects.toMatchObject({ status: 502, code: "SEC_UNAVAILABLE" });
  });
  it("GET /v1/corporate-registry is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/corporate-registry" })).toBe(true);
    stub();
    const res = await app.inject({ method: "GET", url: "/v1/corporate-registry?company=AAPL&jurisdiction=US" });
    expect(res.statusCode).toBe(200);
    expect(res.json().legal_name).toBe("Apple Inc.");
    await app.close();
  });
});
