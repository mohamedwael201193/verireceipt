import {recordGeckoCall,logGecko429} from '../core/geckoCallCounter';
import {PublicBodyCache,StartBudget,readPublicBody} from '../core/publicSource';import {envelope,makeReceipt} from '../core/receipt';import {saveReceipt} from '../core/storage';import {badRequest,upstreamUnavailable} from '../core/errors';import {liquidityChain,liquidityPair} from '../core/liquiditySelectors';
const networks:Record<string,string>={ethereum:'eth',base:'base',arbitrum:'arbitrum',optimism:'optimism',polygon:'polygon_pos',bsc:'bsc',avalanche:'avax',linea:'linea',scroll:'scroll',gnosis:'xdai',zksync:'zksync',blast:'blast',mantle:'mantle',celo:'celo',sonic:'sonic',unichain:'unichain',solana:'solana'};
const tokens:Record<string,Record<string,string>>={solana:{SOL:'So11111111111111111111111111111111111111112',USDC:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'},base:{WETH:'0x4200000000000000000000000000000000000006',USDC:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'}};
let cache=new PublicBodyCache(128,60000,()=>Date.now()),budget=new StartBudget(25,60000,()=>Date.now()),active=0;
export function resetLiquidityDiscoveryForTests(){cache=new PublicBodyCache(128,60000,()=>Date.now());budget=new StartBudget(25,60000,()=>Date.now());active=0;}
function solanaAddress(value:string){if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const c of value)n=n*58n+BigInt(alphabet.indexOf(c));let bytes=0;while(n>0){n>>=8n;bytes++;}return bytes+(value.match(/^1*/)?.[0].length??0)===32;}
export function discoveryAddress(value:string,chain:string){return chain==='solana'?solanaAddress(value):/^0x[0-9a-fA-F]{40}$/.test(value);}
export function parseDiscoveryPool(row:any,network:string,chain:string){
 const a=row?.attributes,address=a?.address;
 if(row?.type!=='pool'||typeof address!=='string'||!discoveryAddress(address,chain)||row.id!==network+'_'+(chain==='solana'?address:address.toLowerCase())||typeof a.name!=='string')throw Error('pool network/address/name identity mismatch');
 if(typeof a.reserve_in_usd!=='string'||!/^\d{1,13}(\.\d{1,12})?$/.test(a.reserve_in_usd))throw Error('invalid reserve');
 const liquidity=Number(a.reserve_in_usd);if(!Number.isFinite(liquidity)||liquidity<1||liquidity>1e12)throw Error('reserve outside contract');
 const dex=row.relationships?.dex?.data?.id;if(typeof dex!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(dex))throw Error('missing venue');
 return {token_ids:[row.relationships?.base_token?.data?.id,row.relationships?.quote_token?.data?.id],pool_address:address,pool_name:a.name,venue:dex,fee_label:/\b\d+(?:\.\d+)?%/.exec(a.name)?.[0]??null,liquidity_usd:liquidity};
}
export async function discoverLiquidity(q:Record<string,string|undefined>){
 const pool=q.pool?.trim(),chain=liquidityChain(q.chain??'');if(!pool||!chain||pool.length>256||chain.length>80||/[\x00-\x1f]/.test(pool+chain))throw badRequest('INVALID_PARAM','pool and chain must be bounded printable text');
 const network=networks[chain],exact=discoveryAddress(pool,chain),pair=liquidityPair(pool.replace(/\s+\d+(?:\.\d+)?%\s*$/,''));let url:string|null=null,body:string|null=null,fetchedAt=new Date().toISOString(),status='no_data',candidates:ReturnType<typeof parseDiscoveryPool>[]=[],selected:ReturnType<typeof parseDiscoveryPool>|null=null;
 if(network){
  url=exact?`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${chain==='solana'?pool:pool.toLowerCase()}`:`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(pool)}&network=${network}&page=1`;
  try{
   const got=await cache.get(url,async()=>{if(active>=4||!budget.take())throw Error('discovery capacity');active++;let timer:ReturnType<typeof setTimeout>;recordGeckoCall();const io=readPublicBody(url!,200000,2500).catch(e=>{logGecko429(e);throw e;}).finally(()=>{active--;});try{return await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('discovery deadline')),2600);})]);}finally{clearTimeout(timer!);}});
   body=got.raw;fetchedAt=got.fetchedAt;if(Date.now()-Date.parse(fetchedAt)<0||Date.now()-Date.parse(fetchedAt)>=60000)throw Error('discovery observation expired');const data=JSON.parse(body).data;
   if(exact){const candidate=parseDiscoveryPool(data,network,chain);if(chain==='solana'?candidate.pool_address!==pool:candidate.pool_address.toLowerCase()!==pool.toLowerCase())throw Error('exact address mismatch');candidates=[candidate];selected=candidate;status='exact_pool';}
   else{
    if(!Array.isArray(data))throw Error('search result malformed');
    const seen=new Set<string>();for(const row of data){try{const c=parseDiscoveryPool(row,network,chain),name=c.pool_name.replace(/\s+\d+(?:\.\d+)?%\s*$/,'').trim();const wantedFee=/\b\d+(?:\.\d+)?%/.exec(pool)?.[0];const matches=pair?liquidityPair(name)===pair&&(!wantedFee||c.fee_label===wantedFee):c.pool_name.toLowerCase()===pool.toLowerCase();if(matches&&!seen.has(c.pool_address)){seen.add(c.pool_address);candidates.push(c);}}catch{}}
    const identities=pair?pair.split('/').map(symbol=>tokens[chain]?.[symbol]):[];
    const boundPair=identities.length===2&&identities.every(Boolean);
    if(boundPair)candidates=candidates.filter(c=>[...c.token_ids].sort().join(',')===identities.map(address=>network+'_'+address).sort().join(','));
    candidates.sort((a,b)=>b.liquidity_usd-a.liquidity_usd||a.pool_address.localeCompare(b.pool_address));
    if(candidates.length===1&&(!pair||boundPair)){selected=candidates[0];status='unique_exact_name';}else if(candidates.length>1&&boundPair){selected=candidates[0];status='representative_exact_pair';}else if(candidates.length>0)status='ambiguous';
   }
  }catch{status='source_unavailable';selected=null;candidates=[];}
 }
 const method=status==='representative_exact_pair'?'Highest reported reserve among exact pair-name AND verified token-address matches in the first returned search page on the requested chain, not the only pool and not exhaustive':status==='unique_exact_name'?'Unique exact-name match in the returned search page, not proof no other pool exists':status==='exact_pool'?'Exact requested network and pool address; provider reported total reserve USD':'No unique supported pool identity established; no reserve invented';
 const fields={pool,chain,liquidity_usd:selected?.liquidity_usd??null,pool_address:selected?.pool_address??null,venue:selected?.venue??null,fee_label:selected?.fee_label??null,pool_selection:method,data_status:status,candidates:candidates.slice(0,10),candidate_count_in_page:candidates.length,as_of:fetchedAt};
 const evidence=JSON.stringify({...fields,source_url:body?url:null,attempted_source_url:url,source_raw_body:body,observed_at_semantics:'retrieval time; source exposes no reserve observation timestamp',method,terms_basis:'Public keyless endpoint; no provider licence or commercial redistribution permission asserted; no block bypass'}),receipt=makeReceipt('LIQUIDITY_DEPTH_VERIFY_GENERAL',url??'urn:verireceipt:liquidity-coverage',evidence,'GeckoTerminal pool reserveUSD; exact identity and selection disclosed');receipt.fetched_at=fetchedAt;
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','pool discovery receipt evidence could not be stored');}
 return envelope('LIQUIDITY_DEPTH_VERIFY_GENERAL',fields,receipt,{answer:selected?`${pool} on ${chain}: ${selected.liquidity_usd} USD total pool reserves. Pool ${selected.pool_address}, venue ${selected.venue}, fee ${selected.fee_label??'not supplied'}. ${method}. Retrieval ${fetchedAt}, not an executable-depth quote.`:`${pool} on ${chain}: ${status}. No total reserve asserted; ${method}.`,verdict:selected?'verified':'no_data',confidence:selected?0.8:0,source:selected?`GeckoTerminal ${url}`:body?`Unverified or ambiguous GeckoTerminal response from ${url}, no reserve asserted`:'No validated source observation; coverage or unavailable status only'});
}
