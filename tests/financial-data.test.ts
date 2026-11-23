import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/financial-data-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
beforeAll(() => { process.env.SEC_USER_AGENT = "VeriReceipt tests contact@example.com"; });
afterAll(() => { delete process.env.SEC_USER_AGENT; rmSync(scratch, { recursive: true, force: true }); });
afterEach(() => { resetMarketCacheForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); });
import { handleFinancialData, btcSupplyAtHeight, latestShares, resolveSec } from "../src/handlers/financialData";
import { resetMarketCacheForTests } from "../src/handlers/marketSourceCache";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real bodies retrieved 2026-11-23: SEC companyconcept AAPL shares
// (14,532,182,000 as of 2026-10-23, 10-K filed 2026-11-03), Yahoo chart
// AAPL ($342.56), mempool tip (977129), Coinbase BTC spot ($60970.905).
const tickers = readFileSync(join(__dirname, "fixtures/corporate-registry/company-tickers-excerpt.json"), "utf8");
const shares = readFileSync(join(__dirname, "fixtures/financial-data/sec-aapl-shares.json"), "utf8");
const chart = readFileSync(join(__dirname, "fixtures/financial-data/yahoo-chart-aapl.json"), "utf8");
const crypto = readFileSync(join(__dirname, "fixtures/financial-data/paprika-eth-ethereum.json"), "utf8");
const sol = readFileSync(join(__dirname, "fixtures/financial-data/paprika-sol-solana.json"), "utf8");
const tip = readFileSync(join(__dirname, "fixtures/financial-data/mempool-tip.txt"), "utf8");
const btcSpot = readFileSync(join(__dirname, "fixtures/financial-data/coinbase-btc-usd.json"), "utf8");
function stub(opts: { secDown?: boolean; btcDown?: boolean } = {}): void {
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    if (u.includes("coinpaprika")) return new Response(u.endsWith("sol-solana") ? sol : crypto, { status: 200 });
    if (u.includes("finance/search")) return new Response(JSON.stringify({ quotes: [] }), { status: 200 });
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
    expect(result.asset_type).toBe("equity"); expect(result.symbol).toBe("AAPL"); expect(result.name).toBe("Apple Inc.");
    expect(result).not.toHaveProperty("pe_ratio"); expect(String(result.answer)).toContain("P/E, revenue, net income and EPS are not served");
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


describe("financial name resolution and aggregated crypto", () => {
  it("resolves SEC company names and suffixes without fuzzy guesses", () => {
    const entries = Object.values(JSON.parse(tickers));
    expect(resolveSec(entries, "Apple")?.ticker).toBe("AAPL");
    expect(resolveSec(entries, "Microsoft")?.ticker).toBe("MSFT");
    expect(resolveSec(entries, "Apple Inc.")?.ticker).toBe("AAPL");
    expect(resolveSec(entries, "Apple Banana")).toBeUndefined();
    expect(() => resolveSec([{ ticker: "AAA", title: "Acme Inc." }, { ticker: "BBB", title: "Acme Corp" }], "Acme"))
      .toThrow("multiple SEC entries");
  });
  it("Apple resolves to AAPL without changing its recorded cap derivation", async () => {
    stub();
    const r = await handleFinancialData({ asset: "Apple" });
    expect(r.asset).toBe("AAPL");
    expect(r.resolved_name).toBe("Apple Inc.");
    expect(r.market_cap_usd).toBe(4978144265920);
    expect(r.volume_24h_usd).toBeNull();
  });
  for (const asset of ["ETH", "Ethereum", "Solana", "SOL"]) {
    it(`serves aggregated cap and rolling 24h volume for ${asset}`, async () => {
      stub();
      const id = asset.toLowerCase().startsWith("sol") ? "solana" : "ethereum";
      const data = JSON.parse(id === "solana" ? sol : crypto);
      vi.useFakeTimers(); vi.setSystemTime(new Date(Date.parse(data.last_updated) + 1000));
      const r = await handleFinancialData({ asset });
      expect(r.market_cap_usd).toBe(data.quotes.USD.market_cap);
      expect(r.asset_type).toBe("crypto"); expect(r.symbol).toBe(id==="ethereum"?"ETH":"SOL"); expect(r.name).toBe(id==="ethereum"?"Ethereum":"Solana");
      expect(r.volume_24h_usd).toBe(data.quotes.USD.volume_24h);
      expect(String(r.answer)).toContain("CoinPaprika aggregated");
      expect(String(r.answer)).toContain("not the derived BTC");
      const receipt = r.receipt as { receipt_id: string; raw_response_sha256: string };
      const ev = await getReceiptEvidence(receipt.receipt_id);
      expect(sha256Hex(ev.evidence!)).toBe(receipt.raw_response_sha256);
      expect(JSON.parse(ev.evidence!.toString()).raw_bodies.coinpaprika).toBe(id === "solana" ? sol : crypto);
    });
  }
  it("rejects stale crypto market data instead of relabeling it as current", async () => {
    stub();
    vi.useFakeTimers(); vi.setSystemTime(new Date(Date.parse(JSON.parse(crypto).last_updated) + 86400001));
    await expect(handleFinancialData({ asset: "ETH" })).rejects.toMatchObject({ status: 502, code: "BAD_MARKET_DATA" });
  });
  it("fails closed when a crypto field is missing", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"ethereum":{"market_cap":10}}'));
    await expect(handleFinancialData({ asset: "ETH" })).rejects.toMatchObject({ status: 502, code: "BAD_MARKET_DATA" });
  });
});


describe("Yahoo equity discovery remains SEC-bound", () => {
  function discovery(quotes: unknown[]) {
    vi.stubGlobal("fetch", async (input: unknown) => {
      const u = String(input);
      if (u.includes("company_tickers")) return new Response(tickers);
      if (u.includes("finance/search")) return new Response(JSON.stringify({ quotes }));
      if (u.includes("companyconcept")) return new Response(shares);
      if (u.includes("finance/chart")) return new Response(chart);
      throw new Error("unexpected source");
    });
  }
  it("uses a matched search alias only for an SEC-listed ticker and binds the body", async () => {
    discovery([{ symbol: "AAPL", quoteType: "EQUITY", shortname: "Apple Computers" }]);
    const r = await handleFinancialData({ asset: "Apple Computers" });
    expect(r.asset).toBe("AAPL");
    const ev = await getReceiptEvidence((r.receipt as { receipt_id: string }).receipt_id);
    expect(JSON.parse(ev.evidence!.toString()).raw_bodies.yahoo_search).toContain("Apple Computers");
  });
  it("does not choose between multiple matching SEC listings", async () => {
    discovery([{ symbol: "AAPL", quoteType: "EQUITY", shortname: "Ambiguous" }, { symbol: "MSFT", quoteType: "EQUITY", shortname: "Ambiguous" }]);
    await expect(handleFinancialData({ asset: "Ambiguous" })).rejects.toMatchObject({ code: "AMBIGUOUS_ASSET" });
  });
  it("refuses a search result absent from the SEC index", async () => {
    discovery([{ symbol: "ZZZ", quoteType: "EQUITY", shortname: "Unknown" }]);
    await expect(handleFinancialData({ asset: "Unknown" })).rejects.toMatchObject({ code: "UNSUPPORTED_ASSET" });
  });
});


describe("financial fail-closed boundaries", () => {
  for (const [label, key, value] of [
    ["future update", "last_updated", "2099-01-01T00:00:00Z"],
    ["cap above contract range", "market_cap", 1000000000000001],
    ["negative volume", "volume_24h", -1],
    ["zero cap", "market_cap", 0],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const d = JSON.parse(crypto);
      vi.useFakeTimers(); vi.setSystemTime(new Date(Date.parse(d.last_updated) + 1000));
      if(key === "last_updated") d.last_updated = value; else d.quotes.USD[key] = value;
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify(d)));
      await expect(handleFinancialData({ asset: "ETH" })).rejects.toMatchObject({ status: 502, code: "BAD_MARKET_DATA" });
    });
  }
  for (const source of ["company_tickers", "companyconcept", "finance/chart"]) {
    it(`malformed ${source} is a disclosed 502`, async () => {
      vi.stubGlobal("fetch", async (input: unknown) => {
        const u = String(input);
        if (u.includes(source)) return new Response("not-json");
        return new Response(u.includes("company_tickers") ? tickers : u.includes("companyconcept") ? shares : chart);
      });
      await expect(handleFinancialData({ asset: "AAPL" })).rejects.toMatchObject({ status: 502 });
    });
  }
});


describe("SEC ticker container validation", () => {
 for (const body of ["null", "[]", "{}", '{"0":null}', '{"0":"invalid"}']) {
  it(`rejects invalid ticker container ${body}`, async () => {
   vi.stubGlobal("fetch", async () => new Response(body));
   await expect(handleFinancialData({ asset: "AAPL" })).rejects.toMatchObject({ status:502, code:"SEC_MALFORMED" });
  });
 }
});

describe('CoinPaprika source identity and receipt scope',()=>{
 it.each([{id:'sol-solana'},{symbol:'SOL'},{id:null},{symbol:null}])('refuses wrong/missing identity: %j',async change=>{
  const d={...JSON.parse(crypto),...change};vi.useFakeTimers();vi.setSystemTime(Date.parse(d.last_updated)+1000);
  vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(d)));
  await expect(handleFinancialData({asset:'ETH'})).rejects.toMatchObject({code:'BAD_MARKET_DATA'});
 });
 it('uses only the bound keyless ticker and preserves the dated risk record, not a licence grant',async()=>{
  vi.useFakeTimers();vi.setSystemTime(Date.parse(JSON.parse(crypto).last_updated)+1000);
  const urls:string[]=[];vi.stubGlobal('fetch',async(u:unknown)=>{urls.push(String(u));return new Response(crypto);});
  const r=await handleFinancialData({asset:'ETH'});expect(urls).toEqual(['https://api.coinpaprika.com/v1/tickers/eth-ethereum']);
  const ev=JSON.parse((await getReceiptEvidence((r.receipt as any).receipt_id)).evidence!);
  expect(ev.raw_bodies.coinpaprika).toBe(crypto);expect(ev.terms.commercialUse).toBe(false);expect(ev.terms.redistribution).toBe(false);
  expect(ev.terms.ownerRiskAcceptance.acceptedAt).toBe('2026-11-23');expect(ev.attribution).toBe('Data by CoinPaprika');
 });
});
