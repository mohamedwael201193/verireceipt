import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/financial-market-cache-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
import { handleFinancialData } from "../src/handlers/financialData";
import { resetMarketCacheForTests } from "../src/handlers/marketSourceCache";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
const raw = readFileSync(join(__dirname, "fixtures/financial-data/coingecko-eth-sol.json"), "utf8");
const data = JSON.parse(raw);
const start = data.ethereum.last_updated_at * 1000 + 1000;
beforeEach(() => { resetMarketCacheForTests(); vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); resetMarketCacheForTests(); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
const load = (status = 200, body = raw) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
const eth = () => handleFinancialData({ asset: "ETH" });
describe("bounded market observation cache", () => {
  it("reuses a validated observation for under30s across aliases, preserving raw bytes/acquisition", async () => {
    load(); const a = await eth(); vi.setSystemTime(start + 29999);
    const b = await handleFinancialData({ asset: "Ethereum" }); expect(fetch).toHaveBeenCalledTimes(1);
    expect(b.stale).toBe(false); expect((b.receipt as any).fetched_at).toBe((a.receipt as any).fetched_at);
  });
  for (const status of [429, 500, 502, 503, 599]) {
    it(`discloses HTTP${status} fallback without changing source values or timestamps`, async () => {
      load(); const a = await eth(); vi.setSystemTime(start + 30000); load(status);
      const b = await eth(); expect(b.stale).toBe(true); expect(b.verdict).toBe("stale");
      expect(b.confidence).toBe(0.5); expect(String(b.answer)).toMatch(/^STALE CACHED OBSERVATION/);
      expect(b.market_cap_usd).toBe(a.market_cap_usd); expect(b.volume_24h_usd).toBe(a.volume_24h_usd); expect(b.as_of).toBe(a.as_of);
      const r = b.receipt as any; expect(r.fetched_at).toBe((a.receipt as any).fetched_at);
      const ev = (await getReceiptEvidence(r.receipt_id)).evidence!;
      expect(sha256Hex(ev)).toBe(r.raw_response_sha256); const j = JSON.parse(ev.toString());
      expect(j.raw_bodies.coingecko).toBe(raw); expect(j.stale_reason).toContain(`HTTP ${status}`);
      expect(j.attempted_at).toBe(new Date(start + 30000).toISOString());
    });
  }
  it("times out after6s and serves eligible prior evidence, never a late result", async () => {
    load(); await eth(); vi.setSystemTime(start + 30000);
    vi.stubGlobal("fetch", () => new Promise(() => {})); const p = eth(); await vi.advanceTimersByTimeAsync(6000);
    expect((await p).stale).toBe(true);
  });
  it("does not mask a non-timeout transport failure", async () => {
    load(); await eth(); vi.setSystemTime(start + 30000); vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    await expect(eth()).rejects.toMatchObject({ status: 502 });
  });
  for (const status of [400, 401, 403, 404]) {
    it(`does not mask HTTP${status}`, async () => {
      load(); await eth(); vi.setSystemTime(start + 30000); load(status); await expect(eth()).rejects.toMatchObject({ status: 502 });
    });
  }
  it("does not mask a malformed successful body or replace the good cache", async () => {
    load(); await eth(); vi.setSystemTime(start + 30000); load(200, "invalid-json");
    await expect(eth()).rejects.toMatchObject({ code: "BAD_MARKET_DATA" }); load(502); expect((await eth()).stale).toBe(true);
  });
  it("requires both source and acquisition age <=5min, with no lifetime extension", async () => {
    load(); await eth(); load(502); vi.setSystemTime(start + 298999); expect((await eth()).stale).toBe(true);
    vi.setSystemTime(start + 299001); await expect(eth()).rejects.toMatchObject({ status: 502 });
  });
  it("does not use a recent acquisition to renew a source update older than5min", async () => {
    vi.setSystemTime(start + 300000); load(); await eth(); vi.setSystemTime(start + 330000); load(502);
    await expect(eth()).rejects.toMatchObject({ status: 502 });
  });
  it("does not serve a future cached source timestamp after clock rollback", async () => {
    load(); await eth(); vi.setSystemTime(start - 5000); load(502); await expect(eth()).rejects.toMatchObject({ status: 502 });
  });
  it("never substitutes ETH for SOL and refuses cold failures", async () => {
    load(); await eth(); load(502); await expect(handleFinancialData({ asset: "SOL" })).rejects.toMatchObject({ status: 502 });
  });
  it("single-flights concurrent reads by canonical identity", async () => {
    load(); const [a,b] = await Promise.all([eth(),handleFinancialData({ asset: "Ethereum" })]);
    expect(fetch).toHaveBeenCalledTimes(1); expect(a.market_cap_usd).toBe(b.market_cap_usd);
  });
  it("rejects an oversized successful body rather than serving stale", async () => {
    load(); await eth(); vi.setSystemTime(start + 30000); load(200, " ".repeat(65537));
    await expect(eth()).rejects.toMatchObject({ status: 502 });
  });
  it("never caches a response that arrives after the deadline", async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
    const p = eth(); const caught = expect(p).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(6000); await caught; finish(new Response(raw));
    await Promise.resolve(); await Promise.resolve(); load(502);
    await expect(eth()).rejects.toMatchObject({ status: 502 });
  });
  it("fresh reuse expires exactly at30s and does not extend when accessed", async () => {
    load(); await eth(); vi.setSystemTime(start + 29999); await eth();
    vi.setSystemTime(start + 30000); await eth(); expect(fetch).toHaveBeenCalledTimes(2);
  });

});
