import {isIP} from 'node:net';
import {gridRefusalClass} from '../handlers/gridPrice';
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
 return null;
}
export const REFUSAL_INTENTS:Record<string,string>={'/v1/gas-price':'GAS_PRICE_GENERAL','/v1/threat-indicator':'THREAT_INTELLIGENCE_INDICATOR','/v1/malware-hash':'MALWARE_DETECTION_HASH','/v1/macro':'MACRO_ECONOMIC_INDICATOR_GENERAL','/v1/grid-price':'GRID_POWER_PRICE_GENERAL'};
