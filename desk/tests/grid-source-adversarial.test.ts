// Synthetic adversarial contracts and schemas. No benchmark answer lookup.
import { describe, expect, it } from 'vitest';
import { gridContract, parseCaisoRows, parseNyisoRows, verifyGridSource } from '../src/gridSource';
const params={node_or_zone:'ZONE_J',market:'RTM',interval_start:'2020-01-15T15:00:00Z'};
const ny=gridContract(params),ca=gridContract({node_or_zone:'TH_NP15_GEN-APND',market:'DAM',interval_start:params.interval_start});
const header='Time Stamp,Name,PTID,LBMP ($/MWHr)';
const csv=header+'\n01/15/2020 10:00:00,N.Y.C.,61761,17.25\n';
const result={node_or_zone:'ZONE_J',market:'NYISO',interval_start:params.interval_start,currency:'USD',lmp_usd_per_mwh:17.25};
const url='https://mis.nyiso.com/public/csv/realtime/20200115realtime_zone.csv';
describe('grid product evidence and strict official schemas',()=>{
 it('accepts operator-form market only with grounded product evidence',async()=>{
  for(const extra of [{product:'RTM'},{receipt:{upstream_url:url}}])expect((await verifyGridSource({params,result:{...result,...extra}},{f:async()=>new Response(csv)})).status).toBe('verified');
 });
 it('accepts CAISO ISO-form only with exact hourly DAM receipt query',async()=>{
  const {readFileSync}=await import('node:fs');const {join}=await import('node:path');
  const bytes=readFileSync(join(__dirname,'fixtures/unit-grid-caiso.zip'));
  const caParams={node_or_zone:ca.node,market:'DAM',interval_start:params.interval_start};
  const upstream='https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP&startdatetime=20200115T15:00-0000&enddatetime=20200115T16:00-0000&market_run_id=DAM&node=TH_NP15_GEN-APND';
  const paid={node_or_zone:ca.node,market:'CAISO',interval_start:params.interval_start,currency:'USD',lmp_usd_per_mwh:23.125};
  for(const [url,expected] of [[upstream,'verified'],[upstream.replace('=DAM','=RTM'),'failed'],[upstream+'&market_run_id=RTM','failed'],[upstream.replace('T16:00','T15:05'),'failed']] as const){
   expect((await verifyGridSource({params:caParams,result:{...paid,receipt:{upstream_url:url}}},{f:async()=>new Response(bytes)})).status).toBe(expected);
  }
 });
 it('never treats a bare ISO label as proof of the requested product',async()=>{
  expect((await verifyGridSource({params,result},{f:async()=>new Response(csv)})).status).toBe('failed');
 });
 it.each([{product:'DAM'},{market:'CAISO',product:'RTM'},{receipt:{upstream_url:url.replace('realtime','dam')}},{product:'RTM',market_run_id:'DAM'}])('rejects wrong or contradictory product metadata %j',async(extra)=>{
  expect((await verifyGridSource({params,result:{...result,...extra}},{f:async()=>new Response(csv)})).status).toBe('failed');
 });
 it.each([
  csv.replace('($/MWHr)','(EUR/MWHr)'),
  csv.replace(header,header+',LBMP ($/MWHr)').replace(',17.25',',17.25,999'),
  csv.replace('17.25','1"7.2"5'),
 ])('rejects malformed units, duplicate headers and internal quotes',text=>expect(()=>parseNyisoRows(text,ny)).toThrow());
 it.each([
  'INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,NODE,XML_DATA_ITEM,MW,MARKET_RUN_ID,MARKET_RUN_ID\n2020-01-15T15:00:00Z,2020-01-15T16:00:00Z,TH_NP15_GEN-APND,LMP_PRC,23,DAM,RTM\n',
  'INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,NODE,XML_DATA_ITEM,MW,MARKET_RUN_ID\n2020-01-15T15:00:00Z,2020-01-15T15:05:00Z,TH_NP15_GEN-APND,LMP_PRC,23,DAM\n',
 ])('rejects conflicting CAISO columns and subhour duration',text=>expect(()=>parseCaisoRows(text,ca)).toThrow());
 it('requires complete chronological repeated-hour blocks and both neighbours',()=>{
  const lines=[header,'11/01/2020 00:55:00,N.Y.C.,61761,9'];
  for(let occurrence=0;occurrence<2;occurrence++)for(let slot=0;slot<12;slot++)lines.push('11/01/2020 01:'+String(slot*5).padStart(2,'0')+':00,N.Y.C.,61761,'+(100+100*occurrence+slot));
  lines.push('11/01/2020 02:00:00,N.Y.C.,61761,300');
  const target=gridContract({...params,interval_start:'2020-11-01T05:30:00Z'});
  expect(parseNyisoRows(lines.join('\n'),target)).toBe(106);
  expect(parseNyisoRows(lines.join('\n'),gridContract({...params,interval_start:'2020-11-01T06:30:00Z'}))).toBe(206);
  expect(()=>parseNyisoRows(lines.slice(0,-1).join('\n'),target)).toThrow();
  expect(()=>parseNyisoRows([header,lines[1],...lines.slice(2,14),...lines.slice(14,26).reverse(),lines[26]].join('\n'),target)).toThrow();
 });
 it('rejects an isolated reversed repeated-wall-time pair',()=>{
  const text=header+'\n11/01/2020 01:30:00,N.Y.C.,61761,222.22\n11/01/2020 01:30:00,N.Y.C.,61761,111.11\n';
  expect(()=>parseNyisoRows(text,gridContract({...params,interval_start:'2020-11-01T05:30:00Z'}))).toThrow();
 });
});
