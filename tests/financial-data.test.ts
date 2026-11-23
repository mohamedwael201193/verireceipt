import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/financial-data-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
beforeAll(() => { process.env.SEC_USER_AGENT = "VeriReceipt tests contact@example.com"; });
afterAll(() => { delete process.env.SEC_USER_AGENT; rmSync(scratch, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllGlobals());
import { handleFinancialData, btcSupplyAtHeight, latestShares } from "../src/handlers/financialData";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real bodies retrieved 2026-11-23: SEC companyconcept AAPL shares
// (14,532,182,000 as of 2026-10-23, 10-K filed 2026-11-03), Yahoo chart
// AAPL ($342.56), mempool tip (977129), Coinbase BTC spot ($60970.905).
const tickers = readFileSync(join(__dirname, "fixtures/corporate-registry/company-tickers-excerpt.json"), "utf8");
const shares = readFileSync(join(__dirname, "fixtures/financial-data/sec-aapl-shares.json"), "utf8");
const chart = readFileSync(join(__dirname, "fixtures/financial-data/yahoo-chart-aapl.json"), "utf8");
const tip = readFileSync(join(__dirname, "fixtures/financial-data/mempool-tip.txt"), "utf8");
const btcSpot = readFileSync(join(__dirname, "fixtures/financial-data/coinbase-btc-usd.json"), "utf8");
function stub(opts: { secDown?: boolean; btcDown?: boolean } = {}): void {
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    if (u.includes("sec.gov")) {
      if (opts.secDown) throw new Error("sec outage");
      return new Response(u.includes("companyconcept") ? shares : tickers, { status: 200 });
    }
    if (u.includes("yahoo")) return new Response(chart, { status: 200 });
    if (u.includes("mempool.space")) {
      if (opts.btcDown) throw new Error("tip outage");
      return new Response(tip, { status: 200 });
    }
    if (u.includes("coinbase")) return new Response(btcSpot, { status: 200 });
    throw new Error(`unexpected ${u}`);
  });
}
describe("FINANCIAL_DATA_GENERAL", () => {
  it("requires an asset and refuses unsupported ones honestly", async () => {
    await expect(handleFinancialData({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    stub();
    await expect(handleFinancialData({ asset: "ZZZZ9!" })).rejects.toMatchObject({ status: 422, code: "UNSUPPORTED_ASSET" });
    await expect(handleFinancialData({ asset: "ETH" })).rejects.toMatchObject({ status: 422, code: "UNSUPPORTED_ASSET" });
  });
  it("BTC cap is the Coinbase spot x the emission-schedule supply at the tip", async () => {
    stub();
    const result = await handleFinancialData({ asset: "btc" });
    const supply = btcSupplyAtHeight(977129);
    expect(supply).toBe(20116031.25);
    expect(result.market_cap_usd).toBe(Math.round(60970.905 * supply));
    expect(result.volume_24h_usd).toBeNull();
    const ans = String(result.answer);
    expect(ans).toContain("derived");
    expect(ans).toContain("not served");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("FINANCIAL_DATA_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
  });
  it("a US equity cap is price x SEC shares outstanding, derivation disclosed", async () => {
    stub();
    const result = await handleFinancialData({ asset: "aapl" });
    expect(result.asset).toBe("AAPL");
    expect(result.market_cap_usd).toBe(Math.round(342.56 * 14532182000));
    expect(result.volume_24h_usd).toBeNull(); // rolling 24h is not served from a session figure
    const ans = String(result.answer);
    expect(ans).toContain("shares outstanding reported to the SEC as of 2026-10-23");
    expect(ans).toContain("derived");
    expect(ans).toContain("may be delayed");
    expect(ans).toContain("Rolling 24h USD volume is not served");
    expect((result.metrics as string[]).join(" ")).toContain("latest_regular_session_volume_usd=27642038215");
  });
  it("latestShares picks the most recent reporting date", () => {
    const s = latestShares(shares);
    expect(s.val).toBe(14532182000);
    expect(s.end).toBe("2026-10-23");
  });
  it("an SEC outage is a typed 502, never a guessed figure", async () => {
    stub({ secDown: true });
    await expect(handleFinancialData({ asset: "AAPL" })).rejects.toMatchObject({ status: 502, code: "SEC_UNAVAILABLE" });
  });
  it("a BTC source outage is a typed 502", async () => {
    stub({ btcDown: true });
    await expect(handleFinancialData({ asset: "BTC" })).rejects.toMatchObject({ status: 502, code: "SOURCE_UNREACHABLE" });
  });
  it("GET /v1/financial-data is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/financial-data" })).toBe(true);
    await app.close();
  });
});
