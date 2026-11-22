// Synthetic transports only, including an explicit market in the paid input.
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
async function run(value:number,withMarket=true,mappedMissing=false,metadataStatus:'unavailable'|'missing'|'rejected'='unavailable'){
 const dir=mkdtempSync(join(tmpdir(),'grid-source-integration-'));dirs.push(dir);
 const ledgerFile=join(dir,'runs.jsonl');
 const spend=spendLedgerFromFiles({reservationsFile:join(dir,'reserve.jsonl'),lockFile:join(dir,'lock'),runLedgerFiles:[ledgerFile]});
 const params:Record<string,string>={node_or_zone:'ZONE_J',interval_start:'2020-01-15T15:00:00Z',...(withMarket?{market:'RTM'}:{})};
 const c={id:'grid-source-fixture',intent:'GRID_POWER_PRICE_GENERAL',params,valueField:'lmp_usd_per_mwh',question:'Synthetic explicit NYISO RTM interval'};
 const frozenCaseSet={version:'fixture-v1',cases:[{id:c.id,intent:c.intent,params,value_field:c.valueField,question:c.question}]};
 const casesHash=createHash('sha256').update(canonicalPayloadJson(frozenCaseSet)).digest('hex');
 const base=node({fieldStatus:{lmp_usd_per_mwh:'ok',...(mappedMissing?{node_or_zone:metadataStatus,market:metadataStatus,interval_start:metadataStatus,currency:metadataStatus}:{})},engineResultFields:mappedMissing?{node_or_zone:null,market:null,interval_start:null,currency:null}:undefined,upstreamUrl:'https://mis.nyiso.com/public/csv/realtime/20200115realtime_zone.csv',intent:c.intent,requestParams:params,valueField:c.valueField,value,miner:'9999',minerSlug:'synthetic-provider',resultFields:{node_or_zone:'N.Y.C.',interval_start:params.interval_start,market:'NYISO',currency:'USD'}}).f;
 let requests=0;
 const f=async(url:RequestInfo|URL,init?:RequestInit)=>{requests++;return String(url).startsWith('https://mis.nyiso.com/')?new Response('Time Stamp,Name,PTID,LBMP ($/MWHr)\n01/15/2020 10:00:00,N.Y.C.,61761,17.25\n'):base(url,init);};
 const payer=makePayer();
 const record=await runProbe(c,payer,{frozenCaseSet,casesVersion:'fixture-v1',casesHash,ledgerFile,spend,f});
 return {record,payer,requests};
}
describe('grid source contract is enforced in purchase path',()=>{
 it('does not buy when the frozen request omits a market',async()=>{
  const {record,payer,requests}=await run(17.25,false);expect(record.outcome).toBe('ABSTAIN');expect(payer.signMessage).not.toHaveBeenCalled();expect(requests).toBe(0);expect(record.reasons.join(' ')).toMatch(/market/);
 });
 it('abstains on a well-receipted but wrong official interval price',async()=>{
  const {record}=await run(99);expect(record.outcome).toBe('ABSTAIN');expect(record.source_verification?.status).toBe('failed');
 });
 it('uses hash-bound provider metadata when mapped identity fields are null',async()=>{
  const {record}=await run(17.25,true,true);expect(record.outcome).toBe('ANSWERED');expect(record.source_verification?.status).toBe('verified');
 });
 it.each(['missing','rejected'] as const)('does not replace metadata marked %s from raw',async(status)=>{
  const {record}=await run(17.25,true,true,status);expect(record.outcome).toBe('ABSTAIN');
 });
 it('answers when explicit contract and independently fetched official row agree',async()=>{
  const {record}=await run(17.25);expect(record.outcome).toBe('ANSWERED');expect(record.source_verification?.status).toBe('verified');
 });
});
