import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/mining-hp-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); resetHashpriceCacheForTests(); });
import { handleMiningHashprice, computeHashprice, parseFees, parseHashrate, subsidyAt, resetHashpriceCacheForTests } from "../src/handlers/miningHashprice";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real mempool.space + Coinbase bodies, retrieved 2026-11-23.
const fx = (n: string) => readFileSync(join(__dirname, "fixtures/mining-hashprice", n), "utf8");
const hr = fx("hashrate-1w.json"), fees = fx("block-fees-1w.json"), tip = fx("tip-height.txt"), spot = fx("coinbase-btc-spot.json");
function stub(opts: { fail?: string } = {}): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (opts.fail && u.includes(opts.fail)) throw new Error("test outage");
    const body = u.includes("hashrate") ? hr : u.includes("fees") ? fees : u.includes("tip") ? tip : spot;
    return new Response(body, { status: 200 });
  });
}
describe("MINING_HASHPRICE_VERIFY_GENERAL", () => {
  it("parses the real series and computes the disclosed formula", () => {
    const meanH = parseHashrate(hr);
    expect(meanH / 1e18).toBeCloseTo(1046.02, 1);
    expect(parseFees(fees)).toBeCloseTo(2188988.25, 0);
    expect(subsidyAt(977127)).toBe(312500000);
    expect(subsidyAt(209999)).toBe(50e8);
    const { sats, usd } = computeHashprice({ tip: 977127, meanHashrateHs: meanH, meanFeesSats: parseFees(fees), subsidySats: 312500000, spotUsd: 60949.245 });
    expect(Math.round(sats * 100) / 100).toBeCloseTo(43321.48, 0);
    expect(Math.round(usd * 100) / 100).toBeCloseTo(26.4, 0);
  });
  it("validates block_height and refuses historical heights honestly", async () => {
    stub();
    await expect(handleMiningHashprice({ block_height: "-1" })).rejects.toMatchObject({ status: 400, code: "BAD_HEIGHT" });
    await expect(handleMiningHashprice({ block_height: "1000000001" })).rejects.toMatchObject({ status: 400, code: "BAD_HEIGHT" });
    await expect(handleMiningHashprice({ block_height: "999999999" })).rejects.toMatchObject({ status: 422, code: "ABOVE_TIP" });
    await expect(handleMiningHashprice({ block_height: "0" })).rejects.toMatchObject({ status: 400, code: "BAD_HEIGHT" });
    const ok = await handleMiningHashprice({ block_height: "977127" });
    expect(ok.block_height).toBe(977127);
  });
  it("serves the receipted answer with the formula disclosed", async () => {
    stub();
    const result = await handleMiningHashprice({});
    expect(Number(result.hashprice_sats_per_ph_day)).toBeCloseTo(43321.48, 0);
    expect(result.hashrate_eh_s).toBeCloseTo(1046.02, 1);
    const ans = String(result.answer);
    expect(ans).toContain("spot hashprice");
    expect(ans).toContain("never a forecast");
    expect(ans).toContain("measured");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("MINING_HASHPRICE_VERIFY_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(JSON.parse(stored.evidence.toString("utf8")).formula).toContain("subsidy");
  });
  it("any missing measured input is an honest 502, never partial math", async () => {
    stub({ fail: "coinbase" });
    await expect(handleMiningHashprice({})).rejects.toMatchObject({ status: 502, code: "UPSTREAM_UNREACHABLE" });
    vi.unstubAllGlobals();
    stub({ fail: "hashrate" });
    await expect(handleMiningHashprice({})).rejects.toMatchObject({ status: 502 });
  });
  it("an out-of-range computation is refused, not served", async () => {
    const tinySpot = JSON.stringify({ data: { amount: "0", base: "BTC", currency: "USD" } });
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      const body = u.includes("hashrate") ? hr : u.includes("fees") ? fees : u.includes("tip") ? tip : tinySpot;
      return new Response(body, { status: 200 });
    });
    await expect(handleMiningHashprice({})).rejects.toMatchObject({ status: 422, code: "NO_USABLE_SPOT" });
  });
  it("GET /v1/mining-hashprice is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/mining-hashprice" })).toBe(true);
    stub();
    const res = await app.inject({ method: "GET", url: "/v1/mining-hashprice" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});


describe("single-block historical hashprice from actual mempool bodies", () => {
  function historicalStub(height: number, fail = false): ReturnType<typeof vi.fn> {
    const fetcher = vi.fn(async (url: unknown) => {
      if (fail) return new Response("unavailable", { status: 503 });
      const u = String(url);
      return new Response(u.includes("tip/height") ? tip : u.includes("block-height") ? fx(`block-${height}-hash.txt`) : u.includes("historical-price") ? fx(`block-${height}-price.json`) : fx(`block-${height}.json`));
    }); vi.stubGlobal("fetch", fetcher); return fetcher;
  }
  it.each([[840000, 948924.85], [900000, 49790.20]])("computes block%s within the measured tolerance", async (height, expected) => {
    const fetcher = historicalStub(height);
    const out = await handleMiningHashprice({ block_height: String(height) });
    expect(Number(out.hashprice_sats_per_ph_day) / expected).toBeCloseTo(1, 2);
    const block = JSON.parse(fx(`block-${height}.json`));
    const exact = block.extras.reward * 144 * 1e15 / (block.difficulty * 2 ** 32 / 600);
    expect(out.hashprice_sats_per_ph_day).toBe(Math.round(exact * 100) / 100);
    expect(out.answer).toContain("single-block reward"); expect(out.answer).toContain("not a weekly average");
    const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
    const stored = await getReceiptEvidence(receipt.receipt_id); expect(sha256Hex(stored.evidence!)).toBe(receipt.raw_response_sha256);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await handleMiningHashprice({ block_height: String(height) }); expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it("historical upstream503 is disclosed503", async () => {
    historicalStub(840000, true);
    await expect(handleMiningHashprice({ block_height: "840000" })).rejects.toMatchObject({ status: 503, code: "UPSTREAM_UNREACHABLE" });
  });
});
it("historical cache reuses at59s and expires at60s",async()=>{
 const now=Date.now();const spy=vi.spyOn(Date,"now").mockReturnValue(now);
 const f=vi.fn(async(u:unknown)=>new Response(String(u).includes("tip/height")?tip:String(u).includes("block-height")?fx("block-840000-hash.txt"):String(u).includes("historical-price")?fx("block-840000-price.json"):fx("block-840000.json")));vi.stubGlobal("fetch",f);
 try{await handleMiningHashprice({block_height:"840000"});expect(f).toHaveBeenCalledTimes(4);
 spy.mockReturnValue(now+59000);await handleMiningHashprice({block_height:"840000"});expect(f).toHaveBeenCalledTimes(5);
 spy.mockReturnValue(now+60000);await handleMiningHashprice({block_height:"840000"});expect(f).toHaveBeenCalledTimes(9);
 }finally{spy.mockRestore()}
});
