import {it,expect} from 'vitest';import{readFileSync}from'node:fs';import{join}from'node:path';
import{parseDepth}from'../src/handlers/cexDepth';
const raw=(v:string)=>readFileSync(join(__dirname,`fixtures/cex-depth/${v}-btcusd.json`),'utf8');
for(const venue of ['gemini','bitstamp'] as const){
const r=raw(venue),j=JSON.parse(r);const now=Number(venue==='bitstamp'?j.timestamp:j.bids[0].timestamp)*1000;
it(`calculates captured ${venue} book band against independent floating reference`,()=>{
 const out=parseDepth(r,venue,now);const rows=(a:any[])=>a.map(x=>venue==='gemini'?[+x.price,+x.amount]:[+x[0],+x[1]]);
 const b=rows(j.bids),a=rows(j.asks),mid=(b[0][0]+a[0][0])/2;
 const total=b.filter(x=>x[0]>=mid*.98).reduce((s,x)=>s+x[0]*x[1],0)+a.filter(x=>x[0]<=mid*1.02).reduce((s,x)=>s+x[0]*x[1],0);
 expect(out.liquidity_usd).toBeCloseTo(total,2);expect(out.band_pct).toBe(2);expect(out.liquidity_usd).toBeGreaterThan(0);
});
it(`${venue} rejects stale, crossed, negative and truncated books`,()=>{
 expect(()=>parseDepth(r,venue,now+30001)).toThrow('stale');
 const truncated=JSON.parse(r);truncated.asks=truncated.asks.slice(0,2);expect(()=>parseDepth(JSON.stringify(truncated),venue,now)).toThrow('cover');
 const bad=JSON.parse(r);if(venue==='gemini')bad.bids[0].amount='-1';else bad.bids[0][1]='-1';expect(()=>parseDepth(JSON.stringify(bad),venue,now)).toThrow();
 const crossed=JSON.parse(r);if(venue==='gemini')crossed.bids[0].price='999999';else crossed.bids[0][0]='999999';expect(()=>parseDepth(JSON.stringify(crossed),venue,now)).toThrow('crossed');
});}
