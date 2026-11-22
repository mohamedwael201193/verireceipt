// Synthetic JSON-RPC evidence only. No benchmark answers, live RPC or purchases.
import { describe, expect, it, vi } from 'vitest';
import { txContract, verifyTxSource } from '../src/txSource';
const hash='0x'+'12'.repeat(32), blockHash='0x'+'34'.repeat(32), from='0x'+'56'.repeat(20), to='0x'+'78'.repeat(20);
const params={tx_hash:hash,chain:'sepolia'};
const tx={hash,blockHash,blockNumber:'0x2a',chainId:'0xaa36a7',from,to,value:'0xde0b6b3a7640000'};
const receipt={transactionHash:hash,blockHash,blockNumber:'0x2a',status:'0x1',from,to};
const result={tx_hash:hash,status:'confirmed',block_number:42,from,to,value_eth:'1'};
function transport(change?:(method:string,value:any,index:number)=>any){
 let index=0;
 return vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
  const q=JSON.parse(String(init?.body));
  const value=q.method==='eth_chainId'?'0xaa36a7':q.method==='eth_getTransactionByHash'?{...tx}:{...receipt};
  return Response.json({jsonrpc:'2.0',id:q.id,result:change?change(q.method,value,index++):value});
 });
}
describe('chain-bound independent TX block evidence',()=>{
 it('requires a supported explicit chain and a strict hash, without mainnet fallback',()=>{
  for(const p of [{tx_hash:hash},{...params,chain:'typo'},{...params,tx_hash:'0x123'},{...params,tx_hash:hash+' on ethereum'}])expect(()=>txContract(p)).toThrow();
 });
 it('supports the real builder hash/chain suffix and rejects disagreement',()=>{
  expect(txContract({tx_hash:hash+' on Ethereum'}).chain).toBe('ethereum');
  expect(txContract({tx_hash:hash+' on ETH',chain:'mainnet'}).chain).toBe('ethereum');
  expect(()=>txContract({tx_hash:hash+' on Ethereum',chain:'sepolia'})).toThrow();
 });
 it('binds both RPC chain IDs, transaction, receipt and exact block; saves raw evidence',async()=>{
  const f=transport();const r=await verifyTxSource({params,result},{f});
  expect(r.status).toBe('verified');expect(r.sources).toHaveLength(6);expect(f).toHaveBeenCalledTimes(6);
  expect(new Set(f.mock.calls.map(x=>String(x[0]))).size).toBe(2);
  expect(r.details.primary_value).toBe(42);expect(r.sources[0].raw_text).toContain('0xaa36a7');
 });
 it.each([
  ['eth_chainId',()=> '0x1'],
  ['eth_getTransactionByHash',(v:any)=>({...v,hash:'0x'+'ab'.repeat(32)})],
  ['eth_getTransactionByHash',(v:any)=>({...v,chainId:'0x1'})],
  ['eth_getTransactionByHash',(v:any)=>({...v,blockNumber:'0x2b'})],
  ['eth_getTransactionByHash',(v:any)=>({...v,blockHash:'0x'+'ff'.repeat(32)})],
  ['eth_getTransactionByHash',()=> null],
  ['eth_getTransactionReceipt',()=> null],
  ['eth_getTransactionReceipt',(v:any)=>({...v,transactionHash:'0x'+'ff'.repeat(32)})],
  ['eth_getTransactionReceipt',(v:any)=>({...v,blockNumber:'-42'})],
  ['eth_getTransactionReceipt',(v:any)=>({...v,blockNumber:'0x20000000000000'})],
  ['eth_getTransactionReceipt',(v:any)=>({...v,status:'0x2'})],
  ['eth_getTransactionReceipt',(v:any)=>({...v,status:undefined})],
  ['eth_getTransactionReceipt',(v:any)=>({...v,from:'0x'+'aa'.repeat(20)})],
 ])('refuses missing or contradictory RPC evidence %s',async(method,change)=>{
  const r=await verifyTxSource({params,result},{f:transport((m,v)=>m===method?(change as Function)(v):v)});expect(r.status).toBe('failed');
 });
 it('requires both independently fetched endpoint observations to agree',async()=>{
  const f=transport((method,v,index)=>index>=3&&method==='eth_getTransactionReceipt'?{...v,status:'0x0'}:v);
  expect((await verifyTxSource({params,result},{f})).status).toBe('failed');
 });
 it.each([
  {block_number:43},{block_number:-1},{block_number:42.5},{block_number:'42'},
  {status:'pending'},{status:'reverted'},{tx_hash:'0x'+'ff'.repeat(32)},
  {chain:'ethereum'},{from:'0x'+'ff'.repeat(20)},{to:null},{value_eth:'2'},
 ])('rejects paid fields contradicting bound chain data %j',async(mutation)=>{
  expect((await verifyTxSource({params,result:{...result,...mutation}},{f:transport()})).status).toBe('failed');
 });
 it('accepts the real numeric value display and exact string form',async()=>{
  expect((await verifyTxSource({params,result:{...result,value_eth:1}},{f:transport()})).status).toBe('verified');
 });
 it('supports pre-Byzantium root evidence only on early Ethereum mainnet blocks',async()=>{
  const f=transport((m,v)=>m==='eth_chainId'?'0x1':m==='eth_getTransactionByHash'?{...v,chainId:'0x1',blockNumber:'0x3e8'}:{...v,blockNumber:'0x3e8',status:undefined,root:'0x'+'aa'.repeat(32)});
  expect((await verifyTxSource({params:{...params,chain:'ethereum'},result:{...result,block_number:1000}},{f})).status).toBe('verified');
 });
 it('refuses legacy root-only receipts that disagree across the two endpoints',async()=>{
  const f=transport((m,v,index)=>m==='eth_chainId'?'0x1':m==='eth_getTransactionByHash'?{...v,chainId:'0x1',blockNumber:'0x3e8'}:{...v,blockNumber:'0x3e8',status:undefined,root:'0x'+(index<3?'aa':'bb').repeat(32)});
  expect((await verifyTxSource({params:{...params,chain:'ethereum'},result:{...result,block_number:1000}},{f})).status).toBe('failed');
 });
 it('accepts a reverted transaction block only when the paid status also says reverted',async()=>{
  const f=transport((method,v)=>method==='eth_getTransactionReceipt'?{...v,status:'0x0'}:v);
  expect((await verifyTxSource({params,result:{...result,status:'reverted'}},{f})).status).toBe('verified');
 });
 it('abstains on source errors without retrying or switching chain',async()=>{
  const f=vi.fn(async()=>new Response('blocked',{status:403}));
  expect((await verifyTxSource({params,result},{f})).status).toBe('failed');expect(f).toHaveBeenCalledTimes(1);
 });
 it('rejects JSON-RPC errors, wrong IDs and missing result fields',async()=>{
  for(const body of [{jsonrpc:'2.0',id:1,error:{code:-1}},{jsonrpc:'2.0',id:999,result:'0xaa36a7'},{jsonrpc:'2.0',id:1}]){
   expect((await verifyTxSource({params,result},{f:async()=>Response.json(body)})).status).toBe('failed');
  }
 });
});
