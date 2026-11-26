import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {sha256Hex} from '../src/core/receipt';
import {handleTransactionRisk} from '../src/handlers/transactionRisk';
const tx=JSON.parse(readFileSync(join(__dirname,'fixtures/crypto-transfer/eth-usdc-transfer-tx.json'),'utf8'));
const rc=JSON.parse(readFileSync(join(__dirname,'fixtures/crypto-transfer/eth-usdc-transfer-receipt.json'),'utf8'));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it('free text returns a disclosed unverified scenario without network or invented signals',async()=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);
 const out=await handleTransactionRisk({transaction:'Send money to an unfamiliar website'});
 expect(out.risk_score).toBe(0);expect(out.risk_level).toBe('LOW');expect(out.verdict).toBe('unverified');expect(out.confidence).toBe(0);
 expect(out.sanctions_screened).toBe(false);expect(out.assessment_mode).toBe('scenario');expect(f).not.toHaveBeenCalled();
 expect(String(out.answer)).toContain('never safe');expect(String(out.answer)).toContain('Unsupported details are not assessed');
 const [r,e]=vi.mocked(saveReceipt).mock.calls[0];expect(r.raw_response_sha256).toBe(sha256Hex(e));expect(JSON.parse(e).description).toBe('Send money to an unfamiliar website');
});
it.each([
 ['Transaction reverted',.3,'MEDIUM'],['Transaction deploys a contract',.1,'LOW'],
 ['Transaction transfers 0 ETH with 0 logs',.1,'LOW'],['Transaction transfers 100 ETH',.1,'LOW'],
 ['Transaction transfers 100.1 ETH',.1,'LOW'],['Transaction transfers 99.99 ETH',0,'LOW'],['Transaction reverted. Contract deployment. Value is 200 ETH',.4,'MEDIUM'],
])('applies only existing rubric weights: %s',async(transaction,score,level)=>{
 vi.stubGlobal('fetch',vi.fn());const out=await handleTransactionRisk({transaction});expect(out.risk_score).toBe(score);expect(out.risk_level).toBe(level);
});
it.each(['Transaction did not revert','If transaction reverted','Transaction reverted?','Transaction will fail','The recipient is sanctioned','Transaction transfers 100 USDC','Transaction reverted and then succeeded'])('does not promote unsupported/negated/conditional assertions: %s',async(transaction)=>{
 vi.stubGlobal('fetch',vi.fn());const out=await handleTransactionRisk({transaction});expect(out.risk_score).toBe(0);expect(out.signals).toEqual([]);
});
it.each([tx.hash.toUpperCase(),tx.hash.slice(2).toUpperCase()])('normalizes valid case/prefix without moving hash lookup into scenario mode',async(transaction)=>{
 const hashes:string[]=[];
 vi.stubGlobal('fetch',async(url:unknown,init?:RequestInit)=>{
  if(String(url).includes('ofac.treas.gov'))return new Response(readFileSync(join(__dirname,'fixtures/transaction-risk/sdn-excerpt.csv'),'utf8'));
  const q=JSON.parse(String(init?.body));hashes.push(q.params[0]);
  return new Response(JSON.stringify({result:q.method==='eth_getTransactionReceipt'?rc:tx}));
 });
 const out=await handleTransactionRisk({transaction});expect(out.assessment_mode).toBeUndefined();expect(out.confidence).toBe(.9);expect(hashes.length).toBeGreaterThanOrEqual(4);expect(new Set(hashes)).toEqual(new Set([tx.hash.toLowerCase()]));
});
it.each(['0x1234','1234','0x'+'z'.repeat(64),'a'.repeat(63)])('malformed hash returns disclosed unassessed result: %s',async(transaction)=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const out=await handleTransactionRisk({transaction});expect(out.risk_level).toBeNull();expect(out.risk_score).toBeNull();expect(out.verdict).toBe('unverified');expect(out.confidence).toBe(0);expect(out.answer).toContain('not a full 64-hex');expect(f).not.toHaveBeenCalled();expect(saveReceipt).toHaveBeenCalledOnce();
});
it('bounds descriptions and fails closed on receipt storage failure',async()=>{
 await expect(handleTransactionRisk({transaction:'x'.repeat(2001)})).rejects.toMatchObject({code:'INVALID_TRANSACTION'});
 vi.mocked(saveReceipt).mockRejectedValueOnce(new Error('storage'));
 await expect(handleTransactionRisk({transaction:'Transaction reverted'})).rejects.toMatchObject({code:'RECEIPT_PERSIST_FAILED'});
});
