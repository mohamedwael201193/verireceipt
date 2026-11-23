import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/stock-price-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); });
import { handleStockPrice, parseYahooChart } from "../src/handlers/stockPrice";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/stock-price", name), "utf8");
// Real Yahoo chart API bodies, retrieved 2026-11-23.
const aapl = fixture("yahoo-chart-aapl.json");
const unknown = fixture("yahoo-chart-unknown.json");
function stub(body: string | null): void {
  vi.stubGlobal("fetch", async () => {
    if (body === null) throw new Error("test source outage");
    return new Response(body, { status: 200 });
  });
}
describe("STOCK_PRICE_US_EQUITY", () => {
  it("validates before fetching", async () => {
    await expect(handleStockPrice({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    for (const t of ["AAPL;DROP", "TOOLONGTICKER", "1234"]) {
      await expect(handleStockPrice({ ticker: t })).rejects.toMatchObject({ status: 400, code: "INVALID_TICKER" });
    }
  });
  it("serves the real Yahoo quote, delay-labelled, with a receipt over the exact body", async () => {
    stub(aapl);
    const result = await handleStockPrice({ ticker: "aapl" });
    expect(result.ticker).toBe("AAPL");
    expect(result.price_usd).toBe(342.56);
    expect(result.exchange).toBe("NasdaqGS");
    expect(result.market_time).toBe(new Date(1795208402 * 1000).toISOString());
    expect(String(result.answer)).toContain("may be delayed");
    expect(String(result.answer)).toContain("NOT a guaranteed real-time quote");
    expect(result.confidence).toBe(0.9);
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("STOCK_PRICE_US_EQUITY");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(JSON.parse(stored.evidence.toString("utf8")).raw_body).toBe(aapl);
  });
  it("accepts BRK.B and asks Yahoo for BRK-B, refusing a mismatched answer", () => {
    const b = JSON.parse(aapl);
    b.chart.result[0].meta.symbol = "BRK-B";
    const q = parseYahooChart(JSON.stringify(b), "BRK-B");
    expect(q.symbol).toBe("BRK-B");
    try { parseYahooChart(aapl, "MSFT"); throw new Error("should have thrown"); }
    catch (e) { expect((e as { code?: string }).code).toBe("TICKER_NOT_FOUND"); }
  });
  it("an unknown or delisted ticker is 422, never an invented price", async () => {
    stub(unknown);
    await expect(handleStockPrice({ ticker: "ZZZQ" })).rejects.toMatchObject({ status: 422, code: "TICKER_NOT_FOUND" });
  });
  it("non-equity or non-USD instruments are out of scope", () => {
    const b = JSON.parse(aapl);
    b.chart.result[0].meta.instrumentType = "CRYPTOCURRENCY";
    b.chart.result[0].meta.currency = "USD";
    for (const edit of [b]) {
      try { parseYahooChart(JSON.stringify(edit), "AAPL"); throw new Error("should have thrown"); }
      catch (e) { expect((e as { code?: string }).code).toBe("NOT_US_EQUITY"); }
    }
    b.chart.result[0].meta.instrumentType = "EQUITY";
    b.chart.result[0].meta.currency = "EUR";
    try { parseYahooChart(JSON.stringify(b), "AAPL"); throw new Error("should have thrown"); }
    catch (e) { expect((e as { code?: string }).code).toBe("NOT_US_EQUITY"); }
  });
  it("a missing price is 422, an out-of-contract-range price is refused", () => {
    const b = JSON.parse(aapl);
    delete b.chart.result[0].meta.regularMarketPrice;
    try { parseYahooChart(JSON.stringify(b), "AAPL"); throw new Error("should have thrown"); }
    catch (e) { expect((e as { code?: string }).code).toBe("NO_USABLE_PRICE"); }
    b.chart.result[0].meta.regularMarketPrice = 0;
    try { parseYahooChart(JSON.stringify(b), "AAPL"); throw new Error("should have thrown"); }
    catch (e) { expect((e as { code?: string }).code).toBe("NO_USABLE_PRICE"); }
  });
  it("a Yahoo outage is an honest 502", async () => {
    stub(null);
    await expect(handleStockPrice({ ticker: "AAPL" })).rejects.toMatchObject({ status: 502, code: "YAHOO_UNREACHABLE" });
  });
  it("GET /v1/stock-price is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/stock-price" })).toBe(true);
    stub(aapl);
    const res = await app.inject({ method: "GET", url: "/v1/stock-price?ticker=AAPL" });
    expect(res.statusCode).toBe(200);
    expect(res.json().price_usd).toBe(342.56);
    await app.close();
  });
});
