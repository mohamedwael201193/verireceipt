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
    const result = await handlePaymentMethod({ bin: "100000" });
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

it('rejects wrong-prefix open-list evidence instead of asserting it for requested BIN or caching it',async()=>{
 const raw=JSON.parse(readFileSync(join(FX,'open-bin-411111.json'),'utf8'));raw.data.bin='516732';let calls=0;
 vi.stubGlobal('fetch',async(u:unknown)=>{if(String(u).includes('api.dharun.dev')){calls++;return new Response(JSON.stringify(raw));}return new Response('{}');});
 for(let i=0;i<2;i++)await expect(handlePaymentMethod({bin:'411111'})).rejects.toMatchObject({code:'BIN_COVERAGE_INCOMPLETE'});
 expect(calls).toBe(2);
});
it.each([undefined,411111,'41111200'])('refuses missing, typed or wrong-length source BIN identity %s',async identity=>{
 const raw=JSON.parse(readFileSync(join(FX,'open-bin-411111.json'),'utf8'));raw.data.bin=identity;
 vi.stubGlobal('fetch',async(u:unknown)=>new Response(String(u).includes('api.dharun.dev')?JSON.stringify(raw):'{}'));
 await expect(handlePaymentMethod({bin:'411111'})).rejects.toMatchObject({code:'BIN_COVERAGE_INCOMPLETE'});
});
it('HTTP400 is a failed lookup, never a negative allocation observation or cached absence',async()=>{
 let calls=0;vi.stubGlobal('fetch',async(u:unknown)=>{if(String(u).includes('api.dharun.dev'))return new Response('{}',{status:404});calls++;return new Response('invalid request',{status:400});});
 for(let i=0;i<2;i++)await expect(handlePaymentMethod({bin:'411111'})).rejects.toMatchObject({code:'BIN_COVERAGE_INCOMPLETE'});
 expect(calls).toBe(2);
});
it('a wrong-prefix source cannot override a valid matching primary observation',async()=>{
 const raw=JSON.parse(readFileSync(join(FX,'open-bin-411111.json'),'utf8'));raw.data.bin='516732';
 vi.stubGlobal('fetch',async(u:unknown)=>new Response(String(u).includes('api.dharun.dev')?JSON.stringify(raw):BIN_424242));
 const out=await handlePaymentMethod({bin:'424242'});expect(out.valid).toBe(true);expect(out.field_sources).toMatchObject({network:'binlist.net'});expect(out.answer).toContain('One source unavailable');
 expect(out.issuing_bank).not.toBe('CONOTOXIA SP. Z O.O');
});

it('accepts only6digit parent evidence for8digit query, discloses scope and original bytes when primary is unavailable',async()=>{
 const raw=readFileSync(join(FX,'open-bin-411111.json'),'utf8');
 vi.stubGlobal('fetch',async(u:unknown)=>{if(String(u).includes('api.dharun.dev'))return new Response(raw);throw Error('primary unavailable');});
 const out=await handlePaymentMethod({bin:'41111100'});expect(out.valid).toBe(true);expect(out.allocation_scope).toEqual([{source:'open BIN list',requested_bin:'41111100',allocation_prefix:'411111',scope:'six-digit parent only; not an exact eight-digit allocation'}]);
 expect(out.answer).toContain('no exact eight-digit allocation is asserted');expect(out.summary).toContain('no exact eight-digit allocation asserted');
 const evidence=await getReceiptEvidence((out.receipt as any).receipt_id);expect(String(evidence.evidence)).toContain(JSON.stringify(raw));expect(JSON.parse(evidence.evidence!.toString()).allocation_scope).toEqual(out.allocation_scope);
});
it('does not accept7digit parent or arbitrary shorter prefixes as8digit coverage',async()=>{
 for(const prefix of ['41111','4111110','411112']){
  resetBinCacheForTests();const data=JSON.parse(readFileSync(join(FX,'open-bin-411111.json'),'utf8'));data.data.bin=prefix;
  vi.stubGlobal('fetch',async(u:unknown)=>{if(String(u).includes('api.dharun.dev'))return new Response(JSON.stringify(data));throw Error('unavailable');});
  await expect(handlePaymentMethod({bin:'41111100'})).rejects.toMatchObject({code:'BIN_SOURCES_UNAVAILABLE'});
 }
});

it.each([200,404])('cache preserves source acquisition time after a delayed HTTP%s read',async status=>{
 vi.useFakeTimers();const start=new Date('2026-11-24T17:00:00.000Z');vi.setSystemTime(start);
 let calls=0;vi.stubGlobal('fetch',async(u:unknown)=>{
  calls++;if(String(u).includes('api.dharun.dev'))throw Error('unavailable');
  await new Promise(r=>setTimeout(r,1200));return new Response(status===200?BIN_424242:'{}',{status});
 });
 try{
  const first=handlePaymentMethod({bin:'424242'});const firstResult=first.catch(e=>e);await vi.advanceTimersByTimeAsync(1200);const a=await firstResult;
  vi.setSystemTime(new Date(start.getTime()+60000));const b=await handlePaymentMethod({bin:'424242'}).catch(e=>e);
  if(status===200){expect((a.receipt as any).fetched_at).toBe(start.toISOString());expect((b.receipt as any).fetched_at).toBe(start.toISOString());}
  else{expect(a.code).toBe('BIN_COVERAGE_INCOMPLETE');expect(b.code).toBe('BIN_COVERAGE_INCOMPLETE');}
  expect(calls).toBe(3); // first pair plus second unavailable open source; primary stays cached.
 }finally{vi.useRealTimers();}
});

it('retains real six-digit parent coverage for the allowed seven-digit input without asserting exact allocation',async()=>{
 const body=readFileSync(join(FX,'open-bin-411111.json'),'utf8');
 vi.stubGlobal('fetch',async(u:unknown)=>{if(String(u).includes('api.dharun.dev'))return new Response(body);throw Error('primary down');});
 const out=await handlePaymentMethod({bin:'4111110'});
 expect(out.valid).toBe(true);expect(out.issuing_bank).toBe('CONOTOXIA SP. Z O.O');
 expect(out.allocation_scope).toEqual([{source:'open BIN list',requested_bin:'4111110',allocation_prefix:'411111',scope:'six-digit parent only; not an exact seven-digit allocation'}]);
 expect(out.answer).toContain('no exact seven-digit allocation is asserted');expect(out.summary).toContain('no exact seven-digit allocation asserted');
 const stored=await getReceiptEvidence((out.receipt as {receipt_id:string}).receipt_id);expect(String(stored.evidence)).toContain(JSON.stringify(body));
});
it.each(['411112','41111','41111100'])('rejects unrelated or wrongly-sized source identity for seven-digit input: %s',async identity=>{
 const body=JSON.parse(readFileSync(join(FX,'open-bin-411111.json'),'utf8'));body.data.bin=identity;
 vi.stubGlobal('fetch',async(u:unknown)=>{if(String(u).includes('api.dharun.dev'))return new Response(JSON.stringify(body));throw Error('primary down');});
 await expect(handlePaymentMethod({bin:'4111110'})).rejects.toMatchObject({code:'BIN_SOURCES_UNAVAILABLE'});
});

describe('BIN prefix structure is independent of lookup coverage',()=>{
 it.each(['411111','400000','515462','601100','222100','272099','340000','370000'])('%s has published network range even when both references have no record',async bin=>{vi.stubGlobal('fetch',async()=>new Response('{}',{status:404}));const out=await handlePaymentMethod({bin});expect(out).toMatchObject({valid:true,allocation_known:false,checksum_assessed:false,issuing_bank:null,issuing_country:null});expect(out.answer).toContain('allocation unknown');expect(out.answer).toContain('no checksum');const rc=out.receipt as any;const st=await getReceiptEvidence(rc.receipt_id);expect(sha256Hex(st.evidence!)).toBe(rc.raw_response_sha256);expect(JSON.parse(Buffer.from(st.evidence!).toString())).toMatchObject({valid:true,allocation_known:false,checksum_assessed:false,network_range_source:'https://design.visa.com/patterns/card-input/'});});
 it.each(['100000','99999999','222099','272100'])('%s unknown outside covered ranges never claims allocation or checksum',async bin=>{vi.stubGlobal('fetch',async()=>new Response('{}',{status:404}));const out=await handlePaymentMethod({bin});expect(out).toMatchObject({valid:false,allocation_known:false,checksum_assessed:false,network_range_candidates:[]});expect(out.answer).toContain('not proof');});
 it.each(['000000','099999','01234567'])('%s rejected at request bound before source call',async bin=>{const f=vi.fn();vi.stubGlobal('fetch',f);await expect(handlePaymentMethod({bin})).rejects.toMatchObject({status:400,code:'INVALID_BIN'});expect(f).not.toHaveBeenCalled();});
});

describe('published network candidate ranges and intentional overlaps',()=>{
 it.each([
  ['399999',[]],['400000',['visa']],['499999',['visa']],['500000',['maestro']],
  ['509999',['maestro']],['510000',['mastercard']],['559999',['mastercard']],['560000',['maestro']],
  ['589999',['maestro']],['590000',[]],['599999',[]],['600000',['maestro']],['699999',['maestro']],['700000',[]],
  ['222099',[]],['222100',['mastercard']],['272099',['mastercard']],['272100',[]],
  ['339999',[]],['340000',['american express']],['349999',['american express']],['350000',[]],
  ['369999',[]],['370000',['american express']],['379999',['american express']],['380000',[]],
  ['601099',['maestro']],['601100',['discover','maestro']],['601199',['discover','maestro']],['601200',['maestro']],
  ['622125',['maestro']],['622126',['discover','maestro']],['622925',['discover','maestro']],['622926',['maestro']],
  ['643999',['maestro']],['644000',['discover','maestro']],['649999',['discover','maestro']],
  ['650000',['discover','maestro']],['659999',['discover','maestro']],['660000',['maestro']],
 ])('%s exact candidates are %j',async(bin,expected)=>{
  const {binNetworkCandidates}=await import('../src/handlers/paymentMethod');expect(binNetworkCandidates(bin as string)).toEqual(expected);
 });
 it.each(['500000','509999','560000','589999','600000','699999'])('Maestro-only %s is valid with no issuer allocation',async bin=>{vi.stubGlobal('fetch',async()=>new Response('{}',{status:404}));expect(await handlePaymentMethod({bin})).toMatchObject({valid:true,allocation_known:false,network_range_candidates:['maestro'],checksum_assessed:false});});
});
