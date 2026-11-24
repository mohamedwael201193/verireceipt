import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/payment-method-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
import { handlePaymentMethod, resetBinCacheForTests } from "../src/handlers/paymentMethod";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

// Fixtures are real binlist.net bodies retrieved 2026-11-23.
const FX = join(__dirname, "fixtures/payment-method");
const BIN_424242 = readFileSync(join(FX, "binlist-424242.json"), "utf8");
const BIN_45717360 = readFileSync(join(FX, "binlist-45717360.json"), "utf8");

function stub(opts: { status?: number; down?: boolean } = {}): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    requested.push(u);
    if (u.includes("api.dharun.dev")) { if (opts.down || opts.status === 429 || opts.status === 500) throw new Error("open source outage"); return new Response("{}", { status: 404 }); }
    if (u.includes("lookup.binlist.net")) {
      if (opts.down) throw new Error("binlist outage");
      const status = opts.status ?? (u.includes("424242") || u.includes("45717360") ? 200 : 404);
      if (status !== 200) return new Response("", { status });
      return new Response(u.includes("45717360") ? BIN_45717360 : BIN_424242, { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return requested;
}
beforeEach(() => resetBinCacheForTests());

describe("PAYMENT_METHOD_VERIFY_GENERAL", () => {
  it("a known BIN answers valid=true with network, bank and country, scoping the claim", async () => {
    stub();
    const result = await handlePaymentMethod({ bin: "424242" });
    expect(result.valid).toBe(true);
    expect(result.network).toBe("visa");
    expect(result.card_type).toBe("credit");
    expect(String(result.issuing_bank)).toContain("Stripe");
    expect(String(result.answer)).toContain("allocated, known card prefix");
    expect(String(result.answer)).toContain("no checksum");
  });
  it("an 8-digit BIN is accepted and resolved", async () => {
    stub();
    const result = await handlePaymentMethod({ bin: "45717360" });
    expect(result.valid).toBe(true);
    expect(String(result.issuing_bank)).toContain("Jyske");
    expect(result.card_type).toBe("debit");
  });
  it("an unknown BIN answers valid=false, named as 'no record', not proof of non-allocation", async () => {
    stub();
    const result = await handlePaymentMethod({ bin: "000000" });
    expect(result.valid).toBe(false);
    expect(String(result.answer)).toContain("No record");
    expect(String(result.answer)).toContain("not proof the prefix is unallocated");
  });
  it("a full card number or a short prefix is refused 400 (BIN only, 6-8 digits)", async () => {
    stub();
    await expect(handlePaymentMethod({ bin: "4242424242424242" })).rejects.toMatchObject({ status: 400, code: "INVALID_BIN" });
    await expect(handlePaymentMethod({ bin: "42424" })).rejects.toMatchObject({ status: 400, code: "INVALID_BIN" });
    await expect(handlePaymentMethod({ bin: "abcdef" })).rejects.toMatchObject({ status: 400 });
    await expect(handlePaymentMethod({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
  });
  it("fails closed 502 on outage, 429 and 5xx — never a throttled guess", async () => {
    stub({ down: true });
    await expect(handlePaymentMethod({ bin: "424242" })).rejects.toMatchObject({ status: 502, code: "BIN_SOURCES_UNAVAILABLE" });
    stub({ status: 429 });
    await expect(handlePaymentMethod({ bin: "424242" })).rejects.toMatchObject({ status: 502, code: "BIN_SOURCES_UNAVAILABLE" });
    stub({ status: 500 });
    await expect(handlePaymentMethod({ bin: "424242" })).rejects.toMatchObject({ status: 502, code: "BIN_SOURCES_UNAVAILABLE" });
  });
  it("the second lookup for the same BIN is served from cache (rate-limit respect) and says so", async () => {
    const requested = stub();
    await handlePaymentMethod({ bin: "424242" });
    const result = await handlePaymentMethod({ bin: "424242" });
    expect(requested.filter((u) => u.includes("424242"))).toHaveLength(2);
    expect(String(result.answer)).toContain("cache");
  });
  it("the receipt is persisted and the exact upstream body is embedded", async () => {
    stub();
    const result = await handlePaymentMethod({ bin: "424242" });
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("PAYMENT_METHOD_VERIFY_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    expect(String(stored.evidence)).toContain("Stripe Payments Uk Limited");
    expect(String(stored.evidence)).toContain("no checksum");
  });
  it("GET /v1/payment-method is wired and returns the envelope", async () => {
    stub();
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/payment-method?bin=424242" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { receipt: { intent: string }; valid: boolean };
    expect(body.receipt.intent).toBe("PAYMENT_METHOD_VERIFY_GENERAL");
    expect(body.valid).toBe(true);
    await app.close();
  });
});

it("treats actual empty200 binlist record as no record, retaining exact source bytes", async () => {
  const raw = readFileSync(join(FX, "binlist-empty-999999.json"), "utf8");
  const fetcher = vi.fn(async (url: unknown) => String(url).includes("api.dharun.dev") ? new Response("{}", { status: 404 }) : new Response(raw)); vi.stubGlobal("fetch", fetcher);
  const out = await handlePaymentMethod({ bin: "999999" });
  expect(out.valid).toBe(false); expect(out.network).toBeNull(); expect(out.answer).toContain("No record");
  const receipt = out.receipt as { receipt_id: string; raw_response_sha256: string };
  const stored = await getReceiptEvidence(receipt.receipt_id);
  expect(sha256Hex(stored.evidence!)).toBe(receipt.raw_response_sha256);
  expect(String(stored.evidence)).toContain(JSON.stringify(raw));
  await handlePaymentMethod({ bin: "999999" }); expect(fetcher).toHaveBeenCalledTimes(2);
});

for (const bin of ["411111", "516732", "999999"]) it(`uses captured open BIN record ${bin} when binlist empty`, async () => {
 const raw = readFileSync(join(FX, `open-bin-${bin}.json`), "utf8");
 vi.stubGlobal("fetch", async (u: unknown) => new Response(String(u).includes("api.dharun.dev") ? raw : "{}"));
 const out = await handlePaymentMethod({ bin });
 expect(out.valid).toBe(true); expect(out.network).toBe(JSON.parse(raw).data.network.toLowerCase());
 expect(out.field_sources).toMatchObject({ network: "open BIN list" });
 expect(out.attribution).toContain("Venelin Kochev"); expect(out.answer).toContain("CC BY 4.0");
 const r = out.receipt as {receipt_id:string}; const stored = await getReceiptEvidence(r.receipt_id);
 expect(String(stored.evidence)).toContain(JSON.stringify(raw));
});
it("merges only non-empty fields and discloses conflicts without losing primary data", async () => {
 const raw = readFileSync(join(FX, "open-bin-411111.json"), "utf8");
 vi.stubGlobal("fetch", async (u: unknown) => new Response(String(u).includes("api.dharun.dev") ? raw : JSON.stringify({scheme:"visa",bank:{name:""},country:{name:"DIFFERENT"}})));
 const out = await handlePaymentMethod({bin:"411111"});
 expect(out.network).toBe("visa"); expect(out.issuing_bank).toBe("CONOTOXIA SP. Z O.O"); expect(out.issuing_country).toBe("DIFFERENT");
 expect(out.source_conflicts).toEqual(["issuing_country"]); expect(out.answer).toContain("disagree");
});
it("never calls partial no-record a negative and accepts a found source during outage", async () => {
 vi.stubGlobal("fetch", async (u: unknown) => {if(String(u).includes("api.dharun.dev")) throw new Error("outage");return new Response("{}")});
 await expect(handlePaymentMethod({bin:"411111"})).rejects.toMatchObject({status:502,code:"BIN_COVERAGE_INCOMPLETE"});
 resetBinCacheForTests();
 vi.stubGlobal("fetch", async (u: unknown) => {if(String(u).includes("api.dharun.dev")) throw new Error("outage");return new Response(BIN_424242)});
 expect((await handlePaymentMethod({bin:"424242"})).valid).toBe(true);
});
it("retains original source acquisition time and bytes across24h cache hits", async () => {
 const raw = readFileSync(join(FX,"open-bin-411111.json"),"utf8");
 const f = vi.fn(async (u: unknown) => new Response(String(u).includes("api.dharun.dev") ? raw : "{}"));vi.stubGlobal("fetch",f);
 const a = await handlePaymentMethod({bin:"411111"}); const b = await handlePaymentMethod({bin:"411111"});
 expect(f).toHaveBeenCalledTimes(2);
 expect((a.receipt as {fetched_at:string}).fetched_at).toBe((b.receipt as {fetched_at:string}).fetched_at);
 expect(b.answer).toContain("cache");
});
it("malformed upstream JSON is an honest502 not an escaping SyntaxError",async()=>{
 vi.stubGlobal("fetch",async()=>new Response("{not-json"));
 await expect(handlePaymentMethod({bin:"411111"})).rejects.toMatchObject({status:502});
});
