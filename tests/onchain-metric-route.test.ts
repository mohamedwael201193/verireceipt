import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
const scratch=mkdtempSync('/tmp/metric-route-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import { buildServer } from '../src/server';
import { getReceiptEvidence } from '../src/core/storage';
import { sha256Hex } from '../src/core/receipt';
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));afterEach(()=>vi.unstubAllGlobals());
const address='0x'+'0'.repeat(40),hash='0x'+'a'.repeat(64);
describe('metric route and persisted evidence',()=>{
 it('serves finalized quorum evidence through the declared route',async()=>{
  vi.stubGlobal('fetch',async (_u:unknown,o:any)=>{const q=JSON.parse(o.body);const result=q.method==='eth_chainId'?'0x1':q.method==='eth_getBlockByNumber'?{number:q.params[0]==='finalized'?'0x100':'0x64',hash}:q.method==='eth_getBalance'?'0xde0b6b3a7640000':'0x3';return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}));});
  const app=buildServer();try{const r=await app.inject({method:'GET',url:`/v1/onchain-metric?address=${address}&block=100`});expect(r.statusCode).toBe(200);const b=r.json();expect(b.balance_gwei).toBe(1e9);expect(b.tx_count).toBe(3);const stored=await getReceiptEvidence(b.receipt.receipt_id);expect(stored.evidence).toBeTruthy();expect(sha256Hex(stored.evidence!.toString())).toBe(b.receipt.raw_response_sha256);}finally{await app.close();}
 });
 it('rejects duplicate, unknown and malformed input before source calls',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const app=buildServer();try{for(const suffix of [`address=${address}&block=100&block=101`,`address=${address}&block=100&other=1`,`address=${address}&block=latest`]){const r=await app.inject({method:'GET',url:'/v1/onchain-metric?'+suffix});expect(r.statusCode).toBe(400);}expect(fetch).not.toHaveBeenCalled();}finally{await app.close();}
 });
});
