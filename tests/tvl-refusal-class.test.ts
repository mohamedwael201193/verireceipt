import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {recordRequestCompletion} from '../src/core/requestMetrics';
import {refusalParamClass,tvlProtocolClass,REFUSAL_INTENTS} from '../src/core/refusalClass';
let lines:string[];
beforeEach(()=>{lines=[];vi.spyOn(console,'info').mockImplementation((m:unknown)=>{lines.push(String(m));});});
afterEach(()=>vi.restoreAllMocks());
const parsed=()=>lines.map(l=>JSON.parse(l));
const refusal=()=>parsed().filter(o=>o.event==='refusal_param_class');
it('TVL route is registered for the refusal class line',()=>{expect(REFUSAL_INTENTS['/v1/tvl']).toBe('TVL_LOOKUP_GENERAL');});
it.each([
 ['aave',{length_bucket:'<=8',has_space:false,has_hyphen:false,has_chain_suffix:false,ascii_only:true,has_version_suffix:false}],
 ['uniswap-v3',{length_bucket:'9-16',has_space:false,has_hyphen:true,has_chain_suffix:false,ascii_only:true,has_version_suffix:true}],
 ['Curve Finance Polygon',{length_bucket:'17-32',has_space:true,has_hyphen:false,has_chain_suffix:true,ascii_only:true,has_version_suffix:false}],
 ['a-very-long-protocol-name-with-many-words-here',{length_bucket:'>32',has_space:false,has_hyphen:true,has_chain_suffix:false,ascii_only:true,has_version_suffix:false}],
 ['prötocol',{length_bucket:'<=8',has_space:false,has_hyphen:false,has_chain_suffix:false,ascii_only:false,has_version_suffix:false}],
 ['sushi v2',{length_bucket:'<=8',has_space:true,has_hyphen:false,has_chain_suffix:false,ascii_only:true,has_version_suffix:true}],
 ['',{length_bucket:'<=8',has_space:false,has_hyphen:false,has_chain_suffix:false,ascii_only:true,has_version_suffix:false}],
])('tvlProtocolClass %j',(v,exp)=>{expect(tvlProtocolClass(v)).toEqual(exp);});
it('a 422 PROTOCOL_NOT_FOUND logs fixed labels only and no input text; the completion line keeps the code',()=>{
 const secret='Secret-Protocol-Zq31337 Polygon';
 recordRequestCompletion('/v1/tvl',422,5,{query:{protocol:secret},errorCode:'PROTOCOL_NOT_FOUND'});
 const r=refusal();expect(r).toHaveLength(1);
 expect(r[0]).toMatchObject({intent:'TVL_LOOKUP_GENERAL',error_code:'PROTOCOL_NOT_FOUND',status:'422',length_bucket:'17-32',has_space:true,has_hyphen:true,has_chain_suffix:true,ascii_only:true,has_version_suffix:false});
 const all=lines.join('\n');for(const bad of ['Secret','Zq31337','31337','Polygon'])expect(all).not.toContain(bad);
 expect(parsed().some(o=>o.error_code==='PROTOCOL_NOT_FOUND'&&o.event!=='refusal_param_class')).toBe(true);
});
it('CHAIN_TVL_NONE is a diagnostic code and also gets the class line',()=>{
 recordRequestCompletion('/v1/tvl',422,5,{query:{protocol:'aave',chain:'x'},errorCode:'CHAIN_TVL_NONE'});
 expect(refusal()[0]).toMatchObject({error_code:'CHAIN_TVL_NONE'});
 expect(parsed().some(o=>o.error_code==='CHAIN_TVL_NONE'&&o.event!=='refusal_param_class')).toBe(true);
});
it('a 200 TVL answer logs no class line',()=>{
 recordRequestCompletion('/v1/tvl',200,5,{query:{protocol:'aave'}});
 expect(refusal()).toHaveLength(0);
});
it('missing or inherited query values give the empty-input class, never throw',()=>{
 expect(refusalParamClass('/v1/tvl','X',undefined)).toMatchObject({length_bucket:'<=8',has_space:false});
 expect(refusalParamClass('/v1/tvl','X',Object.create({protocol:'inherited secret'}))).toMatchObject({length_bucket:'<=8',has_space:false});
});
it.each([[8,'<=8'],[9,'9-16'],[16,'9-16'],[17,'17-32'],[32,'17-32'],[33,'>32']])('length %i falls in bucket %s',(n,b)=>{
 expect(tvlProtocolClass('a'.repeat(n)).length_bucket).toBe(b);
});
it('has_chain_suffix: a chain word as the whole protocol is not a suffix; an unrelated last word is not a suffix; a chain word after another word is',()=>{
 expect(tvlProtocolClass('ethereum').has_chain_suffix).toBe(false);
 expect(tvlProtocolClass('polygon').has_chain_suffix).toBe(false);
 expect(tvlProtocolClass('arbitrum finance').has_chain_suffix).toBe(false);
 expect(tvlProtocolClass('ethereum-staking').has_chain_suffix).toBe(false);
 expect(tvlProtocolClass('aave ethereum').has_chain_suffix).toBe(true);
 expect(tvlProtocolClass('aave_polygon').has_chain_suffix).toBe(true);
});
