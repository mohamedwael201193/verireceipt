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
  const fetchedAt = new Date().toISOString();
  let spot:{status:number;body:string};
  try{spot=await readSpot(url);}catch{throw upstreamUnavailable('COINBASE_UNREACHABLE','Coinbase spot headers/body unavailable within bounded read');}
  if(spot.status===404)throw unprocessable('SYMBOL_NOT_LISTED',`Coinbase spot does not list ${symbol}-USD; no price guessed`);
  if(spot.status!==200)throw upstreamUnavailable('COINBASE_UNREACHABLE',`Coinbase spot answered HTTP ${spot.status}`);
  const body=spot.body;
  const price=parseCryptoSpot(body,symbol);
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ symbol, as_of: asOf, price,
    source_policy: "Coinbase public spot API, single named source; one exchange's last spot quote, not an index or VWAP",
    raw_bodies: { spot: body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, url, evidence, "Coinbase public spot, single source honestly named");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer =
    `${symbol}/USD spot ${price} on Coinbase, fetched ${fetchedAt}. ` +
    `This is one named exchange's public spot quote, not an index or VWAP; symbols the source does not list are refused.`;
  return envelope(INTENT, {
    symbol, price_usd: price, quote_currency: "USD",
  }, receipt, { answer, verdict: "verified", confidence: 0.85,
    source: `${url}; Coinbase public spot single source; fetched ${fetchedAt}` });
}
