// Synthetic end-to-end transports. They prove that primary-source checks
// affect gate/probe decisions, not merely an isolated helper result.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProbe, spendLedgerFromFiles } from '../src/gate';
import { canonicalPayloadJson } from '../src/verify';
import { node, makePayer } from './gateNodeFixture';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const params={entity:'Form 8-K filings by Example Corp (CIK 987654)',period:'calendar 2019'};
const c={id:'source-contract-fixture',intent:'REGULATORY_FILING_MONITOR_GENERAL',params,valueField:'filing_count',question:'Synthetic exact filing-count query'};
async function run(count:number,sourceStatus=200){
 const dir=mkdtempSync(join(tmpdir(),'source-integration-'));dirs.push(dir);
 const ledgerFile=join(dir,'runs.jsonl');
 const spend=spendLedgerFromFiles({reservationsFile:join(dir,'reserve.jsonl'),lockFile:join(dir,'lock'),runLedgerFiles:[ledgerFile]});
 const frozenCaseSet={version:'fixture-v1',cases:[{id:c.id,intent:c.intent,params:c.params,value_field:c.valueField,question:c.question}]};
 const casesHash=createHash('sha256').update(canonicalPayloadJson(frozenCaseSet)).digest('hex');
 const network=node({intent:c.intent,requestParams:params,valueField:c.valueField,value:count,miner:'9999',minerSlug:'synthetic-provider'}).f;
 const f=async(input:RequestInfo|URL,init?:RequestInit)=>String(input).startsWith('https://data.sec.gov/')
  ?sourceStatus!==200?new Response('unavailable',{status:sourceStatus}):Response.json({cik:987654,name:'Example Corp',filings:{recent:{accessionNumber:['0000987654-19-000001'],filingDate:['2019-02-03'],form:['8-K']},files:[]}})
  :network(input,init);
 return runProbe(c,makePayer(),{frozenCaseSet,casesVersion:'fixture-v1',casesHash,ledgerFile,spend,f,secUserAgent:'Fixture fixture@example.invalid'});
}
describe('source check is enforced by the live probe path',()=>{
 it('does not credit a well-receipted but wrong filing count',async()=>{
  const r=await run(4);expect(r.outcome).toBe('ABSTAIN');expect(r.reasons.join(' ')).toMatch(/primary source filing count/);
  expect(r.source_verification?.status).toBe('failed');expect(r.purchase.paid_uusdc).toBe('10000');
 });
 it('accepts a primary-recounted filing count from any routed provider',async()=>{
  const r=await run(1);expect(r.outcome).toBe('ANSWERED');expect(r.source_verification?.status).toBe('verified');expect(r.source_verification?.sources).toHaveLength(1);
 });
 it('abstains on unavailable primary evidence even when provenance passes',async()=>{
  const r=await run(1,403);expect(r.outcome).toBe('ABSTAIN');expect(r.reasons.join(' ')).toMatch(/primary HTTP 403/);
 });
});
