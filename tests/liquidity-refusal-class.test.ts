import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {recordRequestCompletion} from '../src/core/requestMetrics';import {poolClass,refusalParamClass} from '../src/core/refusalClass';
let lines:string[];
beforeEach(()=>{lines=[];vi.spyOn(console,'info').mockImplementation((m:unknown)=>{lines.push(String(m));});});
afterEach(()=>vi.restoreAllMocks());
const refusal=()=>lines.map(l=>JSON.parse(l)).filter(o=>o.event==='refusal_param_class');
it.each([['0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640','address'],['USDC/WETH','pair_alias'],['eth-usdc','pair_alias'],['USDC / WETH 0.05%','name'],['Uniswap V3 weth usdc','name'],['0x123','other'],['','other'],['%%%','other'],['x','other']])('poolClass(%s) is %s',(v,c)=>expect(poolClass(v)).toBe(c));
it('liquidity refusal logs pool_class and chain_class only; chain aliases map to the canonical label; unknown chain is other',()=>{
 const secretPool='Secret Pool Name 31337',secretChain='my-private-chain-77';
 recordRequestCompletion('/v1/liquidity',422,5,{query:{pool:secretPool,chain:'eth'},errorCode:'POOL_UNBOUND'});
 recordRequestCompletion('/v1/liquidity',422,5,{query:{pool:'0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',chain:secretChain},errorCode:'POOL_UNBOUND'});
 recordRequestCompletion('/v1/liquidity',200,5,{query:{pool:'USDC/WETH',chain:'ethereum'},errorCode:''});
 const r=refusal();expect(r).toHaveLength(2);
 expect(r[0]).toMatchObject({intent:'LIQUIDITY_DEPTH_VERIFY_GENERAL',error_code:'POOL_UNBOUND',pool_class:'name',chain_class:'ethereum'});
 expect(r[1]).toMatchObject({pool_class:'address',chain_class:'other'});
 const all=lines.join('\n');for(const bad of ['Secret','31337',secretChain,'88e6'])expect(all).not.toContain(bad);
 expect(refusalParamClass('/v1/liquidity','X',undefined)).toMatchObject({pool_class:'other',chain_class:'other'});
});
it('a 200 liquidity answer with a disclosed null logs the same class line with fixed labels and data_status; a priced 200 does not',()=>{
 const secretPool='Secret Pool Name 31337';
 recordRequestCompletion('/v1/liquidity',200,5,{query:{pool:secretPool,chain:'eth'},disclosedNull:true,nullStatus:'no_data'});
 recordRequestCompletion('/v1/liquidity',200,5,{query:{pool:'USDC/WETH',chain:'ethereum'},disclosedNull:true,nullStatus:'raw <script> 99'});
 recordRequestCompletion('/v1/liquidity',200,5,{query:{pool:'USDC/WETH',chain:'ethereum'}});
 recordRequestCompletion('/v1/liquidity',200,5,{query:{pool:'USDC/WETH',chain:'ethereum'},disclosedNull:'yes'});
 recordRequestCompletion('/v1/price',200,5,{query:{},disclosedNull:true});
 const r=refusal();expect(r).toHaveLength(2);
 expect(r[0]).toMatchObject({intent:'LIQUIDITY_DEPTH_VERIFY_GENERAL',error_code:'DISCLOSED_NULL',status:'200',pool_class:'name',chain_class:'ethereum',data_status:'no_data'});
 expect(r[1]).toMatchObject({pool_class:'pair_alias',data_status:'other'});
 const all=lines.join('\n');for(const bad of ['Secret','31337','script'])expect(all).not.toContain(bad);
});
it('a disclosed-null flag never rewrites the code of a real refusal',()=>{
 recordRequestCompletion('/v1/liquidity',422,5,{query:{pool:'USDC/WETH',chain:'ethereum'},errorCode:'POOL_UNBOUND',disclosedNull:true,nullStatus:'no_data'});
 const r=refusal();expect(r).toHaveLength(1);expect(r[0]).toMatchObject({error_code:'POOL_UNBOUND',status:'422'});expect(r[0]).not.toHaveProperty('data_status');
});
