vi.mock('../src/handlers/equityVolume',()=>({equityVolumeFromObservation:()=>({value_usd:null,basis:'unavailable',status:'unavailable',raw_body:null,window_start:null,window_end:null,fetched_at:null})}));
import {resetSecFinancialCacheForTests} from '../src/handlers/secFinancialCache';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/financial-data-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
beforeAll(() => { process.env.SEC_USER_AGENT = "VeriReceipt tests contact@example.com"; });
afterAll(() => { delete process.env.SEC_USER_AGENT; rmSync(scratch, { recursive: true, force: true }); });
afterEach(() => { resetSecFinancialCacheForTests(); resetEquityCacheForTests(); resetMarketCacheForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); });
import { handleFinancialData, btcSupplyAtHeight, latestShares, resolveSec } from "../src/handlers/financialData";
import { resetEquityCacheForTests } from "../src/handlers/equityQuoteCache";
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
    expect(await handleFinancialData({asset:"ZZZZ9!"})).toMatchObject({verdict:"no_data",market_cap_usd:null,reason_code:"unsupported_asset"});

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
    expect(result).not.toHaveProperty("pe_ratio"); expect(String(result.answer)).toContain("Annual SEC revenue, net income and total assets");
    expect(result.market_cap_usd).toBe(Math.round(342.56 * 14532182000));
    expect(result.volume_24h_usd).toBeNull(); // rolling 24h is not served from a session figure
    const ans = String(result.answer);
    expect(ans).toContain("shares outstanding reported to the SEC as of 2026-10-23");
    expect(ans).toContain("derived");
    expect(ans).toContain("may be delayed");
    expect(ans).toContain("Trailing24h bucket estimate unavailable");
    expect(result.metrics).toContain("latest_regular_session.volume_usd_estimate=27642038215");
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
  it("non-SEC search match without valid identity-bound records refuses", async () => {
    discovery([{ symbol: "ZZZ", quoteType: "EQUITY", shortname: "Unknown" }]);
    await expect(handleFinancialData({ asset: "Unknown" })).rejects.toMatchObject({ code: "SOURCE_UNREACHABLE" });
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
it('SEC warm cache preserves original bytes/time, avoids repeated SEC requests, UA remains required',async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));const calls:string[]=[];vi.stubGlobal('fetch',async(url:any)=>{calls.push(String(url));return new Response(String(url).includes('company_tickers')?tickers:String(url).includes('companyconcept')?shares:chart);});const first=await handleFinancialData({asset:'AAPL'});vi.advanceTimersByTime(60000);const second=await handleFinancialData({asset:'AAPL'});expect(calls.filter(u=>u.includes('sec.gov')&&!u.includes('us-gaap'))).toHaveLength(2);expect(second.sec_observations).toEqual(first.sec_observations);expect(String(second.answer)).toContain('Mixed-age derivation');const ev=JSON.parse((await getReceiptEvidence((second.receipt as any).receipt_id)).evidence!.toString());expect(ev.raw_bodies.company_tickers).toBe(tickers);expect(ev.raw_bodies.sec_shares).toBe(shares);expect(ev.sec_observations).toEqual(first.sec_observations);delete process.env.SEC_USER_AGENT;await expect(handleFinancialData({asset:'AAPL'})).rejects.toMatchObject({code:'SEC_USER_AGENT_MISSING'});process.env.SEC_USER_AGENT='VeriReceipt tests contact@example.com';});
it.each([['cik',999999],['taxonomy','us-gaap'],['tag','WrongSharesTag']])('wrong shares %s refuses and valid same-key retry proves no cache poisoning',async(field,value)=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));let valid=false,shareReads=0;const wrong={...JSON.parse(shares),[field]:value};vi.stubGlobal('fetch',async(url:any)=>{if(String(url).includes('company_tickers'))return new Response(tickers);if(String(url).includes('/dei/')){shareReads++;return new Response(valid?shares:JSON.stringify(wrong));}return new Response(chart);});await expect(handleFinancialData({asset:'AAPL'})).rejects.toMatchObject({status:502,code:'SOURCE_UNREACHABLE'});valid=true;const out=await handleFinancialData({asset:'AAPL'});expect(out.asset).toBe('AAPL');expect(out.market_cap_usd).toBeGreaterThan(0);expect(shareReads).toBe(2);});
it('abort-ignoring SEC index completing after deadline neither answers nor poisons1hour cache',async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));let first=true;let release!:(r:Response)=>void;let indexReads=0;vi.stubGlobal('fetch',async(url:any)=>{if(String(url).includes('company_tickers')){indexReads++;if(first){first=false;return new Promise<Response>(r=>release=r);}return new Response(tickers);}return new Response(String(url).includes('companyconcept')?shares:chart);});const request=expect(handleFinancialData({asset:'AAPL'})).rejects.toMatchObject({code:'SEC_UNAVAILABLE'});await vi.advanceTimersByTimeAsync(10000);await request;release(new Response(tickers));await vi.advanceTimersByTimeAsync(1);expect((await handleFinancialData({asset:'AAPL'})).asset).toBe('AAPL');expect(indexReads).toBe(2);});
it.each(['BTC','AAPL','ETH'])('contract metrics string on real captured %s HTTP success, cap/volume/evidence unchanged',async asset=>{
 stub();if(asset==='ETH'){vi.useFakeTimers();vi.setSystemTime(new Date(Date.parse(JSON.parse(crypto).last_updated)+1000));}
 const app=buildServer();try{const response=await app.inject({method:'GET',url:'/v1/financial-data?asset='+asset});expect(response.statusCode).toBe(200);const r=response.json();expect(typeof r.metrics).toBe('string');expect(r.metrics.length).toBeGreaterThan(0);const receipt=r.receipt,ev=await getReceiptEvidence(receipt.receipt_id);expect(sha256Hex(ev.evidence!)).toBe(receipt.raw_response_sha256);const evidence=JSON.parse(ev.evidence!.toString());expect(evidence.market_cap_usd).toBe(r.market_cap_usd);if(asset==='BTC'){expect(r.metrics).toBe('supply_btc=20116031.25 at tip 977129; spot_usd=60970.905; derivation=spot x emission-schedule supply');expect(r.volume_24h_usd).toBeNull();}else if(asset==='AAPL'){expect(r.structured_metrics.latest_regular_session.volume_usd_estimate).toBe(27642038215);expect(r.structured_metrics.latest_regular_session.method).toContain('NOT actual traded-dollar turnover');expect(r.volume_24h_usd).toBeNull();}else{expect(r.metrics).toBe('methodology=CoinPaprika aggregated market cap and rolling 24h volume');expect(r.volume_24h_usd).toBe(JSON.parse(crypto).quotes.USD.volume_24h);}}
 finally{await app.close();}
});
