import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { receiptQuorum, resetReceiptRetryForTests } from '../src/core/receiptQuorum';
const capture=JSON.parse(readFileSync('tests/fixtures/receipt-legacy/ethereum-providers.json','utf8'));
const urls=capture.providers.map((p:any)=>p.url),options={legacyRootBeforeBlock:4370000n};
const results=capture.providers.map((p:any)=>JSON.parse(p.body).result);
const wrap=(result:any)=>({result,body:JSON.stringify({jsonrpc:'2.0',id:1,result})});
afterEach(()=>{vi.useRealTimers();resetReceiptRetryForTests();});
describe('captured Ethereum legacy receipt representation',()=>{
 it('reproduces the old separate-status/root projection disagreement',()=>{
  const keys=results.map((r:any)=>JSON.stringify({status:r.status??null,root:r.root??null}));
  expect(new Set(keys).size).toBe(2);
 });
 it('accepts actual unmodified bodies and preserves all of them',async()=>{
  const read=vi.fn(async(u:string)=>{const p=capture.providers.find((p:any)=>p.url===u);return {body:p.body,result:JSON.parse(p.body).result};});
  const out=await receiptQuorum(urls,capture.tx,read,options);
  expect(out.result).toEqual(results[0]);expect(read).toHaveBeenCalledTimes(3);
  expect(Object.values(out.bodies)).toEqual(capture.providers.map((p:any)=>p.body));
 });
 it('root-only may be the selected source without rewriting it',async()=>{
  const out=await receiptQuorum([...urls].reverse(),capture.tx,async u=>wrap(results[urls.indexOf(u)]),options);
  expect(out.result).toEqual(results[2]);expect(out.result).not.toHaveProperty('status');
 });
 it.each(['gasUsed','cumulativeGasUsed','blockNumber','blockHash','status','logs'])('refuses real-body mutation of %s',async field=>{
  const changed=structuredClone(results[2]);changed[field]=field==='status'?'0x0':field==='logs'?[{}]:field==='blockHash'?'0x'+'a'.repeat(64):'0x1';
  await expect(receiptQuorum(urls,capture.tx,async u=>wrap(u===urls[2]?changed:results[0]),options)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});
 });
 it('two explicit different roots cannot be bridged by a status-only success',async()=>{
  const changed={...results[2],root:'0x'+'a'.repeat(64)};
  await expect(receiptQuorum(urls,capture.tx,async u=>wrap(u===urls[0]?results[2]:u===urls[1]?results[0]:changed),options)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});
 });
 it('refuses root change across retry rounds',async()=>{
  vi.useFakeTimers();let n=0;const changed={...results[2],root:'0x'+'a'.repeat(64)};
  const p=expect(receiptQuorum(urls,capture.tx,async u=>wrap(++n<=3?(u===urls[2]?null:results[2]):changed),options)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});
  await vi.advanceTimersByTimeAsync(1100);await p;
 });
 it.each([4370000,4370001])('refuses root-only at or beyond fork %s',async block=>{
  const r={...results[2],blockNumber:'0x'+block.toString(16)};
  await expect(receiptQuorum(urls,capture.tx,async()=>wrap(r),options)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});
 });
 it('does not apply Ethereum fork policy without explicit chain scope',async()=>{
  await expect(receiptQuorum(urls,capture.tx,async()=>wrap(results[2]))).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});
 });
 it('refuses neither-status-nor-root and malformed roots',async()=>{
  for(const root of [undefined,'bad-root']) {const r={...results[2],root};await expect(receiptQuorum(urls,capture.tx,async()=>wrap(r),options)).rejects.toMatchObject({code:'RPC_QUORUM_DISAGREEMENT'});}
 });
});
