import type {ObservationSource,SourceApproval} from '../core/observedSources';
import {readPublicBody,StartBudget} from '../core/publicSource';
import type {PoolQuery,PoolValue} from './financeObservations';
import {resolvePoolBinding,type PoolBinding} from './marketSourceAdapters';
// Separate provider and network namespace. Never an alternate DEX Screener route.
const NETWORKS:Record<string,string>={ethereum:'eth',base:'base',arbitrum:'arbitrum',optimism:'optimism',polygon:'polygon_pos',bsc:'bsc',avalanche:'avax',linea:'linea',scroll:'scroll',gnosis:'xdai',zksync:'zksync',blast:'blast',mantle:'mantle',celo:'celo',sonic:'sonic',unichain:'unichain'};
let starts=new StartBudget(25,60000);
export function resetGeckoPoolBudgetForTests():void {starts=new StartBudget(25,60000);}
export function geckoPoolLiquiditySource(bindings:readonly PoolBinding[],approval:SourceApproval):ObservationSource<PoolQuery,PoolValue>{
 return {name:'GeckoTerminal exact pool reserve liquidity',approval,read:async(q,signal)=>{
  const pool=resolvePoolBinding(q,bindings),network=NETWORKS[pool.chain.toLowerCase()];
  if(!network||!/^0x[0-9a-fA-F]{40}$/.test(pool.address)||signal.aborted)throw Error('unbound pool or network');
  if(!starts.take())throw Error('pool source start budget');
  const address=pool.address.toLowerCase();const url=`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${address}`;
  const b=await readPublicBody(url,200000,2500);if(signal.aborted)throw Error('aborted');
  const j=JSON.parse(b.raw),data=j?.data,a=data?.attributes;
  if(data?.type!=='pool'||data.id!==`${network}_${address}`||typeof a?.address!=='string'||a.address.toLowerCase()!==address)throw Error('pool network/address identity mismatch');
  if(pool.tokenAddresses){
   const rel=data.relationships;
   const tokens=[rel?.base_token?.data?.id,rel?.quote_token?.data?.id];
   if(tokens.some(t=>typeof t!=='string')||tokens.map(t=>t.toLowerCase()).sort().join(',')!==pool.tokenAddresses.map(t=>network+'_'+t.toLowerCase()).sort().join(','))throw Error('pool token identity mismatch');
  }
  const reserve=a.reserve_in_usd;
  if(typeof reserve!=='string'||!/^\d{1,13}(\.\d{1,12})?$/.test(reserve))throw Error('invalid reserve');
  const value=Number(reserve);if(!Number.isFinite(value)||value<1||value>1e12)throw Error('reserve outside canonical range');
  return {identity:JSON.stringify([q.chain.toLowerCase(),q.pool.toLowerCase()]),sourceUrl:url,rawBody:JSON.stringify({source_raw_body:b.raw,pool_binding:pool,selection_policy:"Pair aliases select this reviewed representative pool, not all pools for the pair; ETH in a pair means wrapped WETH",observed_at_semantics:'retrieval time; the API exposes no pool reserve observation timestamp',terms_basis:'Owner standing terms-risk waiver dated 2026-11-23 for this testnet project only; not a provider licence or proof of commercial redistribution rights'}),observedAt:b.fetchedAt,fetchedAt:b.fetchedAt,value:{pool:q.pool,chain:q.chain,liquidityUsd:value,poolAddress:pool.address,poolSelection:pool.pairAlias?"reviewed representative pool; pair alias is not unique across venues or fees; ETH means wrapped WETH":"exact pool binding"}};
 }};
}
