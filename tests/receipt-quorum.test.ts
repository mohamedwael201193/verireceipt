import {afterEach,describe,it,expect,vi} from 'vitest';import{readFileSync}from'node:fs';import{join}from'node:path';
import{receiptQuorum,resetReceiptRetryForTests}from'../src/core/receiptQuorum';
const raw=readFileSync(join(__dirname,'fixtures/crypto-transfer/eth-usdc-transfer-receipt.json'),'utf8'),receipt=JSON.parse(raw),hash=receipt.transactionHash;
const urls=['https://a.invalid','https://b.invalid','https://c.invalid'];
const reply=(r:unknown)=>({body:JSON.stringify({jsonrpc:'2.0',id:1,result:r}),result:r});
afterEach(()=>{vi.useRealTimers();resetReceiptRetryForTests();});
describe('receipt-only bounded null/found recovery',()=>{
 it('replays accepted actual receipt without retry and retains exact source bodies',async()=>{const f=vi.fn(async()=>({body:raw,result:receipt}));const out=await receiptQuorum(urls,hash,f);expect(out.result).toEqual(receipt);expect(f).toHaveBeenCalledTimes(3);expect(Object.values(out.bodies)).toEqual([raw,raw,raw]);});
 it('retries once after1100ms then accepts two present sources despite missing minority',async()=>{vi.useFakeTimers();const f=vi.fn(async(u:string)=>reply(u===urls[2]?null:receipt));const p=receiptQuorum(urls,hash,f);await vi.advanceTimersByTimeAsync(1099);expect(f).toHaveBeenCalledTimes(3);await vi.advanceTimersByTimeAsync(1);const out=await p;expect(out.result).toEqual(receipt);expect(f).toHaveBeenCalledTimes(6);expect(Object.keys(out.bodies)).toHaveLength(6);expect(Object.values(out.bodies).filter(b=>JSON.parse(b).result===null)).toHaveLength(2);});
 it('a single present provider never becomes quorum by voting twice',async()=>{vi.useFakeTimers();const f=vi.fn(async(u:string)=>reply(u===urls[0]?receipt:null));const p=expect(receiptQuorum(urls,hash,f)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});await vi.advanceTimersByTimeAsync(1100);await p;expect(f).toHaveBeenCalledTimes(6);});
 it('null majority cannot hide one found receipt',async()=>{vi.useFakeTimers();let n=0;const f=vi.fn(async(u:string)=>reply(++n<=3&&u===urls[0]?receipt:null));const p=expect(receiptQuorum(urls,hash,f)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});await vi.advanceTimersByTimeAsync(1100);await p;});
 it('uniform null consensus retains old absence behavior without retry',async()=>{const f=vi.fn(async()=>reply(null));expect((await receiptQuorum(urls,hash,f)).result).toBeNull();expect(f).toHaveBeenCalledTimes(3);});
 it.each(['status','blockHash','blockNumber','transactionHash','logs'])('conflicting %s refuses even against two matching sources',async field=>{const changed=structuredClone(receipt);changed[field]=field==='logs'?[]:field==='status'?'0x0':field==='blockNumber'?'0x1':'0x'+'a'.repeat(64);const f=vi.fn(async(u:string)=>reply(u===urls[2]?changed:receipt));await expect(receiptQuorum(urls,hash,f)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});expect(f).toHaveBeenCalledTimes(3);});
 it('harmless extra metadata and hex quantity padding do not cause false disagreement',async()=>{const changed={...receipt,extraProviderField:true,blockNumber:'0x0'+receipt.blockNumber.slice(2),status:'0x01'};expect((await receiptQuorum(urls,hash,async u=>reply(u===urls[2]?changed:receipt))).result).toEqual(receipt);});
 it('only providers that answered are retried, never a rate-limited or failed leg',async()=>{vi.useFakeTimers();const f=vi.fn(async(u:string)=>{if(u===urls[2])throw new Error('HTTP429');return reply(u===urls[0]?receipt:null);});const p=expect(receiptQuorum(urls,hash,f)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});await vi.advanceTimersByTimeAsync(1100);await p;expect(f.mock.calls.filter(c=>c[0]===urls[2])).toHaveLength(1);});
 it('duplicate URL does not provide two votes',async()=>{await expect(receiptQuorum([urls[0],urls[0]],hash,async()=>reply(receipt))).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});});
 it('hanging leg is bounded and cannot prevent two-receipt success',async()=>{vi.useFakeTimers();const p=receiptQuorum(urls,hash,async u=>u===urls[2]?new Promise(()=>{}):reply(receipt));await vi.advanceTimersByTimeAsync(4200);expect((await p).result).toEqual(receipt);});
});

it('concurrent disagreement retries are rate-gated per provider',async()=>{
 vi.useFakeTimers();const f=vi.fn(async(u:string)=>reply(u===urls[2]?null:receipt));const a=receiptQuorum(urls,hash,f),b=expect(receiptQuorum(urls,hash,f)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});await vi.advanceTimersByTimeAsync(1100);await a;await b;expect(f).toHaveBeenCalledTimes(9);
});

it.each(['status','blockHash','blockNumber','logs','transactionHash'])('first-round found then changed %s refuses and retains first-round raw evidence',async field=>{
 vi.useFakeTimers();let calls=0;const changed=structuredClone(receipt);changed[field]=field==='logs'?[]:field==='status'?'0x0':field==='blockNumber'?'0x1':'0x'+'a'.repeat(64);
 const first=reply(receipt),missing=reply(null),second=reply(changed);
 const f=vi.fn(async(u:string)=>{calls++;return calls<=3?(u===urls[2]?missing:first):second;});
 const outcome=receiptQuorum(urls,hash,f).then(()=>{throw new Error('unexpected successful changed receipt');},error=>error);
 await vi.advanceTimersByTimeAsync(1100);const error=await outcome;expect(error.code).toBe('RPC_QUORUM_DISAGREEMENT');expect(error.receiptEvidence['attempt1:'+urls[0]]).toBe(first.body);expect(error.receiptEvidence['attempt1:'+urls[2]]).toBe(missing.body);expect(error.receiptEvidence['attempt2:'+urls[0]]).toBe(second.body);expect(f).toHaveBeenCalledTimes(6);
});

it('public HTTP error serialization never includes attached internal receipt evidence',async()=>{
 const {errorBody}=await import('../src/core/errors');let error:unknown;
 try{await receiptQuorum(urls,hash,async u=>reply(u===urls[2]?{...receipt,status:'0x0'}:receipt));}catch(e){error=e;}
 expect(error).toHaveProperty('receiptEvidence');const body=errorBody(error);expect(Object.keys(body).sort()).toEqual(['code','error','message']);expect(JSON.stringify(body)).not.toContain('attempt1');expect(JSON.stringify(body)).not.toContain(receipt.transactionHash);
});
