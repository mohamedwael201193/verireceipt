import {unprocessable,upstreamUnavailable} from '../core/errors';
import {readPublicBody,publicSourceFailure,PublicBodyCache,StartBudget} from '../core/publicSource';
export interface RankedLocation {latitude:number;longitude:number;label:string;count:number;rank:1;provider:string}
export function parseRankedLocation(raw:string,provider:'Open-Meteo'|'Photon'):RankedLocation|null {
 const j=JSON.parse(raw);const rows=provider==='Open-Meteo'?(j.results===undefined&&!j.error?[]:j.results):j.features;
 if(!Array.isArray(rows))throw new Error('malformed geocoder response');if(!rows.length)return null;
 const h=rows[0];const lat=provider==='Open-Meteo'?h.latitude:Number(h.geometry?.coordinates?.[1]);const lon=provider==='Open-Meteo'?h.longitude:Number(h.geometry?.coordinates?.[0]);
 const label=provider==='Open-Meteo'?[h.name,h.admin1,h.country].filter(Boolean).join(', '):[h.properties?.name,h.properties?.housenumber,h.properties?.street,h.properties?.city,h.properties?.state,h.properties?.country].filter(Boolean).join(', ');
 if(typeof lat!=='number'||typeof lon!=='number'||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180||!label|| (provider==='Photon'&&(h.geometry?.type!=='Point'||!Array.isArray(h.geometry.coordinates)||h.geometry.coordinates.some((x:unknown)=>typeof x!=='number'))))throw new Error('invalid top geocoder result');
 return {latitude:lat,longitude:lon,label,count:rows.length,rank:1,provider};
}
/** True for a populated place or administrative division (GeoNames PPL*, ADM*). A missing feature code is not accepted. */
export const isCityRow=(r:any):boolean=>typeof r?.feature_code==='string'&&/^(PPL|ADM)/.test(r.feature_code);
/** Time one request may spend waiting in and reading from the geocoder queue. The route read after it
 * keeps its own 6 s limit. The validator's own timeout is not published; this is a conservative
 * share of a 9 s request, leaving 1.5 s for the route read. Reads stay 1.1 s apart whatever it is. */
export const ROUTE_GEOCODE_BUDGET_MS=7500;
const READ_TIMEOUT_MS=1200;
class GeocoderBusy extends Error{}
let cache=new PublicBodyCache(1000,86400000),budget=new StartBudget(100,86400000),nextStart=0,haltedUntil:Record<'Photon'|'Open-Meteo',number>={Photon:0,'Open-Meteo':0};
/** A failed Photon read stops further Photon reads for this long. Open-Meteo halts for the same time only on an explicit
 * refusal (HTTP 403 or 429), never on a timeout or 5xx. Each halt is per provider, so a Photon outage never stops
 * Open-Meteo city pairs. No retry, no bypass. */
export const PROVIDER_HALT_MS=300000;
export function resetRouteGeocoderForTests():void {cache=new PublicBodyCache(1000,86400000);budget=new StartBudget(100,86400000);nextStart=0;haltedUntil={Photon:0,'Open-Meteo':0};}
const haltsProvider=(provider:'Photon'|'Open-Meteo',e:unknown)=>provider==='Photon'||['http_403','http_429'].includes(publicSourceFailure(e));
const providerOf=(url:string)=>new URL(url).hostname==='photon.komoot.io'?'Photon':'Open-Meteo';
async function read(url:string,deadlineAt:number) {
 return cache.get(url,async()=>{
  const provider=providerOf(url);const isHalted=()=>Date.now()<haltedUntil[provider];
  if(isHalted())throw new Error('geocoder reads halted');const wait=Math.max(0,nextStart-Date.now());
  // Queue: each read reserves the next 1.1 s start slot. It waits for it only if the read can finish inside this request's budget.
  if(wait+READ_TIMEOUT_MS>deadlineAt-Date.now())throw new GeocoderBusy('geocoder queue would exceed the response budget');
  if(!budget.take())throw new Error('geocoder conservative budget exhausted');nextStart=Date.now()+wait+1100;
  if(wait)await new Promise(r=>setTimeout(r,wait));if(isHalted())throw new Error('geocoder reads halted');
  let timer:ReturnType<typeof setTimeout>;const startedAt=Date.now();
  try{return await Promise.race([readPublicBody(url,1000000,READ_TIMEOUT_MS),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('geocoder deadline')),READ_TIMEOUT_MS);})]).finally(()=>clearTimeout(timer!));}catch(e){console.warn(JSON.stringify({event:'route_geocoder_read_failed',provider,error:e instanceof Error?e.name:'non-error',timeout:e instanceof Error&&/deadline|timeout|abort/i.test(e.message+e.name),elapsed_ms:Date.now()-startedAt,halts_provider_ms:haltsProvider(provider,e)?PROVIDER_HALT_MS:0}));if(haltsProvider(provider,e))haltedUntil[provider]=Date.now()+PROVIDER_HALT_MS;throw e;}
 });
}
export async function resolveRoutePlace(query:string,deadlineAt:number=Date.now()+ROUTE_GEOCODE_BUDGET_MS):Promise<{hit:RankedLocation;captures:{url:string;body:string;fetched_at:string}[]}> {
 const captures:{url:string;body:string;fetched_at:string}[]=[];
 for(const provider of ['Open-Meteo','Photon'] as const){
  const url=provider==='Open-Meteo'?`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=10&language=en&format=json`:`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=10&lang=en`;
  try{const body=await read(url,deadlineAt);captures.push({url,body:body.raw,fetched_at:body.fetchedAt});const hit=parseRankedLocation(body.raw,provider);
   // An Open-Meteo rank 1 that is not a populated place or administrative division (a park, a mountain, a monument) is not a city: ask the street geocoder, never fall back to it.
   if(hit&&provider==='Open-Meteo'&&!isCityRow(JSON.parse(body.raw).results[0]))continue;
   if(hit)return {hit,captures};}catch(e){if(e instanceof GeocoderBusy)throw upstreamUnavailable('GEOCODER_BUSY','route geocoder queue is full for this request: reads are kept 1.1 s apart and the wait would exceed the response budget; nothing was guessed, retry shortly');throw upstreamUnavailable('GEOCODER_UNREACHABLE','route geocoder unavailable or invalid; no retry, bypass or guessed location');}
 }
 throw unprocessable('PLACE_NOT_FOUND','neither city nor street geocoder returned a location; pass valid lat,lon');
}
export const ROUTE_GEOCODER_ATTRIBUTION='Geocoding: Open-Meteo / GeoNames (CC BY 4.0); street fallback Photon, contains OpenStreetMap contributors data under ODbL 1.0, https://www.openstreetmap.org/copyright and https://opendatacommons.org/licenses/odbl/1-0/.';
