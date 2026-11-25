import {it,expect,vi,afterEach}from'vitest';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{}),getReceiptEvidence:vi.fn()}));
vi.mock('../src/handlers/ssrfGuard',()=>({guardPublicHttpUrl:vi.fn(async()=>({url:'https://example.com/a',hostname:'example.com',port:443,addresses:['93.184.216.34']})),measureGet:vi.fn(async()=>({status:200,latency_ms:1})),dnsProbeFailure:()=>undefined}));
import{saveReceipt,getReceiptEvidence}from'../src/core/storage';
import{measureGet}from'../src/handlers/ssrfGuard';
import{handleApiHealth,resetHealthReuseForTests}from'../src/handlers/apiHealth';
import{diagnosticErrorCode}from'../src/core/requestMetrics';
afterEach(()=>{resetHealthReuseForTests();vi.clearAllMocks();});
it.each(['missing','hash','bytes'])('cached health%s evidence cannot authorize reuse',async kind=>{
 await handleApiHealth({url:'https://example.com/a'});const [r,e]=vi.mocked(saveReceipt).mock.calls[0];vi.mocked(getReceiptEvidence).mockResolvedValue({found:kind!=='missing',sha256:kind==='hash'?'0'.repeat(64):r.raw_response_sha256,evidence:kind==='bytes'?Buffer.from('wrong'):Buffer.from(e!),evidenceBytes:1});const out=await handleApiHealth({url:'https://example.com/a'});expect(out.reused_measurement).toBeUndefined();expect(measureGet).toHaveBeenCalledTimes(2);
});
it.each(['RATE_LIMITED','PORT_NOT_CHECKED','PRIVATE_HOST','BAD_URL','BAD_SCHEME'])('diagnostic%s remains its fixed code',code=>{expect(diagnosticErrorCode(code)).toBe(code);});
