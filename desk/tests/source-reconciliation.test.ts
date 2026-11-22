import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reconcilePrimaryAnswer } from '../src/sourceTypes';
describe('one shared primary-answer mapper reconciliation',()=>{
 it.each(['grid-caiso','grid-nyiso','grid-probe1'])('uses the saved node-shaped %s contract',name=>{
  const d=JSON.parse(readFileSync(new URL('../../tests/fixtures/node-shaped/'+name+'.json',import.meta.url),'utf8'));
  const r=reconcilePrimaryAnswer('GRID_POWER_PRICE_GENERAL',d.node.result,d.node.field_status,d.raw,true);
  expect(r.result.node_or_zone).toBe(d.raw.node_or_zone);expect(r.result.market).toBe(d.raw.market);
  expect(r.result.lmp_usd_per_mwh).toBe(d.node.result.lmp_usd_per_mwh);
  expect(r.fields.market.source).toBe(d.node.field_status.market==='unavailable'?'raw':'node');
 });
 it('never fills numeric unavailable, missing or rejected fields from raw',()=>{
  for(const status of ['unavailable','missing','rejected'] as const){
   const r=reconcilePrimaryAnswer('ONCHAIN_TX_LOOKUP_GENERAL',{block_number:null,value_eth:null},{block_number:status,value_eth:status},{block_number:42,value_eth:1},true);
   expect(r.result.block_number).toBeNull();expect(r.result.value_eth).toBeNull();expect(r.fields.block_number.source).toBe('none');
  }
 });
 it('requires verified raw and an explicit unavailable status for nonnumeric fills',()=>{
  for(const status of ['missing','rejected'] as const){
   const r=reconcilePrimaryAnswer('REGULATORY_FILING_MONITOR_GENERAL',{entity:null},{entity:status},{entity:'Example Corp'},true);expect(r.result.entity).toBeNull();
  }
  expect(reconcilePrimaryAnswer('REGULATORY_FILING_MONITOR_GENERAL',{entity:null},{entity:'unavailable'},{entity:'Example Corp'},false).result.entity).toBeNull();
  expect(reconcilePrimaryAnswer('REGULATORY_FILING_MONITOR_GENERAL',{entity:null},{},{entity:'Example Corp'},true).result.entity).toBeNull();
 });
 it('preserves ok mapped claims rather than replacing contradictions with raw',()=>{
  const r=reconcilePrimaryAnswer('GRID_POWER_PRICE_GENERAL',{market:'RTM'},{market:'ok'},{market:'CAISO'},true);
  expect(r.result.market).toBe('RTM');expect(r.fields.market.source).toBe('node');
 });
});
