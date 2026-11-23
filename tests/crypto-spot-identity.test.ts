import {afterAll,afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/spot-identity-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {handleCryptoPrice,parseCryptoSpot} from '../src/handlers/cryptoPrice';
import {getReceiptEvidence} from '../src/core/storage';
import {sha256Hex} from '../src/core/receipt';
const raw=readFileSync(join(__dirname,'fixtures/crypto-price/coinbase-eth-identity-live.json'),'utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
it('real Coinbase capture binds base/currency and preserves exact evidence',async()=>{
 const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);const out=await handleCryptoPrice({symbol:'ETH'});expect(out.price_usd).toBe(Number(JSON.parse(raw).data.amount));
 const rec=out.receipt as any,evidence=String((await getReceiptEvidence(rec.receipt_id)).evidence);expect(sha256Hex(evidence)).toBe(rec.raw_response_sha256);expect(JSON.parse(evidence).raw_bodies.spot).toBe(raw);expect(f.mock.calls[0][1].redirect).toBe('error');
});
it.each([{base:'BTC',currency:'USD'},{base:'ETH',currency:'EUR'},{base:'ETH'}, {currency:'USD'},null])('mismatched or missing identity %j refuses',data=>{
 expect(()=>parseCryptoSpot(JSON.stringify({data:data&&{...data,amount:'1714.565'}}),'ETH')).toThrowError(expect.objectContaining({code:'COINBASE_IDENTITY_MISMATCH'}));
});
it.each([true,null,'',[],{},'1e3','Infinity','0x100','-1',' 1714 ','10000001'])('noncanonical or out-of-range amount %j refuses',amount=>{
 expect(()=>parseCryptoSpot(JSON.stringify({data:{base:'ETH',currency:'USD',amount}}),'ETH')).toThrow();
});
it('header-only response with hung body is bounded by same 6s deadline',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|undefined;
 vi.stubGlobal('fetch',async(_url:unknown,options:RequestInit)=>{signal=options.signal!;return new Response(new ReadableStream({start(){}}));});
 let settled=false;const pending=handleCryptoPrice({symbol:'ETH'}).finally(()=>{settled=true;});const refused=expect(pending).rejects.toMatchObject({code:'COINBASE_UNREACHABLE'});
 await vi.advanceTimersByTimeAsync(5999);expect(settled).toBe(false);await vi.advanceTimersByTimeAsync(1);await refused;expect(signal!.aborted).toBe(true);
});
it('fetch that ignores abort still cannot keep handler pending',async()=>{
 vi.useFakeTimers();vi.stubGlobal('fetch',()=>new Promise(()=>{}));const refused=expect(handleCryptoPrice({symbol:'ETH'})).rejects.toMatchObject({code:'COINBASE_UNREACHABLE'});await vi.advanceTimersByTimeAsync(6000);await refused;
});
it('oversized source body refuses',async()=>{
 vi.stubGlobal('fetch',async()=>new Response('x'.repeat(65537)));await expect(handleCryptoPrice({symbol:'ETH'})).rejects.toMatchObject({code:'COINBASE_UNREACHABLE'});
});
