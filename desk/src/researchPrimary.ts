// Independent, keyless primary reads. Fixed source origins and exact request
// selectors, never provider-supplied URLs. No paid/provider endpoint is here.
import {createHash} from 'node:crypto';
import type {Fetch} from './client.js';
import {decimal,factHash,type FactSpec,type SourceEvidence} from './researchDesk.js';
import {verifyFilingSource} from './filingSource.js';
import {CHAIN_RPCS} from '../../src/config/chains.js';
import {TOKEN_CONTRACTS} from '../../src/handlers/tokenContracts.js';
import {matchScore,normalizeName,parseAlt,parseSdn,parseUn} from '../../src/handlers/sanctionsMatch.js';
import {POR_FEEDS} from '../../src/handlers/reserveAttestation.js';
export interface PrimaryResult { ok:boolean; source:SourceEvidence|null; as_of:string|null; reasons:string[] }
interface Read {url:string;raw_text:string;observed_at:string;json:any;method?:string;body?:string}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const equal=(a:string,b:string)=>{const x=decimal(a),y=decimal(b);return x.n*y.d===y.n*x.d;};
// A fixed declared tolerance accommodates market movement between paid and
// independent reads. It is not the network scoring tolerance.
function within(a:string,b:string,bps:bigint):boolean {const x=decimal(a),y=decimal(b);if(x.n<0n||y.n<=0n)return false;const diff=x.n*y.d-y.n*x.d;return (diff<0n?-diff:diff)*10000n<=bps*y.n*x.d;}
function number(v:unknown):string {if(typeof v!=='number'||!Number.isFinite(v))throw new Error('primary numeric field unavailable');const s=String(v);decimal(s);return s;}
const fail=(message:string):never=>{throw new Error(message);};
export async function verifyResearchPrimary(fact:FactSpec,value:string,options:{f?:Fetch;now?:()=>Date;secUserAgent?:string}={}):Promise<PrimaryResult>{
 const f=options.f??fetch,now=options.now??(()=>new Date());const reads:Read[]=[];
 const read=async(url:string,init?:RequestInit)=>{
   const response=await f(url,{...init,redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error(`primary HTTP ${response.status}`);
   const raw_text=await response.text();if(Buffer.byteLength(raw_text)>8000000||reads.reduce((n,r)=>n+Buffer.byteLength(r.raw_text),0)+Buffer.byteLength(raw_text)>16000000)throw new Error('primary byte limit');
   // Bare scalars (tip height, block hash) are not JSON objects; a body
   // that does not parse leaves json undefined and each case fails closed
   // on its own checks.
   let json:any;try{json=JSON.parse(raw_text);}catch{json=undefined;}
   const result={url,raw_text,observed_at:now().toISOString(),json,method:init?.method??'GET',body:typeof init?.body==='string'?init.body:undefined};reads.push(result);return result;
 };
 let as_of:string|null=null;
 try{
  decimal(value);let parser='';
  switch(fact.intent){
   case 'CRYPTO_PRICE_USD':{
    // Exact symbol mapping is deliberately narrow, not fuzzy identity matching.
    const map:Record<string,{pair:string;key:string}>={BTC:{pair:'XBTUSD',key:'XXBTZUSD'},ETH:{pair:'ETHUSD',key:'XETHZUSD'},SOL:{pair:'SOLUSD',key:'SOLUSD'},UNI:{pair:'UNIUSD',key:'UNIUSD'},LINK:{pair:'LINKUSD',key:'LINKUSD'},WBTC:{pair:'WBTCUSD',key:'WBTCUSD'}};
    const asset=map[fact.params.symbol.toUpperCase()];if(!asset)fail('primary spot symbol not explicitly supported');
    const r=await read(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(asset.pair)}`);
    if(!Array.isArray(r.json.error)||r.json.error.length)fail('spot primary returned error');
    const ticker=r.json.result?.[asset.key];const price=ticker?.c?.[0];if(typeof price!=='string'||!within(value,price,100n))fail('spot USD price differs by more than declared 100 bps independent-read tolerance');
    as_of=r.observed_at;parser='kraken-usd-last-v1-100bps';break;
   }
   case 'STOCK_PRICE_US_EQUITY':{
    const ticker=fact.params.ticker.toUpperCase();if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker))fail('unsupported ticker syntax');
    const r=await read(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`);
    const m=r.json.chart?.result?.[0]?.meta;
    if(m?.symbol!==ticker||m.currency!=='USD'||m.instrumentType!=='EQUITY'||!Number.isSafeInteger(m.regularMarketTime)||!within(value,number(m.regularMarketPrice),100n))fail('share identity/currency/price mismatch');
    as_of=new Date(m.regularMarketTime*1000).toISOString();parser='yahoo-USD-equity-last-trade-v1-100bps';break;
   }
   case 'TVL_LOOKUP_GENERAL':{
    const slug=fact.params.protocol;if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))fail('TVL requires exact protocol slug');
    const r=await read(`https://api.llama.fi/tvl/${encodeURIComponent(slug)}`);
    if(!within(value,number(r.json),100n))fail('protocol TVL differs beyond declared 100 bps independent-read tolerance');
    as_of=r.observed_at;parser='llama-protocol-tvl-v1-100bps';break;
   }
   case 'CRYPTO_YIELD_RATE_GENERAL':{
    const r=await read('https://yields.llama.fi/pools');const rows=r.json.data;
    if(!Array.isArray(rows))fail('yield rows unavailable');
    const matches=rows.filter((p:any)=>p.project===fact.params.project&&String(p.symbol).toUpperCase()===fact.params.symbol.toUpperCase()&&String(p.chain).toLowerCase()===fact.params.chain.toLowerCase());
    // Ambiguous projects with multiple same-symbol pools must HOLD, not pick best yield.
    if(matches.length!==1)fail('yield pool does not resolve uniquely');
    const apy=number(matches[0].apyBase);const x=decimal(apy);
    // Formatting to plain decimal is exact because parsed decimal denominator is 10^n.
    const digits=apy.includes('.')?apy.split('.')[1].length:0;
    const scale=10n**BigInt(digits);const bpsNumerator=x.n*(scale/x.d)*100n;const whole=bpsNumerator/scale;const frac=(bpsNumerator%scale).toString().padStart(digits,'0').replace(/0+$/,'');
    const bps=whole.toString()+(frac?'.'+frac:'');
    if(!within(value,bps,100n))fail('base supply APY differs beyond 100 bps relative tolerance');
    as_of=r.observed_at;parser='llama-unique-pool-base-apy-to-bps-v1';break;
   }
   case 'LIQUIDITY_DEPTH_VERIFY_GENERAL':{
    const pool=fact.params.pool,chain=fact.params.chain;
    if(!/^0x[0-9a-fA-F]{40}$/.test(pool)||!['ethereum','base','arbitrum','optimism','polygon'].includes(chain))fail('liquidity requires explicit supported chain and pool address');
    const network=({ethereum:'eth',base:'base',arbitrum:'arbitrum',optimism:'optimism',polygon:'polygon_pos'} as Record<string,string>)[chain];
    const r=await read(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool.toLowerCase()}`);
    if(r.json.data?.id!==`${network}_${pool.toLowerCase()}`||!within(value,String(r.json.data?.attributes?.reserve_in_usd),100n))fail('pool identity/reserves mismatch');
    as_of=r.observed_at;parser='gecko-chain-pool-reserve-usd-v1-100bps';break;
   }
   case 'MACRO_ECONOMIC_INDICATOR_GENERAL':{
    const country=fact.params.country.toUpperCase(),year=fact.params.year;
    if(fact.params.indicator!=='unemployment rate'||!/^([A-Z]{2}|[A-Z]{3})$/.test(country)||!year||!/^(19[6-9]\d|20\d\d|2100)$/.test(year))fail('macro primary requires explicit ISO country and year');
    const r=await read(`https://api.worldbank.org/v2/country/${country}/indicator/SL.UEM.TOTL.ZS?date=${year}&format=json&per_page=100`);
    const rows=r.json?.[1];if(!Array.isArray(rows)||rows.length!==1)fail('macro year unavailable or ambiguous');const row=rows[0];
    if(row.indicator?.id!=='SL.UEM.TOTL.ZS'||String(row.date)!==year||![row.country?.id,row.countryiso3code].includes(country))fail('macro country/indicator/year mismatch');
    const rounded=String(Math.round(Number(row.value)*1e6)/1e6);
    if(row.value===null||typeof row.value!=='number'||!equal(value,rounded))fail('unemployment numeric value mismatch');
    as_of=r.observed_at;parser='worldbank-SL.UEM.TOTL.ZS-year-v1-6dp';break;
   }
   case 'REGULATORY_FILING_MONITOR_GENERAL':{
    const result=await verifyFilingSource({params:fact.params,result:{filing_count:Number(value)}},{f,now:now(),secUserAgent:options.secUserAgent});
    if(result.status!=='verified')fail(result.checks.filter(c=>!c.ok).map(c=>c.detail).join('; '));
    for(const s of result.sources)reads.push({url:s.url,raw_text:s.raw_text,observed_at:s.retrieved_at,json:null});
    as_of=reads.at(-1)!.observed_at;parser='sec-independent-full-history-form-recount-v1';break;
   }
   case 'SANCTIONS_SCREENING_MATCH_GENERAL':{
    const name=fact.params.name;if(typeof name!=='string'||!name.trim()||name.length>200)fail('sanctions primary requires a name of at most 200 characters');
    if(!normalizeName(name))fail('sanctions name carries no letters or digits to screen');
    // Fixed OFAC/UN origins, the same constants the miner handler publishes.
    // Both publishers serve the bytes from their own pinned publication
    // infrastructure behind a 302: OFAC redirects to its GovCloud S3 bucket,
    // the UN to its Azure blob. Only those literal hosts may be followed -
    // any other redirect target, HTTP refusal or rate limit fails closed:
    // no mirrors, no retries, no workaround. The recorded read keeps the
    // fixed origin URL, so byte replay reparses the same stored bytes.
    const REDIRECT_HOSTS:Record<string,string[]>
     ={'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV':['wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com'],
       'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV':['wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com'],
       'https://scsanctions.un.org/resources/xml/en/consolidated.xml':['unsolprodfiles.blob.core.windows.net'],
       'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONS_PRIM.CSV':['wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com'],
       'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONS_ALT.CSV':['wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com']};
    const UA='VeriReceipt/2.0 sanctions-screening observer (+https://verireceipt.vercel.app)';
    const getList=async(origin:string):Promise<void>=>{
     let url=origin;
     for(let hop=0;;hop++){
      const res=await f(url,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'user-agent':UA}});
      if(res.status>=300&&res.status<400){
       if(hop>=2)throw new Error('sanctions list redirect chain too long');
       const loc=res.headers.get('location');if(!loc)throw new Error('sanctions list redirect without location');
       const target=new URL(loc,url);
       if(target.protocol!=='https:'||target.username||target.password||!REDIRECT_HOSTS[origin].includes(target.host))throw new Error('sanctions list redirect to unpinned host');
       url=target.href;continue;
      }
      if(!res.ok)throw new Error(`primary HTTP ${res.status}`);
      const raw_text=await res.text();
      if(Buffer.byteLength(raw_text)>8000000||reads.reduce((n,r)=>n+Buffer.byteLength(r.raw_text),0)+Buffer.byteLength(raw_text)>16000000)throw new Error('primary byte limit');
      reads.push({url:origin,raw_text,observed_at:now().toISOString(),json:null});return;
     }
    };
    await getList('https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV');
    await getList('https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV');
    await getList('https://scsanctions.un.org/resources/xml/en/consolidated.xml');
    await getList('https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONS_PRIM.CSV');
    await getList('https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONS_ALT.CSV');
    const sdn=parseSdn(reads[0].raw_text),alt=parseAlt(reads[1].raw_text),un=parseUn(reads[2].raw_text);
    const consPrim=parseSdn(reads[3].raw_text),consAlt=parseAlt(reads[4].raw_text);
    // The handler's truncation floors: never screen against a partial list.
    if(sdn.entries.size<1000)fail('OFAC SDN parsed to a truncated list; refusing to screen');
    if(un.length<100)fail('UN consolidated list parsed to a truncated list; refusing to screen');
    if(consPrim.entries.size<300)fail('OFAC Consolidated (non-SDN) parsed to a truncated list; refusing to screen');
    // The handler's exact candidate set and fuzzy match (shared module):
    // SDN primaries, SDN aliases whose parent exists, UN primaries+aliases,
    // Consolidated (non-SDN) primaries and their aliases whose parent
    // exists, best score among candidates at or above the 0.50 floor, else 0.
    let best=0;const consider=(candidate:string)=>{const s=matchScore(name,candidate);if(s>=0.5&&s>best)best=s;};
    for(const n of sdn.entries.values())consider(n);
    for(const a of alt){if(sdn.entries.has(a.altNum))consider(a.name);}
    for(const u of un)consider(u.name);
    for(const n of consPrim.entries.values())consider(n);
    for(const a of consAlt){if(consPrim.entries.has(a.altNum))consider(a.name);}
    // The score is deterministic given the same published lists, so the
    // comparison is exact. A list republication between the paid and
    // independent reads changes the score and fails closed, by design.
    if(!equal(value,String(best)))fail('sanctions best match_score differs from the independent full-list recompute');
    as_of=reads.at(-1)!.observed_at;parser='ofac-sdn-alt-un-cons-full-list-recompute-v1';break;
   }
   case 'TOKEN_HOLDER_COUNT_GENERAL':{
    const chain=(fact.params.chain??'').toLowerCase();if(chain!=='ethereum')fail('holder-count primary is ethereum only; other chains have no parser');
    const token=fact.params.token;const contract=/^0x[0-9a-fA-F]{40}$/.test(token)?token:TOKEN_CONTRACTS.ethereum?.[token.toUpperCase()];if(!contract)fail('holder-count token not in verified contract registry');
    const r=await read(`https://eth.blockscout.com/api/v2/tokens/${contract}`);
    const j=r.json;if(typeof j?.address_hash!=='string'||j.address_hash.toLowerCase()!==contract.toLowerCase())fail('holder-count token identity mismatch');
    const count=j?.holders_count;if(typeof count!=='string'||!/^(0|[1-9]\d*)$/.test(count))fail('holder count unavailable');
    // Declared 100 bps tolerance absorbs holder drift between the paid and
    // independent reads. It is not the network scoring tolerance.
    if(!within(value,count,100n))fail('holder count differs beyond declared 100 bps independent-read tolerance');
    as_of=r.observed_at;parser='blockscout-ethereum-token-holders-v1-100bps';break;
   }
   case 'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL':{
    const match=/^(\S+) on (ethereum|base|arbitrum|optimism|polygon)$/.exec(fact.params.token);if(!match)throw new Error('supply primary requires token on chain');
    const chain=match[2],token=match[1];const contract=/^0x[0-9a-fA-F]{40}$/.test(token)?token:TOKEN_CONTRACTS[chain]?.[token.toUpperCase()];if(!contract)fail('supply token not in verified contract registry');
    const chainIds:Record<string,bigint>={ethereum:1n,base:8453n,arbitrum:42161n,optimism:10n,polygon:137n};
    const rpc=async(url:string,method:string,params:unknown[])=>{const r=await read(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.json.error||r.json.id!==1)fail('RPC error');return r.json.result;};
    const hex=(x:unknown)=>{if(typeof x!=='string'||!/^0x[0-9a-fA-F]+$/.test(x))fail('invalid RPC quantity');return BigInt(x as string);};
    // Two independent chain-bound RPCs. Pin both calls to the same finalized
    // block number; compare block hash as well as supply and decimals.
    const urls=CHAIN_RPCS[chain].slice(0,2);const first=await rpc(urls[0],'eth_getBlockByNumber',['finalized',false]);
    const block=first?.number,blockHash=first?.hash;if(!/^0x[0-9a-fA-F]+$/.test(block)||!/^0x[0-9a-fA-F]{64}$/.test(blockHash))fail('finalized block unavailable');
    const answers=[];
    for(const url of urls){if(hex(await rpc(url,'eth_chainId',[]))!==chainIds[chain])fail('RPC chain mismatch');const b=await rpc(url,'eth_getBlockByNumber',[block,false]);if(b?.hash!==blockHash)fail('RPC finalized block hash mismatch');const raw=hex(await rpc(url,'eth_call',[{to:contract,data:'0x18160ddd'},block]));const decimals=hex(await rpc(url,'eth_call',[{to:contract,data:'0x313ce567'},block]));if(decimals>36n)fail('unsupported token decimals');answers.push({raw,decimals});}
    if(answers[0].raw!==answers[1].raw||answers[0].decimals!==answers[1].decimals)fail('RPC supply/decimals disagreement');
    const paid=decimal(value),s=answers[0];if(paid.n*(10n**s.decimals)!==s.raw*paid.d)fail('whole-token supply mismatch');
    const blockSeconds=hex(first?.timestamp);if(blockSeconds>BigInt(Math.floor(now().getTime()/1000)))fail('future finalized block timestamp');as_of=new Date(Number(blockSeconds)*1000).toISOString();parser='evm-two-rpc-chain-finalized-block-supply-v1';break;
   }
   case 'ASSET_RESERVE_ATTESTATION_GENERAL':{
    const asset=fact.params.asset?.trim();if(!asset||asset.length>60)fail('reserve primary requires an explicit asset symbol');
    // The miner's own pinned probed-live feed registry (shared module):
    // exact symbol only, no address aliases or cross-chain guesses.
    const feed=POR_FEEDS[asset.toUpperCase()];if(!feed)fail('reserve asset not in the pinned probed-live feed registry');
    const urls=CHAIN_RPCS.ethereum.slice(0,2);
    const rpc=async(url:string,method:string,params:unknown[])=>{const r=await read(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.json.error||r.json.id!==1)fail('RPC error');return r.json.result;};
    const hex=(x:unknown)=>{if(typeof x!=='string'||!/^0x[0-9a-fA-F]+$/.test(x))fail('invalid RPC quantity');return BigInt(x as string);};
    // Two independent chain-bound RPCs. Pin both legs to the same finalized
    // block number and compare the block hash, feed decimals and the full
    // latestRoundData round; any disagreement or round change fails closed.
    const first=await rpc(urls[0],'eth_getBlockByNumber',['finalized',false]);
    const block=first?.number,blockHash=first?.hash;if(!/^0x[0-9a-fA-F]+$/.test(block)||!/^0x[0-9a-fA-F]{64}$/.test(blockHash))fail('finalized block unavailable');
    const legs=[];
    for(const url of urls){
     if(hex(await rpc(url,'eth_chainId',[]))!==1n)fail('RPC chain mismatch');
     const b=await rpc(url,'eth_getBlockByNumber',[block,false]);if(b?.hash!==blockHash)fail('RPC finalized block hash mismatch');
     const decimals=hex(await rpc(url,'eth_call',[{to:feed.proxy,data:'0x313ce567'},block]));
     const round=await rpc(url,'eth_call',[{to:feed.proxy,data:'0xfeaf968c'},block]);
     if(typeof round!=='string'||!/^0x[0-9a-fA-F]+$/.test(round)||round.length<2+64*5)fail('reserve round body short');
     const h=round.slice(2);
     legs.push({decimals,roundId:hex('0x'+h.slice(0,64)),answer:hex('0x'+h.slice(64,128)),updatedAt:hex('0x'+h.slice(192,256))});
    }
    const a=legs[0],b=legs[1];
    if(a.decimals!==b.decimals||a.roundId!==b.roundId||a.answer!==b.answer||a.updatedAt!==b.updatedAt)fail('RPC reserve round disagreement');
    if(a.decimals>36n)fail('unsupported feed decimals');
    if(a.answer<=0n)fail('non-positive reserve attestation');
    // The handler's exact conversion: micro = answer x 10^(6 - decimals),
    // floored when the feed carries more than 6 decimals. Compared exactly;
    // a republication between the paid and independent reads fails closed.
    const micro=a.decimals<=6n?a.answer*10n**(6n-a.decimals):a.answer/(10n**(a.decimals-6n));
    const paid=decimal(value);if(paid.n!==micro*paid.d)fail('reserve micro-unit value mismatch');
    const blockSeconds=hex(first?.timestamp);if(blockSeconds>BigInt(Math.floor(now().getTime()/1000)))fail('future finalized block timestamp');as_of=new Date(Number(blockSeconds)*1000).toISOString();parser='evm-two-rpc-finalized-chainlink-por-micro-v1';break;
   }
   case 'ONCHAIN_METRIC_VERIFY_GENERAL':{
    const address=fact.params.address;if(!/^0x[0-9a-fA-F]{40}$/.test(address))fail('onchain metric primary requires an explicit 0x address');
    const blockDec=fact.params.block;if(!/^(0|[1-9]\d*)$/.test(blockDec)||BigInt(blockDec)<=0n)fail('onchain metric primary requires an explicit pinned block');
    const chain=(fact.params.chain??'ethereum').toLowerCase();
    const chainIds:Record<string,bigint>={ethereum:1n,polygon:137n,arbitrum:42161n};
    if(!chainIds[chain]||!CHAIN_RPCS[chain])fail('onchain metric primary supports ethereum/polygon/arbitrum only');
    if(fact.params.metric!==undefined&&fact.params.metric!=='balance')fail('onchain metric primary covers the scored balance metric only');
    const urls=CHAIN_RPCS[chain].slice(0,2);
    const rpc=async(url:string,method:string,params:unknown[])=>{const r=await read(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.json.error||r.json.id!==1)fail('RPC error');return r.json.result;};
    const hex=(x:unknown)=>{if(typeof x!=='string'||!/^0x[0-9a-fA-F]+$/.test(x))fail('invalid RPC quantity');return BigInt(x as string);};
    // Two independent chain-bound RPCs at the same pinned block: compare
    // chain id, the pinned block hash and the exact wei balance; any
    // disagreement fails closed. The pinned block is part of the paid
    // request, so neither leg can drift to a different height.
    const blockHex='0x'+BigInt(blockDec).toString(16);
    const legs=[];
    for(const url of urls){
     if(hex(await rpc(url,'eth_chainId',[]))!==chainIds[chain])fail('RPC chain mismatch');
     legs.push({block:await rpc(url,'eth_getBlockByNumber',[blockHex,false]),wei:hex(await rpc(url,'eth_getBalance',[address,blockHex]))});
    }
    const a=legs[0],b=legs[1];
    if(!a.block?.hash||a.block.hash!==b.block?.hash)fail('RPC pinned block hash mismatch');
    if(a.wei!==b.wei)fail('RPC balance disagreement at pinned block');
    // The handler's conversion is full-precision gwei (wei / 10^9 with no
    // quantization; the live schema's 6 decimals are the scoring display,
    // not the transport). Compared exactly; a balance cannot change at a
    // pinned block, so any mismatch is a discrepancy, not drift.
    const paid=decimal(value);if(paid.n*(10n**9n)!==a.wei*paid.d)fail('balance gwei mismatch at pinned block');
    const blockSeconds=hex(a.block.timestamp);if(blockSeconds>BigInt(Math.floor(now().getTime()/1000)))fail('future pinned block timestamp');as_of=new Date(Number(blockSeconds)*1000).toISOString();parser='evm-two-rpc-pinned-block-balance-gwei-v1';break;
   }
   case 'MINING_HASHPRICE_VERIFY_GENERAL':{
    const heightDec=fact.params.block_height;
    if(!/^(0|[1-9]\d*)$/.test(heightDec)||BigInt(heightDec)<=0n||BigInt(heightDec)>100000000n)fail('hashprice primary requires an explicit pinned Bitcoin block height within the live schema range');
    // Recompute from the same published mempool.space series the handler
    // discloses in its receipt, in a deterministic read order so stored
    // bytes replay exactly. This is a recomputation of the handler's
    // disclosed inputs, never a second-source or independent data
    // verification. Weekly basis when the pinned height is the current tip:
    // revenue per block is the pinned-era subsidy plus the mean measured
    // 1-week block fees, scaled by 144 blocks/day over the mean 1-week
    // hashrate; a fixed declared 500 bps tolerance accommodates
    // 1-week-mean drift between the paid and independent reads. Below the
    // tip the pinned block's reward and difficulty are immutable, so the
    // recompute must match the handler's disclosed 2dp rounding exactly.
    // Neither tolerance is the network scoring tolerance.
    // Race note: if the tip advances between the paid call and this read,
    // the paid weekly-basis value no longer matches the single-block
    // recompute at the pinned height and the fact HOLDs. That is
    // fail-closed by design: a new run pins the new tip.
    const tipR=await read('https://mempool.space/api/blocks/tip/height');
    const tip=Number(tipR.json);if(!Number.isSafeInteger(tip)||tip<1)fail('tip height unavailable');
    const pinned=Number(heightDec);
    if(pinned===tip){
     const SUBSIDY_SATS:Record<number,string>={0:'5000000000',1:'2500000000',2:'1250000000',3:'625000000',4:'312500000',5:'156250000'};
     const subsidy=SUBSIDY_SATS[Math.floor(tip/210000)];if(!subsidy)fail('subsidy era outside the pinned era table');
     const hr=await read('https://mempool.space/api/v1/mining/hashrate/1w');
     const fees=await read('https://mempool.space/api/v1/mining/blocks/fees/1w');
     const hrows=Array.isArray(hr.json?.hashrates)?hr.json.hashrates:[];const hvals=hrows.map((r:any)=>Number(r?.avgHashrate)).filter((v:number)=>Number.isFinite(v)&&v>0);
     if(!hvals.length)fail('hashrate series carried no usable entries');
     const frows=Array.isArray(fees.json)?fees.json:[];const fvals=frows.map((r:any)=>Number(r?.avgFees)).filter((v:number)=>Number.isFinite(v)&&v>=0);
     if(!fvals.length)fail('block-fee series carried no usable entries');
     const mean=(xs:number[])=>xs.reduce((a:number,c:number)=>a+c,0)/xs.length;
     const sats=(Number(subsidy)+mean(fvals))*144*1e15/mean(hvals);
     if(!Number.isFinite(sats)||sats<1||sats>1e9)fail('recomputed hashprice outside the live contract range');
     if(!within(value,sats.toFixed(6),500n))fail('hashprice differs by more than declared 500 bps independent-read tolerance');
     as_of=reads.at(-1)!.observed_at;parser='mempool-1w-series-hashprice-recompute-v1-500bps';
    } else if(pinned<tip){
     const hashR=await read(`https://mempool.space/api/block-height/${pinned}`);
     const blockHash=hashR.raw_text.trim();if(!/^[0-9a-f]{64}$/.test(blockHash))fail('block-height source returned no usable hash');
     const blk=await read(`https://mempool.space/api/v1/block/${blockHash}`);
     const reward=blk.json?.extras?.reward,difficulty=blk.json?.difficulty;
     if(blk.json?.id!==blockHash||blk.json?.height!==pinned||!Number.isSafeInteger(reward)||reward<=0||!Number.isFinite(difficulty)||difficulty<=0)fail('pinned block identity or measured inputs invalid');
     // sats/PH/day = reward*144*1e15/(difficulty*2^32/600), exact rational;
     // the paid value carries the handler's disclosed 2dp rounding (0.005).
     const x=decimal(value);const num=BigInt(reward)*144n*(10n**15n)*600n,den=BigInt(Math.round(difficulty))*(2n**32n);
     const diff=x.n*den-num*x.d;if((diff<0n?-diff:diff)*200n>x.d*den)fail('hashprice mismatch beyond the disclosed 2dp rounding at the pinned block');
     as_of=reads.at(-1)!.observed_at;parser='mempool-single-block-hashprice-recompute-v1';
    } else fail('pinned height above observed tip; no future block hashprice is asserted');
    break;
   }
   default: fail('no independent primary parser for intent');
  }
  if(!reads.length)fail('primary evidence empty');
  // Multiple reads remain exact embedded bytes in an ordered JSON container.
  const raw_text=JSON.stringify(reads.map(({url,raw_text,observed_at,method,body})=>({url,raw_text,observed_at,method:method??'GET',...(body?{body}: {})})));
  return {ok:true,as_of,source:{url:reads[0].url,raw_text,content_sha256:sha(raw_text),observed_at:reads.at(-1)!.observed_at,scope_hash:factHash(fact),value,parser},reasons:[]};
 }catch(error){return {ok:false,source:null,as_of,reasons:[error instanceof Error?error.message:String(error)]};}
}
