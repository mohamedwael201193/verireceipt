import {upstreamUnavailable} from '../core/errors';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {cachedEquityQuote,cachedYahooSearch,type EquityObservation} from './equityQuoteCache';
const INTENT='FINANCIAL_DATA_GENERAL';
export async function internationalEquity(asset:string,ticker:string,name:string,search:EquityObservation,indexBody:string,load:(url:string)=>Promise<string>){
 const now=Date.now(),chartUrl=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
 const sharesUrl=`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}?type=quarterlyOrdinarySharesNumber,annualOrdinarySharesNumber&period1=${Math.floor(now/1000)-2*366*86400}&period2=${Math.floor(now/1000)}`;
 const parseChart=(body:string)=>{
  const m=JSON.parse(body)?.chart?.result?.[0]?.meta;
  if(!m||m.symbol!==ticker||m.instrumentType!=='EQUITY'||!['USD','EUR','GBP','GBp','JPY','CAD','CHF','AUD'].includes(m.currency)||!Number.isFinite(m.regularMarketPrice)||m.regularMarketPrice<=0||!Number.isFinite(m.regularMarketTime)||m.regularMarketTime*1000>now+60000||now-m.regularMarketTime*1000>7*86400000)throw Error('invalid equity quote identity, currency or age');return m;
 };
 const parseShares=(body:string)=>{
  const d=JSON.parse(body)?.timeseries;if(d?.error||!Array.isArray(d?.result))throw Error('invalid shares response');
  const rows=d.result.flatMap((r:any)=>{
   const key=r?.meta?.type?.[0];if(r?.meta?.symbol?.length!==1||r.meta.symbol[0]!==ticker||!['quarterlyOrdinarySharesNumber','annualOrdinarySharesNumber'].includes(key))throw Error('wrong shares identity');
   return(r[key]??[]).map((x:any)=>({value:x?.reportedValue?.raw,date:x?.asOfDate}));
  }).filter((r:any)=>Number.isFinite(r.value)&&r.value>0&&/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&Date.parse(r.date)<=now&&now-Date.parse(r.date)<=2*366*86400000).sort((a:any,b:any)=>b.date.localeCompare(a.date));
  if(!rows.length)throw Error('no usable reported shares');const top=rows.filter((r:any)=>r.date===rows[0].date);if(top.some((r:any)=>r.value!==top[0].value))throw Error('conflicting latest shares');return top[0];
 };
 let quote:EquityObservation,shares:EquityObservation;
 try{[quote,shares]=await Promise.all([cachedEquityQuote(ticker,()=>load(chartUrl),parseChart),cachedYahooSearch('reported-shares:'+ticker,()=>load(sharesUrl),parseShares)]);}catch{throw upstreamUnavailable('SOURCE_UNREACHABLE','resolved non-SEC equity lacks validated price or reported ordinary shares; no market cap guessed');}
 const m=parseChart(quote.body),s=parseShares(shares.body),currency=m.currency==='GBp'?'GBP':m.currency,scale=m.currency==='GBp'?.01:1;
 let rate=1,fxBody:string|null=null,fxUrl:string|null=null;
 if(currency!=='USD'){
  fxUrl=`https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=USD`;
  try{fxBody=await load(fxUrl);const f=JSON.parse(fxBody);if(f.base!==currency||f.amount!==1||!/^\d{4}-\d{2}-\d{2}$/.test(f.date)||Date.parse(f.date)>now+60000||now-Date.parse(f.date)>7*86400000||!Number.isFinite(f.rates?.USD)||f.rates.USD<=0)throw Error('invalid conversion');rate=f.rates.USD;}catch{throw upstreamUnavailable('SOURCE_UNREACHABLE','validated currency conversion unavailable; no USD cap guessed');}
 }
 const cap=Math.round(m.regularMarketPrice*scale*s.value*rate);if(!Number.isFinite(cap)||cap<=0||cap>1e15)throw upstreamUnavailable('BAD_MARKET_DATA','derived market cap outside contract range');
 const stale=Boolean(quote.staleReason||shares.staleReason||search.staleReason),fetchedAt=new Date().toISOString();
 const evidence=JSON.stringify({requested_asset:asset,ticker,name,methodology:'reported ordinary shares x regular-market local price x minor-unit scale x USD reference FX; mixed-age derived estimate, not official market cap',price:m.regularMarketPrice,quote_currency:m.currency,minor_unit_scale:scale,ordinary_shares:s.value,shares_as_of:s.date,usd_fx:rate,market_cap_usd:cap,volume_24h_usd:null,market_time:new Date(m.regularMarketTime*1000).toISOString(),quote_acquired_at:quote.fetchedAt,shares_acquired_at:shares.fetchedAt,search_acquired_at:search.fetchedAt,stale,raw_bodies:{company_index:indexBody,search:search.body,chart:quote.body,shares:shares.body,fx:fxBody},urls:{chart:chartUrl,shares:sharesUrl,fx:fxUrl},fetched_at:fetchedAt});
 const receipt=makeReceipt(INTENT,chartUrl+' + '+sharesUrl+(fxUrl?' + '+fxUrl:''),evidence,'single exact equity search resolution; reported shares/price/FX derivation');receipt.fetched_at=[quote.fetchedAt,shares.fetchedAt,search.fetchedAt].sort()[0];
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 return envelope(INTENT,{asset:ticker,asset_type:'equity',symbol:ticker,name,resolved_name:name,market_cap_usd:cap,volume_24h_usd:null,as_of:quote.fetchedAt,stale,metrics:`ordinary_shares=${s.value} as of ${s.date}; local_price=${m.regularMarketPrice} ${m.currency}; scale=${scale}; USD_FX=${rate}`},receipt,{answer:`${stale?'STALE cached source evidence, not current market data. ':''}${name} (${ticker}) derived market cap estimate $${cap}: ${s.value} reported ordinary shares as of ${s.date} x regular-market price ${m.regularMarketPrice} ${m.currency} x minor-unit scale ${scale} x USD reference FX ${rate}. Single exact equity search match, outside SEC index. Mixed-age estimate, not an official market cap; share classes or treasury holdings may differ from tradable shares. Price may be delayed. Rolling 24h USD volume is unavailable, not zero. Quote acquired ${quote.fetchedAt}; shares acquired ${shares.fetchedAt}; search acquired ${search.fetchedAt}; original timestamps retained.`,verdict:stale?'stale':'verified',confidence:stale?.5:.7,source:chartUrl+' + '+sharesUrl+(fxUrl?' + '+fxUrl:'')});
}
