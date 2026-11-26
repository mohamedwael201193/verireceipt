import {unprocessable,upstreamUnavailable} from '../core/errors';
import {readPublicBody,PublicBodyCache,StartBudget} from '../core/publicSource';
export interface RankedLocation {latitude:number;longitude:number;label:string;count:number;rank:1;provider:string}
export function parseRankedLocation(raw:string,provider:'Open-Meteo'|'Photon'):RankedLocation|null {
 const j=JSON.parse(raw);const rows=provider==='Open-Meteo'?(j.results===undefined&&!j.error?[]:j.results):j.features;
 if(!Array.isArray(rows))throw new Error('malformed geocoder response');if(!rows.length)return null;
 const h=rows[0];const lat=provider==='Open-Meteo'?h.latitude:Number(h.geometry?.coordinates?.[1]);const lon=provider==='Open-Meteo'?h.longitude:Number(h.geometry?.coordinates?.[0]);
 const label=provider==='Open-Meteo'?[h.name,h.admin1,h.country].filter(Boolean).join(', '):[h.properties?.name,h.properties?.housenumber,h.properties?.street,h.properties?.city,h.properties?.state,h.properties?.country].filter(Boolean).join(', ');
 if(typeof lat!=='number'||typeof lon!=='number'||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180||!label|| (provider==='Photon'&&(h.geometry?.type!=='Point'||!Array.isArray(h.geometry.coordinates)||h.geometry.coordinates.some((x:unknown)=>typeof x!=='number'))))throw new Error('invalid top geocoder result');
 return {latitude:lat,longitude:lon,label,count:rows.length,rank:1,provider};
}
let cache=new PublicBodyCache(1000,86400000),budget=new StartBudget(100,86400000),nextStart=0,halted=false;
export function resetRouteGeocoderForTests():void {cache=new PublicBodyCache(1000,86400000);budget=new StartBudget(100,86400000);nextStart=0;halted=false;}
async function read(url:string) {
 return cache.get(url,async()=>{
  if(halted)throw new Error('geocoder reads halted');const wait=Math.max(0,nextStart-Date.now());if(wait>1500||!budget.take())throw new Error('geocoder conservative budget exhausted');nextStart=Date.now()+wait+1100;
  if(wait)await new Promise(r=>setTimeout(r,wait));if(halted)throw new Error('geocoder reads halted');
  let timer:ReturnType<typeof setTimeout>;
  try{return await Promise.race([readPublicBody(url,1000000,1200),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('geocoder deadline')),1200);})]).finally(()=>clearTimeout(timer!));}catch(e){halted=true;throw e;}
 });
}
export async function resolveRoutePlace(query:string):Promise<{hit:RankedLocation;captures:{url:string;body:string;fetched_at:string}[]}> {
 const captures:{url:string;body:string;fetched_at:string}[]=[];
 for(const provider of ['Open-Meteo','Photon'] as const){
  const url=provider==='Open-Meteo'?`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=10&language=en&format=json`:`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=10&lang=en`;
  try{const body=await read(url);captures.push({url,body:body.raw,fetched_at:body.fetchedAt});const hit=parseRankedLocation(body.raw,provider);if(hit)return {hit,captures};}catch{throw upstreamUnavailable('GEOCODER_UNREACHABLE','route geocoder unavailable or invalid; no retry, bypass or guessed location');}
 }
 throw unprocessable('PLACE_NOT_FOUND','neither city nor street geocoder returned a location; pass valid lat,lon');
}
export const ROUTE_GEOCODER_ATTRIBUTION='Geocoding: Open-Meteo / GeoNames (CC BY 4.0); street fallback Photon, contains OpenStreetMap contributors data under ODbL 1.0, https://www.openstreetmap.org/copyright and https://opendatacommons.org/licenses/odbl/1-0/.';
