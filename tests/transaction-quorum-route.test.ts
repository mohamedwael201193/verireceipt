import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleTransactionRisk} from '../src/handlers/transactionRisk';
import {resetReceiptRetryForTests} from '../src/core/receiptQuorum';
const tx=JSON.parse(readFileSync('tests/fixtures/transaction-quorum/providers.json','utf8'));
const receipt=JSON.parse(readFileSync('tests/fixtures/receipt-legacy/ethereum-providers.json','utf8'));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();resetReceiptRetryForTests();vi.useRealTimers();});
it('uppercase hash and exact actual tx/receipt bodies retain risk and all attempt evidence',async()=>{
 vi.useFakeTimers();let count=0;
 vi.stubGlobal('fetch',async(u:unknown,o:any)=>{
  const url=String(u);if(url.includes('ofac.treas.gov'))return new Response(readFileSync('tests/fixtures/transaction-risk/sdn-excerpt.csv','utf8'));
  const q=JSON.parse(o.body),source=q.method==='eth_getTransactionByHash'?tx:receipt;
  const p=source.providers.find((p:any)=>p.url===url);
  if(q.method==='eth_getTransactionByHash'&&++count===3)return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:null}));
  return new Response(p.body);
 });
 const pending=handleTransactionRisk({transaction:tx.tx.toUpperCase()});await vi.advanceTimersByTimeAsync(1100);const out=await pending;
 expect(out.risk_score).toBe(0);expect(out.risk_level).toBe('LOW');
 const ev=JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1] as string);
 expect(Object.keys(ev.raw_bodies.tx)).toHaveLength(6);
 for(const p of tx.providers)expect(ev.raw_bodies.tx['attempt2:'+p.url]).toBe(p.body);
});
