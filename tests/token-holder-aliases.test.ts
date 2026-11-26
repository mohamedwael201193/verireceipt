import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/holder-alias-');process.env.SQLITE_PATH=join(scratch,'v.sqlite');
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
import {handleTokenHolders,setTokenHoldersFetchForTests,tokenNameAlias} from '../src/handlers/tokenHolders';
import {TOKEN_CONTRACTS} from '../src/handlers/tokenContracts';
import {tokenClass,refusalParamClass} from '../src/core/refusalClass';
import {recordRequestCompletion} from '../src/core/requestMetrics';
const eth=TOKEN_CONTRACTS.ethereum;
afterEach(()=>{setTokenHoldersFetchForTests(null);vi.restoreAllMocks();});
const ALIASES:[string,string][]=[['USD Coin','USDC'],['Tether','USDT'],['Dai Stablecoin','DAI'],['Wrapped Ether','WETH'],['Chainlink','LINK'],['Uniswap','UNI'],['Aave','AAVE'],['Lido DAO','LDO'],['Shiba Inu','SHIB'],['Pepe','PEPE']];
it.each(ALIASES)('name %s resolves to the same contract and symbol as %s, case-insensitive and whitespace-tolerant',async(name,sym)=>{
 const urls:string[]=[];setTokenHoldersFetchForTests(async url=>{urls.push(url);return JSON.stringify({holders_count:'1234',symbol:sym,decimals:'18',address_hash:eth[sym],type:'ERC-20'});});
 const byName=await handleTokenHolders({token:'  '+name.toUpperCase().replace(/ /g,'   ')+' ',chain:'ethereum'});
 const bySymbol=await handleTokenHolders({token:sym,chain:'ethereum'});
 expect(urls[0]).toBe(urls[urls.length-1]);expect(urls[0]).toContain(eth[sym]);
 expect(byName.holders_count).toBe(1234);expect(byName.token_symbol).toBe(sym);expect(bySymbol.token_symbol).toBe(sym);
});
it('aliases are exact names only: partial, extra-word, native and unknown names stay refused (422 UNSUPPORTED_TOKEN)',async()=>{
 setTokenHoldersFetchForTests(async()=>{throw new Error('no fetch for a refused token');});
 for(const t of ['USD','Tether USD Coin','Wrapped','Ether','Ethereum','ETH','Bitcoin','toString','constructor','__proto__','Maker'])await expect(handleTokenHolders({token:t,chain:'ethereum'})).rejects.toMatchObject({status:422,code:'UNSUPPORTED_TOKEN'});
 expect(tokenNameAlias('constructor')).toBeUndefined();expect(tokenNameAlias('__proto__')).toBeUndefined();
});
it('an alias still refuses when the indexer reports a different symbol (no mis-attribution)',async()=>{
 setTokenHoldersFetchForTests(async()=>JSON.stringify({holders_count:'5',symbol:'WRONG',decimals:'18',address_hash:eth.USDC,type:'ERC-20'}));
 await expect(handleTokenHolders({token:'USD Coin',chain:'ethereum'})).rejects.toBeTruthy();
});
it.each([[eth.USDC,'address'],['0x'+'a'.repeat(40),'address'],['ETH','native'],['matic','native'],['USDC','known_symbol'],['pepe','known_symbol'],['Lido DAO','name_like'],['Maker Dao Token','name_like'],['Chainlink','name_like'],['NOPE','other'],['','other'],['0x123','other'],['x!y','other']])('tokenClass(%s) is %s',(v,c)=>expect(tokenClass(v)).toBe(c));
it('token-holders refusal line carries token_class only, never the token value; 200 adds none',()=>{
 const lines:string[]=[];vi.spyOn(console,'info').mockImplementation((m:unknown)=>{lines.push(String(m));});
 const secret='Zorblax-Secret-Coin-77';
 recordRequestCompletion('/v1/token-holders',422,5,{query:{token:secret,chain:'ethereum'},errorCode:'UNSUPPORTED_TOKEN'});
 recordRequestCompletion('/v1/token-holders',200,5,{query:{token:'USDC',chain:'ethereum'},errorCode:''});
 const r=lines.map(l=>JSON.parse(l)).filter(o=>o.event==='refusal_param_class');
 expect(r).toHaveLength(1);expect(r[0]).toMatchObject({intent:'TOKEN_HOLDER_COUNT_GENERAL',error_code:'UNSUPPORTED_TOKEN',token_class:'name_like'});
 expect(lines.join('\n')).not.toContain('Zorblax');expect(refusalParamClass('/v1/token-holders','UNSUPPORTED_TOKEN',{})).toMatchObject({token_class:'other'});
});
it('MKR resolves on ethereum to the confirmed contract (holder index only), and stays unsupported elsewhere',async()=>{
 const urls:string[]=[];setTokenHoldersFetchForTests(async url=>{urls.push(url);return JSON.stringify({holders_count:'78125',symbol:'MKR',decimals:'18',address_hash:'0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2',type:'ERC-20'});});
 const r=await handleTokenHolders({token:'mkr',chain:'ethereum'});expect(r.holders_count).toBe(78125);expect(urls[0].toLowerCase()).toContain('0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2');
 expect(TOKEN_CONTRACTS.ethereum.MKR).toBeUndefined();
 await expect(handleTokenHolders({token:'MKR',chain:'optimism'})).rejects.toMatchObject({code:'UNSUPPORTED_TOKEN'});
});
