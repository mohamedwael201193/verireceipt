// Synthetic paid/provenance and independent RPC responses. No live I/O.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProbe, spendLedgerFromFiles } from '../src/gate';
import { canonicalPayloadJson } from '../src/verify';
import { node, makePayer } from './gateNodeFixture';
const hash='0x'+'12'.repeat(32),blockHash='0x'+'34'.repeat(32),from='0x'+'56'.repeat(20),to='0x'+'78'.repeat(20);
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function run(value:number,chain='sepolia',rpcChain='0xaa36a7'){
 const dir=mkdtempSync(join(tmpdir(),'tx-source-integration-'));dirs.push(dir);
 const ledgerFile=join(dir,'runs.jsonl');
 const spend=spendLedgerFromFiles({reservationsFile:join(dir,'reserve.jsonl'),lockFile:join(dir,'lock'),runLedgerFiles:[ledgerFile]});
 const params={tx_hash:hash,...(chain?{chain}:{})};
 const c={id:'tx-source-fixture',intent:'ONCHAIN_TX_LOOKUP_GENERAL',params,valueField:'block_number',question:'Synthetic chain-explicit transaction block'};
 const frozenCaseSet={version:'fixture-v1',cases:[{id:c.id,intent:c.intent,params,value_field:c.valueField,question:c.question}]};
 const casesHash=createHash('sha256').update(canonicalPayloadJson(frozenCaseSet)).digest('hex');
 const base=node({intent:c.intent,requestParams:params,valueField:c.valueField,value,miner:'9999',minerSlug:'synthetic-provider',resultFields:{tx_hash:hash,status:'confirmed',from,to,value_eth:1}}).f;
 let requests=0,rpcRequests=0;
 const f=async(url:RequestInfo|URL,init?:RequestInit)=>{
  requests++;
  if(!String(url).startsWith('https://devnode.telegraphprotocol.com/')){
   rpcRequests++;const q=JSON.parse(String(init?.body));
   const result=q.method==='eth_chainId'?rpcChain:q.method==='eth_getTransactionByHash'?{hash,blockHash,blockNumber:'0x2a',from,to,value:'0xde0b6b3a7640000',chainId:'0xaa36a7'}:{transactionHash:hash,blockHash,blockNumber:'0x2a',from,to,status:'0x1'};
   return Response.json({jsonrpc:'2.0',id:q.id,result});
  }
  return base(url,init);
 };
 const payer=makePayer();const record=await runProbe(c,payer,{frozenCaseSet,casesVersion:'fixture-v1',casesHash,ledgerFile,spend,f});return {record,payer,requests,rpcRequests};
}
describe('TX source checks are mandatory on the purchase path',()=>{
 it('never buys a missing-chain request',async()=>{
  const {record,payer,requests}=await run(42,'');expect(record.outcome).toBe('ABSTAIN');expect(requests).toBe(0);expect(payer.signMessage).not.toHaveBeenCalled();
 });
 it('does not credit a wrong paid block number even with valid provenance',async()=>{
  const {record}=await run(43);expect(record.outcome).toBe('ABSTAIN');expect(record.source_verification?.status).toBe('failed');
 });
 it('does not credit a correct numeric block when RPC chain identity contradicts the request',async()=>{
  const {record}=await run(42,'sepolia','0x1');expect(record.outcome).toBe('ABSTAIN');expect(record.source_verification?.status).toBe('failed');
 });
 it('answers only after the two configured RPC endpoints bind the transaction and receipt',async()=>{
  const {record,rpcRequests}=await run(42);expect(record.outcome).toBe('ANSWERED');expect(record.source_verification?.status).toBe('verified');expect(rpcRequests).toBe(6);
 });
});
