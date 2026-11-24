// Independent, keyless primary reads. Fixed source origins and exact request
// selectors, never provider-supplied URLs. No paid/provider endpoint is here.
import {createHash} from 'node:crypto';
import type {Fetch} from './client.js';
import {decimal,factHash,type FactSpec,type SourceEvidence} from './researchDesk.js';
import {verifyFilingSource} from './filingSource.js';
import {CHAIN_RPCS} from '../../src/config/chains.js';
import {TOKEN_CONTRACTS} from '../../src/handlers/tokenContracts.js';
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
   const result={url,raw_text,observed_at:now().toISOString(),json:JSON.parse(raw_text),method:init?.method??'GET',body:typeof init?.body==='string'?init.body:undefined};reads.push(result);return result;
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
   default: fail('no independent primary parser for intent');
  }
  if(!reads.length)fail('primary evidence empty');
  // Multiple reads remain exact embedded bytes in an ordered JSON container.
  const raw_text=JSON.stringify(reads.map(({url,raw_text,observed_at,method,body})=>({url,raw_text,observed_at,method:method??'GET',...(body?{body}: {})})));
  return {ok:true,as_of,source:{url:reads[0].url,raw_text,content_sha256:sha(raw_text),observed_at:reads.at(-1)!.observed_at,scope_hash:factHash(fact),value,parser},reasons:[]};
 }catch(error){return {ok:false,source:null,as_of,reasons:[error instanceof Error?error.message:String(error)]};}
}
