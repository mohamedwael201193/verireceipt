import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {recordRequestCompletion} from '../src/core/requestMetrics';
import {refusalParamClass,chainClass,supplyTokenClass,REFUSAL_INTENTS} from '../src/core/refusalClass';
let lines:string[];
beforeEach(()=>{lines=[];vi.spyOn(console,'info').mockImplementation((m:unknown)=>{lines.push(String(m));});});
afterEach(()=>vi.restoreAllMocks());
const parsed=()=>lines.map(l=>JSON.parse(l));
const refusal=()=>parsed().filter(o=>o.event==='refusal_param_class');
it('token-supply route is registered for the refusal class line',()=>{expect(REFUSAL_INTENTS['/v1/token-supply']).toBe('TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL');});
it('a 400 UNSUPPORTED_CHAIN on the free-text form logs the chain class, never the input text',()=>{
 const secret='ZqSecretToken31337 on solana';
 recordRequestCompletion('/v1/token-supply',400,5,{query:{query:secret},errorCode:'UNSUPPORTED_CHAIN'});
 const r=refusal();expect(r).toHaveLength(1);
 expect(r[0]).toMatchObject({intent:'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL',error_code:'UNSUPPORTED_CHAIN',status:'400',chain_class:'solana'});
 const all=lines.join('\n');for(const bad of ['ZqSecretToken31337','ZqSecret','31337'])expect(all).not.toContain(bad);
 expect(parsed().some(o=>o.error_code==='UNSUPPORTED_CHAIN'&&o.event!=='refusal_param_class')).toBe(true);
});
it.each([
 ['USDC on bitcoin','bitcoin'],
 ['USDT on tron','tron'],
 ['USDC on Solana','solana'],
 ['USDC ON SOLANA','solana'],
 ['WETH on ethereum','ethereum'],
 ['some token on dogecoin','dogecoin'],
 ['some token on my-secret-chain-9x','other'],
 ['a bare symbol','other'],
 ['USDC on','other'],
])('chain class of %j is %s',(text,cls)=>{
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_CHAIN',{query:text})).toEqual({chain_class:cls});
});
it('a structured chain parameter takes precedence over the free-text suffix',()=>{
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_CHAIN',{token:'USDC on solana',chain:'bitcoin'})).toEqual({chain_class:'bitcoin'});
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_CHAIN',{token:'USDC on solana'})).toEqual({chain_class:'solana'});
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_CHAIN',{chain:'tron'})).toEqual({chain_class:'tron'});
 // Both free-text keys present (itself a TOKEN_INPUT_CONFLICT): query wins, deterministically.
 expect(refusalParamClass('/v1/token-supply','TOKEN_INPUT_CONFLICT',{query:'USDC on bitcoin',token:'X on solana'})).toEqual({chain_class:'bitcoin'});
});
it('the class is the same fixed-label classifier the gas-price route uses',()=>{
 expect(chainClass('solana')).toBe('solana');
 expect(chainClass('bitcoin')).toBe('bitcoin');
 expect(chainClass('tron')).toBe('tron');
 expect(chainClass('my-secret-chain-9x')).toBe('other');
 expect(chainClass(undefined)).toBe('other');
});
it('a long whitespace-heavy input is capped before the suffix scan and stays fast',()=>{
 const huge=('on'+' '.repeat(1000)+'x'.repeat(50)+' ').repeat(200)+'on solana';
 const t0=Date.now();
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_CHAIN',{query:huge})).toEqual({chain_class:'other'});
 expect(Date.now()-t0).toBeLessThan(100);
 // The cap is part of the contract: a chain suffix beyond 200 chars is not extracted.
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_CHAIN',{query:'x'.repeat(500)+' on solana'})).toEqual({chain_class:'other'});
 // Just inside the cap it still is.
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_CHAIN',{query:'x'.repeat(180)+' on solana'})).toEqual({chain_class:'solana'});
});
it('missing or inherited query values give the other class, never throw',()=>{
 expect(refusalParamClass('/v1/token-supply','X',undefined)).toEqual({chain_class:'other'});
 expect(refusalParamClass('/v1/token-supply','X',{})).toEqual({chain_class:'other'});
 expect(refusalParamClass('/v1/token-supply','X',Object.create({query:'inherited secret on solana'}))).toEqual({chain_class:'other'});
});
it('a 200 token-supply answer logs no class line',()=>{
 recordRequestCompletion('/v1/token-supply',200,5,{query:{query:'USDC on solana'}});
 expect(refusal()).toHaveLength(0);
});
it('other token-supply refusals also carry the chain class label',()=>{
 recordRequestCompletion('/v1/token-supply',400,5,{query:{query:'USDC on solana'},errorCode:'CHAIN_MISMATCH'});
 expect(refusal()[0]).toMatchObject({error_code:'CHAIN_MISMATCH',chain_class:'solana'});
});

// Round 7: token_class on the UNSUPPORTED_TOKEN refusal line (address |
// symbol | name | has_space), labels only, only for that error code.
it.each([
 ['0x'+'a'.repeat(40),'address'],
 ['FAKECOIN','symbol'],
 ['PEPE2','symbol'],
 ['verylongtokenname','name'],
 ['doge coin','has_space'],
 ['Secret-Token-Zq31337','name'],
])('token class of %j is %s',(text,cls)=>{
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_TOKEN',{token:text})).toEqual({chain_class:'other',token_class:cls});
});
it('free-text UNSUPPORTED_TOKEN classes the token part before any " on <chain>" suffix',()=>{
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_TOKEN',{query:'FAKECOIN on solana'})).toEqual({chain_class:'solana',token_class:'symbol'});
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_TOKEN',{query:'doge coin on solana'})).toEqual({chain_class:'solana',token_class:'has_space'});
});
it('other token-supply error codes keep the chain-only line',()=>{
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_CHAIN',{token:'FAKECOIN'})).toEqual({chain_class:'other'});
 expect(refusalParamClass('/v1/token-supply','MISSING_PARAM',{})).toEqual({chain_class:'other'});
 expect(refusalParamClass('/v1/token-supply','UNSUPPORTED_TOKEN',{})).toEqual({chain_class:'other'});
});
it('a 422 UNSUPPORTED_TOKEN logs token_class and chain_class, never the input text',()=>{
 const secret='Secret-Token-Zq31337';
 recordRequestCompletion('/v1/token-supply',422,5,{query:{token:secret,chain:'solana'},errorCode:'UNSUPPORTED_TOKEN'});
 const r=refusal();expect(r).toHaveLength(1);
 expect(r[0]).toMatchObject({intent:'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL',error_code:'UNSUPPORTED_TOKEN',status:'422',chain_class:'solana',token_class:'name'});
 const all=lines.join('\n');for(const bad of ['Secret','Zq31337','31337'])expect(all).not.toContain(bad);
});
it('the classifier is exported with its boundary: 10 chars symbol, 11 name',()=>{
 expect(supplyTokenClass('0x'+'f'.repeat(40))).toBe('address');
 expect(supplyTokenClass('a'.repeat(10))).toBe('symbol');
 expect(supplyTokenClass('a'.repeat(11))).toBe('name');
 expect(supplyTokenClass('a b')).toBe('has_space');
 expect(supplyTokenClass('')).toBeUndefined();
 expect(supplyTokenClass(undefined)).toBeUndefined();
});
