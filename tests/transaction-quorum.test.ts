import {afterEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {transactionQuorum,canonicalTransactionValue,selectCompatibleTransactions} from '../src/core/transactionQuorum';
import {admitRetry,resetReceiptRetryForTests} from '../src/core/receiptQuorum';
const capture=JSON.parse(readFileSync('tests/fixtures/transaction-quorum/providers.json','utf8'));
const urls=capture.providers.map((p:any)=>p.url),tx=JSON.parse(capture.providers[0].body).result;
const wrap=(result:any)=>({result,body:JSON.stringify({jsonrpc:'2.0',id:1,result})});
afterEach(()=>{vi.useRealTimers();resetReceiptRetryForTests();});
describe('transaction canonical quorum and one split retry',()=>{
 it('replays exact public provider bodies independent of key order',async()=>{
  expect(new Set(capture.providers.map((p:any)=>JSON.stringify(JSON.parse(p.body).result))).size).toBe(2);
  const out=await transactionQuorum(urls,capture.tx,async u=>{const p=capture.providers.find((p:any)=>p.url===u);return {body:p.body,result:JSON.parse(p.body).result};});
  expect(out.result).toEqual(tx);expect(Object.values(out.bodies)).toEqual(capture.providers.map((p:any)=>p.body));
 });
 it('sorts recursively without changing array order or values',()=>{expect(canonicalTransactionValue({b:{z:1,a:2},a:[2,1]})).toBe('{"a":[2,1],"b":{"a":2,"z":1}}');});
 it('missing optional signatures do not split required agreement',async()=>{const lean={...tx};for(const k of ['r','s','v','type'])delete lean[k];expect((await transactionQuorum(urls,capture.tx,async u=>wrap(u===urls[2]?lean:tx))).result).toEqual(tx);});
 it('one different blockHash does not outvote agreeing pair',async()=>{expect((await transactionQuorum(urls,capture.tx,async u=>wrap({...tx,blockHash:u===urls[2]?'0x'+'a'.repeat(64):tx.blockHash}))).result).toEqual(tx);});
 it('all different blockHash values refuse',async()=>{await expect(transactionQuorum(urls,capture.tx,async u=>wrap({...tx,blockHash:'0x'+String(urls.indexOf(u)+1).repeat(64)}))).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});});
 it('optional-field differences cannot yield false unanimity',async()=>{const pair=[urls[0],urls[1]];await expect(transactionQuorum(pair,capture.tx,async u=>wrap({...tx,gas:u===urls[0]?'0x1':'0x2'}))).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});});
 it('retries answered legs once at1100ms and retains both attempts',async()=>{vi.useFakeTimers();let n=0;const read=vi.fn(async u=>wrap(++n<=3&&u===urls[2]?null:tx));const p=transactionQuorum(urls,capture.tx,read);await vi.advanceTimersByTimeAsync(1099);expect(read).toHaveBeenCalledTimes(3);await vi.advanceTimersByTimeAsync(1);const out=await p;expect(read).toHaveBeenCalledTimes(6);expect(Object.keys(out.bodies)).toHaveLength(6);});
 it('single found cannot be outvoted by nulls or counted twice',async()=>{vi.useFakeTimers();const p=expect(transactionQuorum(urls,capture.tx,async u=>wrap(u===urls[0]?tx:null))).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});await vi.advanceTimersByTimeAsync(1100);await p;});
 it('uniform absence does not waste a retry',async()=>{const read=vi.fn(async()=>wrap(null));await expect(transactionQuorum(urls,capture.tx,read)).rejects.toMatchObject({code:'TX_NOT_FOUND'});expect(read).toHaveBeenCalledTimes(3);});
 it('failed providers are not retried',async()=>{vi.useFakeTimers();const read=vi.fn(async u=>{if(u===urls[2])throw new Error('429');return wrap(u===urls[0]?tx:null);});const p=expect(transactionQuorum(urls,capture.tx,read)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});await vi.advanceTimersByTimeAsync(1100);await p;expect(read.mock.calls.filter(c=>c[0]===urls[2])).toHaveLength(1);});
 it('shares rate admission: one/1100ms and30/min',()=>{vi.useFakeTimers();for(let i=0;i<30;i++){expect(admitRetry(urls[0])).toBe(true);expect(admitRetry(urls[0])).toBe(false);vi.advanceTimersByTime(1100);}expect(admitRetry(urls[0])).toBe(false);});
});
it('two matching found providers may survive a persistent null minority after retry',async()=>{vi.useFakeTimers();const p=transactionQuorum(urls,capture.tx,async u=>wrap(u===urls[2]?null:tx));await vi.advanceTimersByTimeAsync(1100);expect((await p).result).toEqual(tx);});
it('fewer than two answering providers remains unreachable',async()=>{await expect(transactionQuorum(urls,capture.tx,async u=>{if(u!==urls[0])throw new Error('down');return wrap(tx);})).rejects.toMatchObject({code:'RPC_QUORUM_UNREACHABLE'});});
it.each(['hash','blockHash','blockNumber','from','to','value','nonce','input'])('missing required %s refuses',async field=>{const r={...tx};delete r[field];await expect(transactionQuorum(urls,capture.tx,async()=>wrap(r))).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});});
it('two distinct providers required, not duplicate URLs',async()=>{await expect(transactionQuorum([urls[0],urls[0]],capture.tx,async()=>wrap(tx))).rejects.toMatchObject({code:'RPC_QUORUM_UNREACHABLE'});});
it('bounded transaction leg cannot hold two matching results forever',async()=>{vi.useFakeTimers();const p=transactionQuorum(urls,capture.tx,async u=>u===urls[2]?new Promise(()=>{}):wrap(tx));await vi.advanceTimersByTimeAsync(4200);expect((await p).result).toEqual(tx);});
it('two-provider actual key-order disagreement alone still agrees',async()=>{expect((await transactionQuorum([urls[0],urls[2]],capture.tx,async u=>{const p=capture.providers.find((p:any)=>p.url===u);return {body:p.body,result:JSON.parse(p.body).result};})).result).toEqual(tx);});
it('two-provider optional absence still agrees',async()=>{const lean={...tx};for(const k of ['r','s','v','type'])delete lean[k];expect((await transactionQuorum(urls.slice(0,2),capture.tx,async u=>wrap(u===urls[0]?lean:tx))).result).toEqual(lean);});

it.each([
 ['hash','0x'+'a'.repeat(64)],['blockHash','0x'+'b'.repeat(64)],['blockNumber','0x1'],
 ['from','0x'+'a'.repeat(40)],['to','0x'+'b'.repeat(40)],['value','0x1'],['nonce','0x1'],['input','0xab'],
])('required %s differing values cannot agree',async(field,value)=>{
 const changed={...tx,[field]:value};
 await expect(transactionQuorum(urls.slice(0,2),capture.tx,async u=>wrap(u===urls[0]?tx:changed))).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});
});
it('optional-absent anchor cannot bridge gas-A and gas-B into a three-leg group',()=>{
 const absent={...tx};delete absent.gas;
 const gasA={...tx,gas:'0x1'},gasB={...tx,gas:'0x2'};
 const group=selectCompatibleTransactions([absent,gasA,gasB]);
 expect(group).toHaveLength(2);expect(group).toEqual([absent,gasA]);
 expect(group).not.toContain(gasB);
});
