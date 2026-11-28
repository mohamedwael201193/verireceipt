import {describe,expect,it} from 'vitest';
import {chainShape,requestShape,refusalParamClass} from '../src/core/refusalClass';

describe('chainShape',()=>{
 it('labels a named chain with a network word',()=>{
  const s=chainShape('Ethereum Mainnet');
  expect(s).toMatchObject({first_token_known:'ethereum',has_space:true,has_network_word:true,case_variant:'mixed',len_bucket:'9-16',ascii:true});
 });
 it('labels upper case aliases',()=>{
  expect(chainShape('ETH')).toMatchObject({case_variant:'upper',first_token_known:'eth',len_bucket:'1-3'});
  expect(chainShape('arbitrum-one')).toMatchObject({has_hyphen:true,first_token_known:'arbitrum',case_variant:'lower'});
 });
 it('never carries input characters',()=>{
  const raw='ж'.repeat(20)+'世'.repeat(20);
  const s=chainShape(raw);
  expect(s).toMatchObject({len_bucket:'>32',ascii:false,first_token_known:'none'});
  const j=JSON.stringify(s);
  for(const ch of new Set(raw))expect(j.includes(ch)).toBe(false);
 });
 it('handles empty',()=>{expect(chainShape('')).toMatchObject({len_bucket:'0',has_space:false,first_token_known:'none'});});
 it('is part of the gas-price CHAIN_NOT_SERVED refusal class',()=>{
  const c=refusalParamClass('/v1/gas-price','CHAIN_NOT_SERVED',{chain:'Polygon PoS'})!;
  expect(c).toMatchObject({chain_class:'other',first_token_known:'polygon',has_network_word:true});
  expect(refusalParamClass('/v1/gas-price','CHAIN_NOT_SERVED',{chain:'eth'})).toMatchObject({chain_class:'eth'});
 });
});
describe('requestShape',()=>{
 it('empty',()=>{expect(requestShape({})).toEqual({param_count:0,keys_in_closed_list:[],unknown_key_count:0});});
 it('known key',()=>{expect(requestShape({subject:'x'})).toEqual({param_count:1,keys_in_closed_list:['subject'],unknown_key_count:0});});
 it('unknown key counted, never logged',()=>{
  const s=requestShape({zzz:'1'});
  expect(s.unknown_key_count).toBe(1);expect(JSON.stringify(s)).not.toContain('zzz');
  expect(requestShape({a:1,b:2,c:3,chain:'x'}).param_count).toBe('3+');
 });
 it('non-object',()=>{expect(requestShape(undefined).param_count).toBe(0);});
});
