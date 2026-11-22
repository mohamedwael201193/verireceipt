import { describe,expect,it } from 'vitest';
import { validateRequestId,validateVisitorInput,VISITOR_LIMITS } from '../src/visitor/policy';
const input={cik:'1318605',year:2024,form:'10-Q',minimum_count:3};
describe('hosted testnet research input and wallet boundaries',()=>{
 it('accepts only the canonical research shape',()=>{expect(validateVisitorInput(input)).toEqual(input);expect(VISITOR_LIMITS.network).toBe('eip155:11155111');expect(VISITOR_LIMITS.perCallUusdc).toBe(10000n);});
 it.each([null,[],{...input,cik:'01318605'},{...input,cik:'Tesla'},{...input,cik:'1\n2'},{...input,year:2026},{...input,year:1993},{...input,year:2024.5},{...input,minimum_count:0},{...input,minimum_count:1001},{...input,minimum_count:1.5},{...input,form:'10-Q/A'},{...input,key:'client-key-forbidden'},{...input,network:'mainnet'},{...input,url:'https://arbitrary.invalid'},{...input,miner:'arbitrary'},{...input,signMessage:'arbitrary'}])('refuses malformed or unauthorized request %j',v=>{expect(()=>validateVisitorInput(v,new Date('2026-11-22T00:00:00Z'))).toThrow();});
 it.each(['',null,'not-a-uuid','aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa','../../etc/passwd'])('refuses invalid idempotency key %j',v=>expect(()=>validateRequestId(v)).toThrow());
});
