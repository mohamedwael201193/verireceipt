import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleTransactionRisk,extractSdnCryptoAddresses} from '../src/handlers/transactionRisk';
import {sha256Hex} from '../src/core/receipt';
const raw=readFileSync('tests/fixtures/fraud/sdn.csv','utf8');
const listed=extractSdnCryptoAddresses(raw)[0];
const actualTx=JSON.parse(readFileSync('tests/fixtures/crypto-transfer/eth-usdc-transfer-tx.json','utf8'));
const unlisted=String(actualTx.from).toLowerCase();
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it.each([true,false])('address-shaped input exact SDN match=%s without RPC or invented transaction grade',async match=>{
 expect(listed).toMatch(/^0x[a-f0-9]{40}$/);expect(extractSdnCryptoAddresses(raw)).not.toContain(unlisted);
 const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);
 const out=await handleTransactionRisk({transaction:match?listed.toUpperCase():unlisted.slice(2)});
 expect(f).toHaveBeenCalledOnce();expect(String(f.mock.calls[0][0])).toContain('ofac.treas.gov');
 expect(out.risk_level).toBeNull();expect(out.risk_score).toBeNull();expect(out.sanctions_screened).toBe(true);expect(out.sanctions_match).toBe(match);expect(out.assessment_mode).toBe('address_screening');expect(out.verdict).toBe('unverified');expect(out.confidence).toBe(0);
 expect(out.answer).toContain(match?'exact match found':'no exact match found');expect(out.answer).toContain('not a transaction assessment');expect(out.answer).toContain('not a full 64-hex');
 const [receipt,evidence]=vi.mocked(saveReceipt).mock.calls[0];const ev=JSON.parse(evidence);expect(ev.raw_bodies.sdn).toBe(raw);expect(ev.sanctions_match).toBe(match);expect(receipt.raw_response_sha256).toBe(sha256Hex(evidence));
});
it.each(['0x1','0x','abcd','a'.repeat(63),'0xnothex'])('incomplete %s does not run chain/sanctions or fabricate a level',async transaction=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const out=await handleTransactionRisk({transaction});expect(f).not.toHaveBeenCalled();expect(out.risk_level).toBeNull();expect(out.risk_score).toBeNull();expect(out.sanctions_match).toBeNull();expect(out.sanctions_screened).toBe(false);expect(out.verdict).toBe('unverified');expect(out.confidence).toBe(0);expect(out.answer).toContain('No transaction lookup');
});
it.each(['\n0x1234','0x1234\t','a\u007f','a'.repeat(2001)])('control characters and oversized raw input refuse before trim',async transaction=>{
 vi.stubGlobal('fetch',vi.fn());await expect(handleTransactionRisk({transaction})).rejects.toMatchObject({status:400,code:'INVALID_TRANSACTION'});expect(saveReceipt).not.toHaveBeenCalled();
});
it.each(['outage','empty','malformed'])('address screening fails closed on SDN %s',async mode=>{
 vi.stubGlobal('fetch',async()=>{if(mode==='outage')throw Error('outage');return new Response(mode==='empty'?'':'<html>unavailable</html>');});await expect(handleTransactionRisk({transaction:listed})).rejects.toMatchObject({code:'SANCTIONS_UNAVAILABLE'});expect(saveReceipt).not.toHaveBeenCalled();
});
it('incomplete result fails closed when receipt persistence fails',async()=>{
 vi.mocked(saveReceipt).mockRejectedValueOnce(Error('storage'));await expect(handleTransactionRisk({transaction:'0x1234'})).rejects.toMatchObject({code:'RECEIPT_PERSIST_FAILED'});
});
