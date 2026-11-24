import { upstreamUnavailable } from '../core/errors';
import { readPublicBody, PublicBodyCache } from '../core/publicSource';
export const STORM_HEURISTIC='VeriReceipt heuristic, not an official warning or contract formula: gust >=60/90/120 km/h OR maximum rolling 24-hour forecast precipitation >=25/50/100 mm gives MODERATE/HIGH/SEVERE (0.5/0.75/1), otherwise LOW (0). For windows shorter than 24h, rain uses that shorter window. Final score is maximum of forecast heuristic and available NWS alert score.';
export function forecastWindow(now:number,hours:number):{start:number;end:number} {
 const start=Math.ceil(now/3600000)*3600000;return {start,end:start+hours*3600000};
}
export function stormForecastUrl(lat:number,lon:number,start:number,end:number):string {
 const hour=(n:number)=>new Date(n).toISOString().slice(0,16);
 const q=new URLSearchParams({latitude:String(lat),longitude:String(lon),hourly:'wind_gusts_10m,precipitation',timezone:'GMT',timeformat:'unixtime',wind_speed_unit:'kmh',precipitation_unit:'mm',start_hour:hour(start+3600000),end_hour:hour(end)});
 return 'https://api.open-meteo.com/v1/forecast?'+q;
}
export interface StormForecast {peakGust:number;precipitation:number;max24hPrecipitation:number;score:number;grid:{latitude:number;longitude:number}}
export function parseStormForecast(raw:string,start:number,end:number):StormForecast {
 const j=JSON.parse(raw);const times=j.hourly?.time,gusts=j.hourly?.wind_gusts_10m,rain=j.hourly?.precipitation;
 const n=(end-start)/3600000;
 if(!Number.isInteger(n)||n<1||n>240||j.utc_offset_seconds!==0||j.hourly_units?.time!=='unixtime'||j.hourly_units?.wind_gusts_10m!=='km/h'||j.hourly_units?.precipitation!=='mm'||!Number.isFinite(j.latitude)||!Number.isFinite(j.longitude)||Math.abs(j.latitude)>90||Math.abs(j.longitude)>180)throw new Error('invalid forecast metadata/window');
 if(![times,gusts,rain].every(a=>Array.isArray(a)&&a.length===n))throw new Error('incomplete forecast arrays');
 for(let i=0;i<n;i++){
  if(times[i]!==start/1000+(i+1)*3600||typeof gusts[i]!=='number'||!Number.isFinite(gusts[i])||gusts[i]<0||gusts[i]>500||typeof rain[i]!=='number'||!Number.isFinite(rain[i])||rain[i]<0||rain[i]>5000)throw new Error('invalid forecast interval/value');
 }
 const total=rain.reduce((s:number,v:number)=>s+v,0);if(total>5000)throw new Error('forecast precipitation outside contract range');
 let max24=0,rolling=0;for(let i=0;i<n;i++){rolling+=rain[i];if(i>=24)rolling-=rain[i-24];max24=Math.max(max24,rolling);}
 const peak=Math.max(...gusts);const score=peak>=120||max24>=100?1:peak>=90||max24>=50?.75:peak>=60||max24>=25?.5:0;
 return {peakGust:peak,precipitation:Number(total.toFixed(6)),max24hPrecipitation:Number(max24.toFixed(6)),score,grid:{latitude:j.latitude,longitude:j.longitude}};
}
export const FORECAST_DAILY_BUDGET=2000;
let cache=new PublicBodyCache(500,600000,()=>Date.now()),starts:number[]=[],backoffUntil=0;
export function resetStormForecastForTests():void{cache=new PublicBodyCache(500,600000,()=>Date.now());starts=[];backoffUntil=0;}
export function stormBudgetCountsForTests():{day:number;hour:number;minute:number}{const now=Date.now();return {day:starts.filter(t=>t>now-86400000).length,hour:starts.filter(t=>t>now-3600000).length,minute:starts.filter(t=>t>now-60000).length};}
function admitRead():boolean {
 const now=Date.now();starts=starts.filter(t=>t>now-86400000);
 // Check every window before recording the single actual read start.
 if(now<backoffUntil||starts.length>=FORECAST_DAILY_BUDGET||starts.filter(t=>t>now-3600000).length>=300||starts.filter(t=>t>now-60000).length>=30)return false;
 starts.push(now);return true;
}
export function stormCacheKey(url:string):string{const u=new URL(url);for(const k of ['latitude','longitude'])u.searchParams.set(k,Number(u.searchParams.get(k)).toFixed(2));return u.toString();}
export async function readStormForecast(url:string){
 try{return await cache.get(stormCacheKey(url),async()=>{
  if(!admitRead())throw new Error('forecast backoff or budget exhausted');
  let timer:ReturnType<typeof setTimeout>;
  try{return await Promise.race([readPublicBody(url,256000,4000),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('forecast deadline')),4100);})]).finally(()=>clearTimeout(timer!));}
  catch(e){if(e instanceof Error&&/public source returned HTTP (?:403|429)$/.test(e.message))backoffUntil=Date.now()+3600000;throw e;}
 });}catch{throw upstreamUnavailable('STORM_FORECAST_UNAVAILABLE','forecast unavailable, over budget or in temporary throttle backoff');}
}
