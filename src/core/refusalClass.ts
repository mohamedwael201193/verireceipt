import {isIP} from 'node:net';
import {dateAgeBucket} from './dateAgeBucket';
import {gridRefusalClass} from '../handlers/gridPrice';
import {PAST_WEATHER_BINDINGS} from '../handlers/weatherWired';
import {TOKEN_CONTRACTS,ADDRESS_RE} from '../handlers/tokenContracts';
import {liquidityChain,liquidityPair} from './liquiditySelectors';
import {stripTvlWrapper} from '../handlers/tvl';
// Coarse, fixed-label classes of a rejected input for the refusal_param_class log line.
// Only labels from fixed lists are returned. The raw value, or any part of it outside the lists, is never logged.
const BASE_CHAINS=['gnosis','celo','blast','fantom','linea','scroll','zksync','mantle','metis','moonbeam','moonriver','cronos','aurora','harmony','kava','klaytn','sei','sui','aptos','near','cosmos','tron','ton','cardano','polkadot','tezos','stellar','xrp','ripple','litecoin','dogecoin','bitcoin','solana','avalanche','bsc','bnb','polygon','arbitrum','optimism','base','ethereum','zora','mode','taiko','manta','berachain','sonic','unichain','ink','abstract','hyperliquid','monad'];
// Popular aliases: logging labels only, nothing here changes which chains are served.
const ALIAS_CHAIN_LABELS=['eth','matic','avax','bnbchain','arbitrum-one','op-mainnet','mainnet','polygon-pos','base-mainnet','zkevm','pulsechain','bitcoin-cash','monad','berachain','unichain','sonic','ink','soneium','abstract','taiko','manta','mint','opbnb','arbitrum-nova','polygon-zkevm','linea-mainnet','scroll-mainnet'];
const CHAINS=new Set([...BASE_CHAINS,...ALIAS_CHAIN_LABELS]);
const MACRO_TOKENS=new Set(['gdp','growth','per','capita','real','nominal','inflation','unemployment','rate','cpi','population','trade','debt','interest','other']);
export function chainClass(raw:string|undefined):string{const k=(raw??'').trim().toLowerCase();return CHAINS.has(k)?k:'other';}
const NETWORK_WORDS=new Set(['mainnet','testnet','chain','network','pos','l1','l2','evm']);
/** Fixed-label shape of a chain value. Only labels from fixed lists; the raw text or any part of it outside the lists is never returned. */
export function chainShape(raw:string|undefined):Record<string,unknown>{
 const v=raw??'';
 const n=v.length;
 const tokens=v.toLowerCase().split(/[\s-]+/).filter(Boolean);
 const first=tokens[0]??'';
 return {
  len_bucket:n===0?'0':n<=3?'1-3':n<=8?'4-8':n<=16?'9-16':n<=32?'17-32':'>32',
  has_space:/\s/.test(v),has_hyphen:v.includes('-'),
  ascii:/^[\x00-\x7f]*$/.test(v),
  first_token_known:CHAINS.has(first)?first:'none',
  has_network_word:tokens.some(t=>NETWORK_WORDS.has(t)),
  case_variant:v===v.toLowerCase()?'lower':v===v.toUpperCase()?'upper':'mixed'
 };
}
/** Every request parameter name the miner serves (miner.yaml endpoints plus the logged aliases). Names outside it are only counted. */
const REQUEST_SHAPE_KEYS=new Set(['address','amount','asset','base','bin','block','block_height','chain','chains','cik','company','country','currency','cve','cve_id','date','destination','domain','entity','event','form','form_type','from','from_currency','game','host','indicator','interval_start','ip','jurisdiction','lat','location','lon','metric','name','node_or_zone','origin','patch','pair','period','pool','project','protocol','query','question','quote','record_type','reference','retailer','route_or_flight','service','subject','symbol','target','ticker','to','to_currency','token','topic','transaction','tx_hash','url','validator_index','vat_number','vendor','window_hours','year']);
/** Fixed-label shape of a request's parameters: how many, which closed-list names, and how many others. Never an unlisted name or any value. */
export function requestShape(query:unknown):{param_count:0|1|2|'3+';keys_in_closed_list:string[];unknown_key_count:number}{
 const keys=query!==null&&typeof query==='object'?Object.keys(query as object):[];
 const known=[...new Set(keys.filter(k=>REQUEST_SHAPE_KEYS.has(k)))].sort();
 return {param_count:keys.length>=3?'3+':keys.length as 0|1|2,keys_in_closed_list:known,unknown_key_count:keys.filter(k=>!REQUEST_SHAPE_KEYS.has(k)).length};
}
/** Fixed-label class of a macro `country` value. Never the value. */
export function countryClass(raw:string|undefined):string{
 const v=(raw??'').trim();
 if(/^[A-Za-z]{2}$/.test(v))return 'iso2';
 if(/^[A-Za-z]{3}$/.test(v))return 'iso3';
 if(/^[A-Za-z][A-Za-z .,'()-]{3,}$/.test(v))return 'name';
 return 'other';
}
/** Fixed-label class of a macro `year` value: yyyy, range or other. Never the value. */
export function yearClass(raw:string|undefined):string{
 const v=(raw??'').trim();
 if(/^\d{4}$/.test(v))return 'yyyy';
 if(/^\d{4}\s*(?:-|to|\.\.|:)\s*\d{4}$/i.test(v))return 'range';
 return 'other';
}
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
const TVL_CHAIN_WORDS=new Set([...BASE_CHAINS,'ethereum','eth','bsc','bnb','polygon','arbitrum','optimism','base','avalanche','solana','sol','fantom','op','arb']);
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
  has_version_suffix:/(?:^|[\s_-])v\d+(?:\.\d+)*$/i.test(v),
  // True when the sentence-style wrapper stripper found something to strip
  // (the 2026-11-28 fix for "total value locked in ..." phrasings). A
  // boolean only, never the wrapper words or any part of the value.
  has_wrapper_phrase:stripTvlWrapper(v)!==null
 };
}
/** The chain a /v1/token-supply refusal asked for: the chain parameter,
 * else the "on <chain>" suffix of the free-text token input (the graded
 * refusals arrive as param_keys ["query"]). Never the value: only the
 * fixed chainClass label is logged. */
function tokenSupplyChainRaw(query:unknown):string|undefined{
 const chain=ownString(query,'chain');
 if(chain!==undefined)return chain;
 const text=ownString(query,'query')??ownString(query,'token');
 if(text===undefined)return undefined;
 // Cap before the suffix scan: the regex is linear per start position,
 // so an unbounded whitespace-heavy input costs quadratic time.
 return /\s+on\s+(.+)$/i.exec(text.slice(0,200))?.[1];
}
const BOUND_WEATHER_LOCATIONS=new Set(PAST_WEATHER_BINDINGS.map(b=>b.location.trim().toLowerCase()));
/** Fixed-label class of a token-supply token value on an UNSUPPORTED_TOKEN
 * refusal: a 0x contract address, a short symbol-like token, a name-like
 * token, or one containing whitespace. Never the value. Empty input logs
 * no class (an empty token refuses as MISSING_PARAM before this). */
export function supplyTokenClass(raw:string|undefined):string|undefined{
 const v=(raw??'').trim();
 if(!v)return undefined;
 if(ADDRESS_RE.test(v))return 'address';
 if(/\s/.test(v))return 'has_space';
 if(/^[A-Za-z0-9]{2,10}$/.test(v))return 'symbol';
 return 'name';
}
/** The token a /v1/token-supply refusal asked for: the structured token
 * parameter, or the free-text query with any " on <chain>" suffix removed
 * (the same split tokenSupplyChainRaw uses for the chain side). */
function tokenSupplyTokenRaw(query:unknown):string|undefined{
 const token=ownString(query,'token');
 if(token!==undefined)return token;
 const text=ownString(query,'query');
 if(text===undefined)return undefined;
 const m=/^(.+?)\s+on\s+\S.*$/i.exec(text.trim());
 return m?m[1]:text;
}
/** Fixed-label class of a weather-history `location` value: bound (a reviewed
 * station binding exists), has_comma, unbound_ascii or unbound_nonascii. Never the value. */
export function weatherLocationClass(raw:string|undefined):string{
 const v=(raw??'').trim();
 if(BOUND_WEATHER_LOCATIONS.has(v.toLowerCase()))return 'bound';
 if(v.includes(','))return 'has_comma';
 return /^[\x00-\x7f]*$/.test(v)?'unbound_ascii':'unbound_nonascii';
}
function ownString(query:unknown,key:string):string|undefined{
 if(!query||typeof query!=='object')return undefined;
 const d=Object.getOwnPropertyDescriptor(query,key);
 return d&&'value' in d&&typeof d.value==='string'?d.value:undefined;
}
/** The extra fields of a refusal_param_class line for this route and error, or null when the route/error has no class. */
export function refusalParamClass(route:string|undefined,errorCode:string,query:unknown):Record<string,unknown>|null{
 if(route==='/v1/gas-price'&&errorCode==='CHAIN_NOT_SERVED'){const chain=ownString(query,'chain');return {chain_class:chainClass(chain),...chainShape(chain)};}
 if(route==='/v1/threat-indicator'||route==='/v1/malware-hash')return {indicator_type:indicatorType(ownString(query,'indicator'))};
 if(route==='/v1/macro'&&errorCode==='UNSUPPORTED_INDICATOR')return {...macroTokens(ownString(query,'indicator')),country_class:countryClass(ownString(query,'country')),year_class:yearClass(ownString(query,'year'))};
 if(route==='/v1/grid-price')return gridRefusalClass(ownString(query,'node_or_zone'));
 if(route==='/v1/liquidity')return {pool_class:poolClass(ownString(query,'pool')),chain_class:chainClass(liquidityChain(ownString(query,'chain')??''))};
 if(route==='/v1/token-holders')return {token_class:tokenClass(ownString(query,'token')),chain_class:chainClass(ownString(query,'chain'))};
 if(route==='/v1/tvl')return tvlProtocolClass(ownString(query,'protocol'));
 if(route==='/v1/token-supply'){
  const chain_class=chainClass(tokenSupplyChainRaw(query));
  if(errorCode==='UNSUPPORTED_TOKEN'){
   const token_class=supplyTokenClass(tokenSupplyTokenRaw(query));
   return token_class===undefined?{chain_class}:{chain_class,token_class};
  }
  return {chain_class};
 }
 if(route==='/v1/weather-history')return {location_class:weatherLocationClass(ownString(query,'location')),date_age_bucket:dateAgeBucket(ownString(query,'date'))};
 return null;
}
export const REFUSAL_INTENTS:Record<string,string>={'/v1/gas-price':'GAS_PRICE_GENERAL','/v1/threat-indicator':'THREAT_INTELLIGENCE_INDICATOR','/v1/malware-hash':'MALWARE_DETECTION_HASH','/v1/macro':'MACRO_ECONOMIC_INDICATOR_GENERAL','/v1/token-holders':'TOKEN_HOLDER_COUNT_GENERAL','/v1/liquidity':'LIQUIDITY_DEPTH_VERIFY_GENERAL','/v1/grid-price':'GRID_POWER_PRICE_GENERAL','/v1/tvl':'TVL_LOOKUP_GENERAL','/v1/token-supply':'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL','/v1/weather-history':'WEATHER_FORECAST_VERIFY_GENERAL'};
