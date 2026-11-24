// Test-only query/error sentinels. No source calls or production data.
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const scratch = mkdtempSync(join(tmpdir(), "vr-request-diagnostics-"));
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
import { recordRequestCompletion, resetRequestMetricsForTests } from "../src/core/requestMetrics";
import { buildServer } from "../src/server";
import { closeStorage } from "../src/core/storage";
afterEach(() => { vi.restoreAllMocks(); resetRequestMetricsForTests(); });
afterAll(async () => { await closeStorage(); rmSync(scratch, { recursive: true, force: true }); });
it("logs a fixed path, known parameter names and an allowed error category, never values or unknown names", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  recordRequestCompletion("/v1/validator", 400, 1.234, { query: { validator_index: "PRIVATE_VALUE", PRIVATE_KEY: "PRIVATE_SECRET" }, errorCode: "UNKNOWN_PARAM" });
  const row = JSON.parse(log.mock.calls[0][0]);
  expect(row).toMatchObject({ event: "request_complete", path: "/v1/validator", intent: "VALIDATOR_PERFORMANCE_VERIFY_GENERAL", param_keys: ["validator_index"], error_code: "UNKNOWN_PARAM", status: "400", latency_ms: 1.2 });
  expect(JSON.stringify(row)).not.toContain("PRIVATE");
});
it("does not inspect query values or emit arbitrary error strings", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const query = Object.defineProperty({}, "validator_index", { enumerable: true, get() { throw new Error("PRIVATE_VALUE_WAS_READ"); } });
  recordRequestCompletion("/v1/validator", 502, 2, { query, errorCode: "PRIVATE_SECRET" });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ param_keys: ["validator_index"], error_code: "OTHER_ERROR" });
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
});
it("uses a uniform null error field for success and omits unknown routes", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  recordRequestCompletion("/v1/tvl", 200, 1);
  recordRequestCompletion("/PRIVATE_PATH", 404, 1, { query: { PRIVATE_KEY: "PRIVATE_VALUE" } });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ path: "/v1/tvl", param_keys: [], error_code: null });
});
it("wires the actual HTTP validation failure into the bounded completion log", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const app = buildServer();
  try {
    const response = await app.inject({ method: "GET", url: "/v1/validator?validator_index=PRIVATE_VALUE&PRIVATE_KEY=PRIVATE_SECRET" });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ path: "/v1/validator", param_keys: ["validator_index"], error_code: "UNKNOWN_PARAM", status: "400" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
  } finally { await app.close(); }
});
it("wires an actual non-ApiError to INTERNAL without logging its message", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const app = buildServer();
  app.post("/v1/validator", async () => { throw new Error("PRIVATE_SECRET"); });
  try {
    expect((await app.inject({ method: "POST", url: "/v1/validator" })).statusCode).toBe(502);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ error_code: "INTERNAL", status: "502" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
  } finally { await app.close(); }
});
it('wires malformed risk hash to shape-only diagnostics without its value',async()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});const app=buildServer();
 try {const response=await app.inject({method:'GET',url:'/v1/transaction-risk?transaction=0Xprivate-canary'});expect(response.statusCode).toBe(400);
 const row=JSON.parse(log.mock.calls.at(-1)![0]);expect(row).toMatchObject({error_code:'INVALID_TX_HASH',input_shape:{length:16,prefix:'0X',charset:'other',hex_digits:5,has_whitespace_inside:false}});
 expect(JSON.stringify(log.mock.calls)).not.toContain('private-canary');} finally {await app.close();}
});
it.each([
 ['0x'+'a'.repeat(63),65,'0x','hex',63],['0X'+'A'.repeat(66),68,'0X','hex',66],
 ['f'.repeat(65),65,'none','hex',65],['0x'+'a1'.repeat(31)+'Zz',66,'0x','other',62],
 ['0x'+'aA'.repeat(31)+'b',65,'0x','hex_mixed_case',63],
])('logs specified shape without any 8-character value fragment',async(input,length,prefix,charset,hex_digits)=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{}),app=buildServer();
 try {const response=await app.inject({method:'GET',url:'/v1/transaction-risk?transaction='+encodeURIComponent(input)});expect(response.statusCode).toBe(400);
 const text=String(log.mock.calls.at(-1)![0]),row=JSON.parse(text);expect(row).toMatchObject({param_keys:['transaction'],error_code:'INVALID_TX_HASH',input_shape:{length,prefix,charset,hex_digits,has_whitespace_inside:false}});
 for(let i=0;i<=input.length-8;i++)expect(text).not.toContain(input.slice(i,i+8));
 }finally{await app.close();}
});
it('emits privacy-safe start before completion on a real failing request',async()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});const app=buildServer();
 try {const response=await app.inject({method:'GET',url:'/v1/filings?entity=PRIVATE_PERSON&period=2026&form_type=NOT_A_FORM'});expect(response.statusCode).toBe(422);
 const rows=log.mock.calls.map(c=>{try{return JSON.parse(String(c[0]));}catch{return null;}}).filter(r=>r?.event==='request_start'||r?.event==='request_complete');
 expect(rows.map(r=>r.event)).toEqual(['request_start','request_complete']);expect(rows[0].input_enums).toEqual({form_type:'other',period_kind:'year'});expect(rows[1].error_code).toBe('UNKNOWN_FORM');expect(JSON.stringify(rows)).not.toContain('PRIVATE_PERSON');expect(JSON.stringify(rows)).not.toContain('NOT_A_FORM');
 }finally{await app.close();}
});
it('security review actual invalid-target HTTP request emits fixed start and completion, target name only',async()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});const app=buildServer();
 try{const response=await app.inject({method:'GET',url:'/v1/security-review?target=PRIVATE_TARGET'});expect(response.statusCode).toBe(400);expect(response.json().code).toBe('INVALID_TARGET');const rows=log.mock.calls.map(c=>{try{return JSON.parse(String(c[0]));}catch{return null;}}).filter(r=>r?.event==='request_start'||r?.event==='request_complete');expect(rows).toHaveLength(2);expect(rows.map(r=>r.event)).toEqual(['request_start','request_complete']);for(const row of rows)expect(row).toMatchObject({path:'/v1/security-review',intent:'SECURITY_REVIEW_GENERAL',param_keys:['target']});expect(rows[1].status).toBe('400');expect(JSON.stringify(rows)).not.toContain('PRIVATE_TARGET');}finally{await app.close();}
});
it('security target getter and arbitrary key are never read or logged, success status remains200',()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});const query=Object.defineProperty({PRIVATE_KEY:'PRIVATE_VALUE'},'target',{enumerable:true,get(){throw Error('PRIVATE_GETTER');}});recordRequestCompletion('/v1/security-review',200,1,{query});expect(log).toHaveBeenCalledTimes(1);expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({intent:'SECURITY_REVIEW_GENERAL',status:'200',param_keys:['target'],error_code:null});expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
});
