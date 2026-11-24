import {badRequest,upstreamUnavailable} from '../core/errors';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
import {readPublicBody,StartBudget} from '../core/publicSource';
const budget=new StartBudget(30,60000);
const SCALE=100000000n;
const fixed=(v:unknown):bigint=>{if(typeof v!=='string'||!/^\d{1,12}(\.\d{1,8})?$/.test(v))throw new Error('invalid order decimal');const [a,b='']=v.split('.');return BigInt(a)*SCALE+BigInt(b.padEnd(8,'0'))};
export function parseDepth(raw:string,venue:'gemini'|'bitstamp',now:number):{liquidity_usd:number;bid_depth_usd:number;ask_depth_usd:number;midpoint_usd:number;band_pct:number;observed_at:string}{
 const j=JSON.parse(raw);
 const read=(side:unknown):[bigint,bigint][]=>{if(!Array.isArray(side)||side.length<2||side.length>20000)throw new Error('missing or oversized side');return side.map(r=>{const p=fixed(venue==='gemini'?r.price:r[0]),a=fixed(venue==='gemini'?r.amount:r[1]);if(p<=0n||a<=0n)throw new Error('nonpositive order');return[p,a]})};
 const bids=read(j.bids),asks=read(j.asks);
 for(let i=1;i<bids.length;i++)if(bids[i][0]>=bids[i-1][0])throw new Error('unsorted duplicate bids');
 for(let i=1;i<asks.length;i++)if(asks[i][0]<=asks[i-1][0])throw new Error('unsorted duplicate asks');
 if(bids[0][0]>=asks[0][0])throw new Error('crossed book');
 const mid=(bids[0][0]+asks[0][0])/2n;
 // Refuse a truncated book that does not span the whole stated band.
 if(bids[bids.length-1][0]*100n>=mid*98n||asks[asks.length-1][0]*100n<=mid*102n)throw new Error('book does not cover full2% band');
 const timestamp=venue==='bitstamp'?Number(j.timestamp):Math.max(Number(j.bids[0].timestamp),Number(j.asks[0].timestamp));
 if(!Number.isFinite(timestamp)||now-timestamp*1000>30000||timestamp*1000>now+5000)throw new Error('stale order book');
 const bid=bids.filter(([p])=>p*100n>=mid*98n).reduce((sum,[p,a])=>sum+p*a,0n);
 const ask=asks.filter(([p])=>p*100n<=mid*102n).reduce((sum,[p,a])=>sum+p*a,0n);
 const usd=(v:bigint)=>Number((v+SCALE*SCALE/200n)/(SCALE*SCALE/100n))/100;
 const total=usd(bid+ask);if(!Number.isFinite(total)||total<1||total>1e12)throw new Error('depth out of range');
 return {liquidity_usd:total,bid_depth_usd:usd(bid),ask_depth_usd:usd(ask),midpoint_usd:Number(mid)/1e8,band_pct:2,observed_at:new Date(timestamp*1000).toISOString()};
}
export async function handleCexDepth(q:Record<string,string|undefined>):Promise<Record<string,unknown>>{
 const venue=q.chain?.toLowerCase();if(venue!=='gemini'&&venue!=='bitstamp')throw badRequest('INVALID_VENUE','chain must explicitly select gemini or bitstamp for CEX depth');
 const pair=q.pool?.trim().toUpperCase();if(!pair||!['BTC/USD','BTCUSD','ETH/USD','ETHUSD'].includes(pair))throw badRequest('INVALID_SPOT_PAIR','CEX depth supports explicit BTC/USD or ETH/USD only');
 const symbol=pair.replace('/','').toLowerCase();const canonical=symbol==='btcusd'?'BTC/USD':'ETH/USD';
 if(!budget.take())throw upstreamUnavailable('CEX_BUDGET','public order-book request budget reached');
 const url=venue==='gemini'?`https://api.gemini.com/v1/book/${symbol}?limit_bids=0&limit_asks=0`:`https://www.bitstamp.net/api/v2/order_book/${symbol}/?group=1`;
 let raw:string,fetched:string,depth:ReturnType<typeof parseDepth>;
 try{const r=await readPublicBody(url,1000000,2500);raw=r.raw;fetched=r.fetchedAt;depth=parseDepth(raw,venue,Date.now())}catch{throw upstreamUnavailable('CEX_DEPTH_UNAVAILABLE','current complete order book unavailable; no substitute pool or venue used')}
 const scope='CEX spot bid plus ask USD notional within2% of best-bid/ask midpoint; not DEX pool liquidity, not guaranteed executable size';
 const evidence=JSON.stringify({venue,pair:canonical,...depth,scope,raw_body:raw!,fetched_at:fetched!});
 const receipt=makeReceipt('LIQUIDITY_DEPTH_VERIFY_GENERAL',url,evidence,'single public CEX book; exact fixed-decimal band sum; no book cache');receipt.fetched_at=fetched!;
 try{await saveReceipt(receipt,evidence)}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable')}
 const answer=`${venue} ${canonical}: ${depth!.liquidity_usd} USD CEX spot depth (${depth!.bid_depth_usd} bids + ${depth!.ask_depth_usd} asks), within +/-2% of midpoint ${depth!.midpoint_usd} USD. ${scope}.`;
 return envelope('LIQUIDITY_DEPTH_VERIFY_GENERAL',{pool:canonical,chain:venue,...depth!,summary:answer},receipt,{answer,verdict:'verified',confidence:0.9,source:`${venue} public order book ${url}; observed ${depth!.observed_at}`});
}
