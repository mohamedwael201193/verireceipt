import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyGridSource } from '../src/gridSource';
import { reconcilePrimaryAnswer } from '../src/sourceTypes';
const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/node-shaped/grid-caiso.json',import.meta.url),'utf8'));
const raw=fixture.raw;
const params={node_or_zone:raw.node_or_zone,interval_start:raw.interval_start,market:'DAM'};
const bytes=readFileSync(join(__dirname,'fixtures/unit-grid-real-caiso.zip'));
const options={f:async()=>new Response(bytes)};
describe('real CAISO cached containing-window contract',()=>{
 it('accepts the real 26-hour ingester receipt while fetching the exact hourly row',async()=>{
  const r=await verifyGridSource({params,result:raw},options);expect(r.status).toBe('verified');
  const source=new URL(r.sources[0].url);expect(source.searchParams.get('startdatetime')).toBe('20261121T11:00-0000');expect(source.searchParams.get('enddatetime')).toBe('20261121T12:00-0000');
 });
 it('can use complete hash-bound provider identity when mapped metadata is unavailable',async()=>{
  expect((await verifyGridSource({params,result:reconcilePrimaryAnswer('GRID_POWER_PRICE_GENERAL',fixture.node.result,fixture.node.field_status,raw,true).result,providerResult:raw},options)).status).toBe('verified');
 });
 it.each([
  ['startdatetime','20261121T11:01-0000'],['enddatetime','20261121T11:59-0000'],
  ['startdatetime','20261119T11:26-0000'],['enddatetime','20261120T10:26-0000'],
  ['startdatetime','20260230T11:00-0000'],['market_run_id','RTM'],['node','TH_SP15_GEN-APND'],
 ])('rejects an invalid/non-containing/oversized or wrong-product window: %s',async(key,value)=>{
  const u=new URL(raw.receipt.upstream_url);u.searchParams.set(key,value);
  expect((await verifyGridSource({params,result:{...raw,receipt:{...raw.receipt,upstream_url:u.href}}},options)).status).toBe('failed');
 });
 it('still rejects non-null mapped identity contradictions and incorrect prices',async()=>{
  for(const extra of [{market:'RTM'},{node_or_zone:'TH_SP15_GEN-APND'},{currency:'EUR'},{interval_start:'2026-11-21T12:00:00Z'},{lmp_usd_per_mwh:999}]){
   expect((await verifyGridSource({params,result:{...fixture.node.result,...extra},providerResult:raw},options)).status).toBe('failed');
  }
 });
});
