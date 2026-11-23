import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/crypto-price-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handleCryptoPrice } from "../src/handlers/cryptoPrice";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real Coinbase spot bodies, retrieved 2026-11-23.
const eth = readFileSync(join(__dirname, "fixtures/crypto-price/coinbase-eth-spot.json"), "utf8");
const unlisted = readFileSync(join(__dirname, "fixtures/crypto-price/coinbase-unlisted.json"), "utf8");
function stub(body: string | "ERR" = eth, status = 200): void {
  vi.stubGlobal("fetch", async () => {
    if (body === "ERR") throw new Error("test outage");
    return new Response(body, { status });
  });
}
describe("CRYPTO_PRICE_USD", () => {
  it("validates the symbol", async () => {
    await expect(handleCryptoPrice({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    await expect(handleCryptoPrice({ symbol: "x" })).rejects.toMatchObject({ status: 400, code: "BAD_SYMBOL" });
    await expect(handleCryptoPrice({ symbol: "BTC-USD" })).rejects.toMatchObject({ status: 400, code: "BAD_SYMBOL" });
  });
  it("serves the real spot quote, honestly scoped to one named exchange", async () => {
    stub();
    const result = await handleCryptoPrice({ symbol: "eth" });
    expect(result.symbol).toBe("ETH");
    expect(result.price_usd).toBe(1710.305);
    const ans = String(result.answer);
    expect(ans).toContain("Coinbase");
    expect(ans).toContain("not an index or VWAP");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("CRYPTO_PRICE_USD");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
  });
  it("an unlisted symbol is an honest 422 from the source's own 404", async () => {
    stub(unlisted, 404);
    await expect(handleCryptoPrice({ symbol: "ZZQ" }))
      .rejects.toMatchObject({ status: 422, code: "SYMBOL_NOT_LISTED" });
  });
  it("an outage is an honest 502", async () => {
    stub("ERR");
    await expect(handleCryptoPrice({ symbol: "ETH" }))
      .rejects.toMatchObject({ status: 502, code: "COINBASE_UNREACHABLE" });
  });
  it("GET /v1/crypto-price is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/crypto-price" })).toBe(true);
    stub();
    const res = await app.inject({ method: "GET", url: "/v1/crypto-price?symbol=ETH" });
    expect(res.statusCode).toBe(200);
    expect(res.json().price_usd).toBe(1710.305);
    await app.close();
  });
});
