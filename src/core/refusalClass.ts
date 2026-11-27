import {isIP} from 'node:net';
import {gridRefusalClass} from '../handlers/gridPrice';
import {TOKEN_CONTRACTS,ADDRESS_RE} from '../handlers/tokenContracts';
import {liquidityChain,liquidityPair} from './liquiditySelectors';
// Coarse, fixed-label classes of a rejected input for the refusal_param_class log line.
// Only labels from fixed lists are returned. The raw value, or any part of it outside the lists, is never logged.
const CHAINS=new Set(['gnosis','celo','blast','fantom','linea','scroll','zksync','mantle','metis','moonbeam','moonriver','cronos','aurora','harmony','kava','klaytn','sei','sui','aptos','near','cosmos','tron','ton','cardano','polkadot','tezos','stellar','xrp','ripple','litecoin','dogecoin','bitcoin','solana','avalanche','bsc','bnb','polygon','arbitrum','optimism','base','ethereum','zora','mode','taiko','manta','berachain','sonic','unichain','ink','abstract','hyperliquid','monad']);
const MACRO_TOKENS=new Set(['gdp','growth','per','capita','real','nominal','inflation','unemployment','rate','cpi','population','trade','debt','interest','other']);
export function chainClass(raw:string|undefined):string{const k=(raw??'').trim().toLowerCase();return CHAINS.has(k)?k:'other';}
export function indicatorType(raw:string|undefined):string{
 const v=(raw??'').trim();
 if(/^[0-9a-f]{32}$/i.test(v))return 'md5';if(/^[0-9a-f]{40}$/i.test(v))return 'sha1';if(/^[0-9a-f]{64}$/i.test(v))return 'sha256';
 if(/^https?:\/\//i.test(v))return 'url';
 const ip=isIP(v);if(ip===4)return 'ip4';if(ip===6)return 'ip6';
 if(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(v))return 'domain';
 return 'other';
}
export function macroTokens(raw:string|undefined):{indicator_tokens:string[];token_count:number}{
 const words=(raw??'').toLowerCase().match(/[a-z]+/g)??[];
 return {indicator_tokens:[...new Set(words.filter(w=>MACRO_TOKENS.has(w)))],token_count:words.length};
}
const KNOWN_SYMBOLS=new Set(Object.values(TOKEN_CONTRACTS).flatMap(m=>Object.keys(m)));
/** Fixed-label class of a token-holders `token` value: address, known_symbol, native, name_like or other. Never the value. */
export function tokenClass(raw:string|undefined):string{
 const v=(raw??'').trim();
 if(ADDRESS_RE.test(v))return 'address';
 const u=v.toUpperCase();
 if(['ETH','POL','MATIC'].includes(u))return 'native';
 if(KNOWN_SYMBOLS.has(u))return 'known_symbol';
 if(/^[A-Za-z][A-Za-z0-9.' -]*$/.test(v)&&(v.includes(' ')||(v.length>=6&&/[a-z]/.test(v))))return 'name_like';
 return 'other';
}
/** Fixed-label class of a liquidity `pool` value: address, pair_alias, name or other. Never the value. */
export function poolClass(raw:string|undefined):string{
 const v=(raw??'').trim();
 if(/^0x[0-9a-fA-F]{40}$/.test(v))return 'address';
 if(liquidityPair(v)!==null)return 'pair_alias';
 if(/^[A-Za-z][A-Za-z0-9.' %/-]*$/.test(v)&&/[A-Za-z]{3}/.test(v)&&/[ ]/.test(v))return 'name';
 return 'other';
}
const TVL_CHAIN_WORDS=new Set([...CHAINS,'ethereum','eth','bsc','bnb','polygon','arbitrum','optimism','base','avalanche','solana','sol','fantom','op','arb']);
/** Fixed-label class of a TVL `protocol` value: length bucket and booleans only. Never the value or any substring. */
export function tvlProtocolClass(raw:string|undefined):Record<string,unknown>{
 const v=(raw??'').trim();
 const words=v.toLowerCase().split(/[\s_-]+/).filter(Boolean);
 const last=words.length>1?words[words.length-1]:'';
 return {
  length_bucket:v.length<=8?'<=8':v.length<=16?'9-16':v.length<=32?'17-32':'>32',
  has_space:/\s/.test(v),has_hyphen:v.includes('-'),
  has_chain_suffix:last!==''&&TVL_CHAIN_WORDS.has(last),
  ascii_only:/^[\x00-\x7f]*$/.test(v),
  has_version_suffix:/(?:^|[\s_-])v\d+(?:\.\d+)*$/i.test(v)
 };
}
function ownString(query:unknown,key:string):string|undefined{
 if(!query||typeof query!=='object')return undefined;
 const d=Object.getOwnPropertyDescriptor(query,key);
 return d&&'value' in d&&typeof d.value==='string'?d.value:undefined;
}
/** The extra fields of a refusal_param_class line for this route and error, or null when the route/error has no class. */
export function refusalParamClass(route:string|undefined,errorCode:string,query:unknown):Record<string,unknown>|null{
 if(route==='/v1/gas-price'&&errorCode==='CHAIN_NOT_SERVED')return {chain_class:chainClass(ownString(query,'chain'))};
 if(route==='/v1/threat-indicator'||route==='/v1/malware-hash')return {indicator_type:indicatorType(ownString(query,'indicator'))};
 if(route==='/v1/macro'&&errorCode==='UNSUPPORTED_INDICATOR')return macroTokens(ownString(query,'indicator'));
 if(route==='/v1/grid-price')return gridRefusalClass(ownString(query,'node_or_zone'));
 if(route==='/v1/liquidity')return {pool_class:poolClass(ownString(query,'pool')),chain_class:chainClass(liquidityChain(ownString(query,'chain')??''))};
 if(route==='/v1/token-holders')return {token_class:tokenClass(ownString(query,'token'))};
 if(route==='/v1/tvl')return tvlProtocolClass(ownString(query,'protocol'));
 return null;
}
export const REFUSAL_INTENTS:Record<string,string>={'/v1/gas-price':'GAS_PRICE_GENERAL','/v1/threat-indicator':'THREAT_INTELLIGENCE_INDICATOR','/v1/malware-hash':'MALWARE_DETECTION_HASH','/v1/macro':'MACRO_ECONOMIC_INDICATOR_GENERAL','/v1/token-holders':'TOKEN_HOLDER_COUNT_GENERAL','/v1/liquidity':'LIQUIDITY_DEPTH_VERIFY_GENERAL','/v1/grid-price':'GRID_POWER_PRICE_GENERAL','/v1/tvl':'TVL_LOOKUP_GENERAL'};
