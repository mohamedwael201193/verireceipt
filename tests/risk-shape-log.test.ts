import {afterEach,describe,expect,it,vi} from 'vitest';
import {recordRequestCompletion} from '../src/core/requestMetrics';
afterEach(()=>vi.restoreAllMocks());
describe('malformed risk hash shape only',()=>{
 it.each([['0xprivate-canary',16,'0x'],['0Xprivate-canary',16,'0X'],['private-canary',14,'none']])('records only safe shape for %s',(input,_length,prefix)=>{
  const spy=vi.spyOn(console,'info').mockImplementation(()=>{});
  recordRequestCompletion('/v1/transaction-risk',400,12,{query:{transaction:input},errorCode:'INVALID_TX_HASH'});
  const text=String(spy.mock.calls[0][0]),row=JSON.parse(text);
  expect(row.input_shape).toEqual({length:input.length,prefix,charset:'other',hex_digits:(input.replace(/^0x/i,'').match(/[0-9a-f]/gi)??[]).length,has_whitespace_inside:false});
  expect(Object.keys(row.input_shape).sort()).toEqual(['charset','has_whitespace_inside','hex_digits','length','prefix']);
  expect(text).not.toContain('private-canary');expect(text).not.toContain(input);
 });
 it.each([['/v1/transaction-risk',200,'INVALID_TX_HASH'],['/v1/transaction-risk',400,'INVALID_TRANSACTION'],['/v1/tx',400,'INVALID_TX_HASH']])('does not expand other diagnostics %s %s %s',(route,status,errorCode)=>{
  const spy=vi.spyOn(console,'info').mockImplementation(()=>{});
  recordRequestCompletion(route,status,1,{query:{transaction:'private-canary'},errorCode});
  expect(JSON.parse(String(spy.mock.calls[0][0]))).not.toHaveProperty('input_shape');
  expect(String(spy.mock.calls[0][0])).not.toContain('private-canary');
 });
 it('does not coerce duplicate values or objects into logged data',()=>{
  const spy=vi.spyOn(console,'info').mockImplementation(()=>{});
  for(const transaction of [['private-canary'],{toString(){throw new Error('private-canary');}}])recordRequestCompletion('/v1/transaction-risk',400,1,{query:{transaction},errorCode:'INVALID_TX_HASH'});
  for(const call of spy.mock.calls){expect(JSON.parse(String(call[0]))).not.toHaveProperty('input_shape');expect(String(call[0])).not.toContain('private-canary');}
 });
});
