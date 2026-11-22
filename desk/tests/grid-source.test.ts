// Synthetic official-feed fixtures. Independent parser/contract tests, no
// benchmark gold and no live network or purchase.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { gridContract, officialCsvFromZip, parseCaisoRows, parseNyisoRows, verifyGridSource } from '../src/gridSource';
const nyiso='Time Stamp,Name,PTID,LBMP ($/MWHr)\n01/15/2020 10:00:00,N.Y.C.,61761,17.25\n01/15/2020 10:05:00,N.Y.C.,61761,19.75\n';
const caiso='INTERVALSTARTTIME_GMT,NODE,XML_DATA_ITEM,MW,MARKET_RUN_ID\n2020-01-15T15:00:00-00:00,TH_NP15_GEN-APND,LMP_PRC,23.125,DAM\n2020-01-15T15:00:00-00:00,TH_NP15_GEN-APND,LMP_PRC,44.5,RTM\n';
const nyParams={node_or_zone:'ZONE_J',interval_start:'2020-01-15T15:00:00Z',market:'RTM'};
const caParams={node_or_zone:'TH_NP15_GEN-APND',interval_start:'2020-01-15T15:00:00Z',market:'DAM'};
const nyResult={node_or_zone:'N.Y.C.',interval_start:nyParams.interval_start,market:'RTM',currency:'USD',lmp_usd_per_mwh:17.25};
describe('grid market/source contract',()=>{
 it('rejects an omitted or unsupported market instead of guessing a default',()=>{
  expect(()=>gridContract({node_or_zone:'TH_NP15_GEN-APND',interval_start:caParams.interval_start})).toThrow(/market/);
  expect(()=>gridContract({...caParams,market:'RTM'})).toThrow(/market/);
  expect(()=>gridContract({...nyParams,market:'DAM'})).toThrow(/market/);
 });
 it.each(['2020-02-30T15:00:00Z','2020-01-15T15:01:00Z','2020-01-15T15:00:00+01:00'])('rejects impossible or non-grid-aligned intervals %s',(interval_start)=>{
  expect(()=>gridContract({...nyParams,interval_start})).toThrow();
 });
 it('matches the exact NYISO zone and local-to-UTC interval',()=>{
  expect(parseNyisoRows(nyiso,gridContract(nyParams))).toBe(17.25);
  expect(parseNyisoRows(nyiso,gridContract({...nyParams,interval_start:'2020-01-15T15:05:00Z'}))).toBe(19.75);
  expect(()=>parseNyisoRows(nyiso,gridContract({...nyParams,node_or_zone:'ZONE_K'}))).toThrow(/matching/);
 });
 it('selects the CAISO DAM LMP row, never RTM or a component',()=>{
  expect(parseCaisoRows(caiso,gridContract(caParams))).toBe(23.125);
  expect(()=>parseCaisoRows(caiso.replace(',23.125,DAM',',23.125,RTM'),gridContract(caParams))).toThrow(/matching/);
  expect(()=>parseCaisoRows(caiso.replace('LMP_PRC,23.125','MCC_PRC,23.125'),gridContract(caParams))).toThrow(/matching/);
 });
 it('rejects duplicate matching rows, blank prices and wrong interval values',()=>{
  expect(()=>parseCaisoRows(caiso+caiso.split('\n')[1]+'\n',gridContract(caParams))).toThrow(/matching/);
  expect(()=>parseCaisoRows(caiso.replace(',23.125,DAM',',,DAM'),gridContract(caParams))).toThrow();
  expect(()=>parseCaisoRows(caiso.replaceAll('15:00:00','16:00:00'),gridContract(caParams))).toThrow(/matching/);
 });
 it('handles DST repeated hours only with both explicit occurrences',()=>{
  const repeated='Time Stamp,Name,PTID,LBMP ($/MWHr)\n11/01/2020 01:30:00,N.Y.C.,61761,11\n11/01/2020 01:30:00,N.Y.C.,61761,22\n';
  expect(parseNyisoRows(repeated,gridContract({...nyParams,interval_start:'2020-11-01T05:30:00Z'}))).toBe(11);
  expect(parseNyisoRows(repeated,gridContract({...nyParams,interval_start:'2020-11-01T06:30:00Z'}))).toBe(22);
  expect(()=>parseNyisoRows(repeated.split('\n').slice(0,2).join('\n'),gridContract({...nyParams,interval_start:'2020-11-01T05:30:00Z'}))).toThrow();
 });
 it('records exact official source bytes and independently compares the number',async()=>{
  const f=vi.fn(async()=>new Response(nyiso,{headers:{'content-type':'text/csv'}}));
  const good=await verifyGridSource({params:nyParams,result:nyResult},{f:f as typeof fetch});expect(good.status).toBe('verified');expect(good.sources[0].raw_text).toBe(nyiso);
  const bad=await verifyGridSource({params:nyParams,result:{...nyResult,lmp_usd_per_mwh:100}},{f:f as typeof fetch});expect(bad.status).toBe('failed');
 });
 it.each([
  {market:'DAM'},{node_or_zone:'ZONE_K'},{interval_start:'2020-01-15T15:05:00Z'},{currency:'EUR'},
 ])('rejects contradictory paid fields even with a correct number %j',async(mutation)=>{
  const f=vi.fn(async()=>new Response(nyiso));
  const r=await verifyGridSource({params:nyParams,result:{...nyResult,...mutation}},{f:f as typeof fetch});expect(r.status).toBe('failed');
 });
 it('reads bounded ZIP evidence and proves the exact CAISO DAM row',async()=>{
  const bytes=readFileSync(join(__dirname,'fixtures/unit-grid-caiso.zip'));
  expect(parseCaisoRows(officialCsvFromZip(bytes),gridContract(caParams))).toBe(23.125);
  const f=vi.fn(async()=>new Response(bytes));
  const r=await verifyGridSource({params:caParams,result:{node_or_zone:caParams.node_or_zone,interval_start:caParams.interval_start,market:'DAM',currency:'USD',lmp_usd_per_mwh:23.125}},{f:f as typeof fetch});
  expect(r.status).toBe('verified');expect(r.sources[0].encoding).toBe('base64');
 });
 it('uses a dated monthly archive only after a genuine daily-file 404',async()=>{
  const bytes=readFileSync(join(__dirname,'fixtures/unit-grid-nyiso-month.zip'));
  const f=vi.fn(async(url:string)=>url.endsWith('.csv')?new Response('not found',{status:404}):new Response(bytes));
  const r=await verifyGridSource({params:nyParams,result:nyResult},{f:f as typeof fetch});
  expect(r.status).toBe('verified');expect(f).toHaveBeenCalledTimes(2);
  expect(r.sources[0].url).toContain('20200101realtime_zone_csv.zip');
 });
 it('rejects corrupt, truncated or missing requested ZIP members',()=>{
  const bytes=readFileSync(join(__dirname,'fixtures/unit-grid-caiso.zip'));
  const corrupt=Buffer.from(bytes);corrupt[65]^=255;
  expect(()=>officialCsvFromZip(corrupt)).toThrow();
  expect(()=>officialCsvFromZip(bytes.subarray(0,50))).toThrow();
  expect(()=>officialCsvFromZip(bytes,'absent.csv')).toThrow();
 });
 it('fails closed on source throttling without retry or substitution',async()=>{
  const f=vi.fn(async()=>new Response('blocked',{status:403}));
  const r=await verifyGridSource({params:nyParams,result:nyResult},{f:f as typeof fetch});expect(r.status).toBe('failed');expect(f).toHaveBeenCalledTimes(1);
 });
});
