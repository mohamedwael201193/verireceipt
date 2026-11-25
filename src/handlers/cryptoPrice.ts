// CRYPTO_PRICE_USD — GET /v1/crypto-price?symbol=<SYM>
//
// Zero-LLM. Current USD spot price for a crypto symbol, with a SHA-256
// receipt over the exact upstream response body.
//
// Intent contract (read 2026-11-22): request symbol (string); scored
// price in [0.0001, 10000000].
//
// SOURCE: Coinbase public spot API (api.coinbase.com), keyless, probed
// live 2026-11-23. Single named source, honestly scoped: it is one
// exchange's last spot quote, named as such in every answer — not an
// index, not a VWAP. Symbols the source does not list are an honest
// 422 (the source's 404 is surfaced, never guessed). A price outside
// the contract range is refused. The on-chain /v1/price intent
// (Chainlink anchors) is untouched.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";


const SOURCE_TIMEOUT_MS = 6000;
const UA = "VeriReceipt/2.0 crypto-price observer (+https://verireceipt.vercel.app)";

export const INTENT = "CRYPTO_PRICE_USD";

/** A numeric amount alone cannot establish the requested asset or quote currency. */
export function parseCryptoSpot(raw:string,symbol:string):number {
 let data:unknown;try{data=JSON.parse(raw)?.data;}catch{throw upstreamUnavailable('COINBASE_BAD_BODY','Coinbase spot body was not valid JSON');}
 const d=data as Record<string,unknown>|undefined;
 if(!d||d.base!==symbol||d.currency!=='USD')throw upstreamUnavailable('COINBASE_IDENTITY_MISMATCH','Coinbase spot did not identify the requested asset and USD quote');
 if(typeof d.amount!=='string'||!/^\d+(?:\.\d+)?$/.test(d.amount))throw upstreamUnavailable('COINBASE_BAD_BODY','Coinbase amount must be an explicit positive decimal string');
 const price=Number(d.amount);if(!Number.isFinite(price)||price<0.0001||price>10000000)throw unprocessable('OUT_OF_CONTRACT_RANGE','Coinbase amount outside supported price range');return price;
}
/** Display-name result keys bind the requested base and USD quote exactly. */
export function parseKrakenSpot(raw:string,symbol:string):number{
 const j=JSON.parse(raw),key=symbol+'/USD';
 if(!Array.isArray(j?.error)||j.error.length||!j.result||typeof j.result!=='object'||Object.keys(j.result).length!==1||!Object.hasOwn(j.result,key))throw Error('Kraken identity/error');
 const value=j.result[key]?.c?.[0];if(typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value))throw Error('Kraken price');
 const n=Number(value);if(!Number.isFinite(n)||n<0.0001||n>10000000)throw Error('Kraken range');return n;
}
/** One deadline covers headers AND bounded body consumption, even if abort is ignored. */
async function readSpot(url:string):Promise<{status:number;body:string}> {
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const work=(async()=>{
  const res=await fetch(url,{signal:controller.signal,redirect:'error',headers:{'User-Agent':UA,Accept:'application/json'}});
  if(res.status!==200){await res.body?.cancel();return {status:res.status,body:''};}
  const len=res.headers.get('content-length');if(len&&Number(len)>65536){await res.body?.cancel();throw new Error('body limit');}
  reader=res.body?.getReader();if(!reader)throw new Error('body missing');const parts:Uint8Array[]=[];let size=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>65536){await reader.cancel();throw new Error('body limit');}parts.push(chunk.value);}}finally{reader.releaseLock();}
  return {status:res.status,body:Buffer.concat(parts).toString('utf8')};
 })();
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();if(reader)void reader.cancel().catch(()=>{});reject(new Error('deadline'));},SOURCE_TIMEOUT_MS);})]);}finally{clearTimeout(timer!);}
}

export async function handleCryptoPrice(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const symbol = query.symbol?.trim().toUpperCase();
  if (!symbol) throw badRequest("MISSING_PARAM", "symbol is required (e.g. BTC, ETH)");
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) throw badRequest("BAD_SYMBOL", "symbol must be 2-12 letters or digits");
  const url = `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`;
  const crossUrl=`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent((symbol==='BTC'?'XBT':symbol)+'USD')}&assetVersion=1`;
  const [spotResult,crossResult]=await Promise.allSettled([readSpot(url),readSpot(crossUrl)]);
  if(spotResult.status!=='fulfilled')throw upstreamUnavailable('COINBASE_UNREACHABLE','Coinbase spot headers/body unavailable within bounded read');
  const spot=spotResult.value;
  if(spot.status===404)throw unprocessable('SYMBOL_NOT_LISTED',`Coinbase spot does not list ${symbol}-USD; no price guessed`);
  if(spot.status!==200)throw upstreamUnavailable('COINBASE_UNREACHABLE',`Coinbase spot answered HTTP ${spot.status}`);
  const fetchedAt=new Date().toISOString(),body=spot.body;
  const primaryPrice=parseCryptoSpot(body,symbol);
  let crossPrice:number|undefined,crossBody:string|undefined;
  let crossStatus='unavailable';
  if(crossResult.status==='fulfilled'&&crossResult.value.status===200){
    crossBody=crossResult.value.body;
    try{crossPrice=parseKrakenSpot(crossBody,symbol);crossStatus='available';}catch{crossStatus='invalid_or_unlisted';}
  }
  const deviationBps=crossPrice===undefined?null:Math.abs(crossPrice-primaryPrice)/primaryPrice*10000;
  if(deviationBps!==null&&deviationBps>20)throw upstreamUnavailable('SPOT_PRICE_CONFLICT','Coinbase and Kraken spot differ by more than20basispoints; no price certified');
  const price=crossPrice===undefined?primaryPrice:(primaryPrice+crossPrice)/2;
  const policy=crossPrice===undefined?'Coinbase single-source spot; independent Kraken cross-check unavailable; no median calculated, not an index or VWAP':'Coinbase spot and Kraken last trade agree within20bps; two-price median (midpoint), not a market-wide index';
  const asOf = fetchedAt;
  const evidence = JSON.stringify({ symbol, as_of: asOf, price,
    source_policy:policy,crosscheck_status:crossStatus,coinbase_price:primaryPrice,kraken_price:crossPrice??null,deviation_bps:deviationBps,source_quote_timestamp:null,
    raw_bodies: { spot: body,...(crossBody?{kraken:crossBody}:{}) }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, crossPrice===undefined?url:url+" + "+crossUrl, evidence,policy);
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer =
    `${symbol}/USD spot ${price}, acquired ${fetchedAt}. ${policy}. Source quote timestamps are unavailable, so acquisition time is not proof of last-trade freshness; symbols Coinbase does not list are refused.`;
  return envelope(INTENT, {
    symbol, price_usd: price, quote_currency: "USD", as_of:asOf,fetched_at:fetchedAt,acquisition_age_seconds:Math.floor((Date.now()-Date.parse(fetchedAt))/1000),source_quote_timestamp:null,crosscheck_status:crossStatus,deviation_bps:deviationBps,price_method:crossPrice===undefined?"coinbase_spot":"two_source_median",
  }, receipt, { answer, verdict: "verified", confidence: 0.85,
    source: `${url}${crossPrice===undefined?'':' + '+crossUrl}; ${policy}; acquired ${fetchedAt}` });
}
