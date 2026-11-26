import {weatherSourceBody} from './noaaWeatherSources';
import {weatherIdentity,type PastWeatherQuery} from './weatherSources';
import type {DailyArchiveResult} from './weatherObservations';
import type {ObservationSource} from '../core/observedSources';
import coordinates from '../data/weatherArchiveCoordinates.json';
const GEOCODER='https://geocoding-api.open-meteo.com/v1/search';
export interface GeocodePick{name:string,country_code:string,admin1:string|null,latitude:number,longitude:number,population:number|null,feature_code:string}
const fold=(v:string)=>v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
/** Unbound-location resolution. Exact (accent and case folded) name matches among populated places only; accepted when
 * unique, or when the most populous match has at least 10x the population of every other match. Anything else refuses. */
export function pickGeocode(query:string,raw:string):GeocodePick{
 const d=JSON.parse(raw),results:any[]=Array.isArray(d?.results)?d.results:[];
 const exact=results.filter(r=>r&&typeof r.name==='string'&&fold(r.name)===fold(query)&&typeof r.feature_code==='string'&&/^PPL/.test(r.feature_code)&&typeof r.country_code==='string'&&/^[A-Z]{2}$/.test(r.country_code)&&Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)&&Math.abs(r.latitude)<=90&&Math.abs(r.longitude)<=180);
 if(!exact.length)throw Error('geocoder found no exact populated place');
 const pop=(r:any)=>Number.isFinite(r.population)&&r.population>0?r.population:0;
 const sorted=[...exact].sort((a,b)=>pop(b)-pop(a)),top=sorted[0];
 if(sorted.length>1&&!(pop(top)>0&&pop(top)>=10*pop(sorted[1])))throw Error('geocoder match is ambiguous');
 return{name:top.name,country_code:top.country_code,admin1:typeof top.admin1==='string'?top.admin1:null,latitude:top.latitude,longitude:top.longitude,population:pop(top)>0?pop(top):null,feature_code:top.feature_code};
}
export const openMeteoArchive:ObservationSource<PastWeatherQuery,DailyArchiveResult>={
 name:'Open-Meteo ERA5 daily reanalysis archive',
 approval:{termsUrl:'https://open-meteo.com/en/terms',checkedAt:'2026-11-26',commercialUse:false,redistribution:false,ownerRiskAcceptance:{sourceReference:'owner-approved-source-policy',scope:'testnet-hackathon',acceptedAt:'2026-11-26'}},
 async read(q,signal){
  const binding=Object.entries(coordinates).find(([name])=>name.toLowerCase()===q.location.toLowerCase());
  let name:string,c:{latitude:number,longitude:number},geo:{url:string,raw:string,pick:GeocodePick}|undefined;
  if(binding){[name,c]=binding;}
  else{const url=GEOCODER+'?'+new URLSearchParams({name:q.location.trim(),count:'10',language:'en',format:'json'});const raw=await weatherSourceBody(url,signal);const pick=pickGeocode(q.location,raw);geo={url,raw,pick};name=pick.name+', '+pick.country_code;c={latitude:pick.latitude,longitude:pick.longitude};}
  const url='https://archive-api.open-meteo.com/v1/archive?'+new URLSearchParams({latitude:String(c.latitude),longitude:String(c.longitude),start_date:q.date,end_date:q.date,daily:'temperature_2m_max,temperature_2m_min,precipitation_sum',timezone:'GMT',temperature_unit:'celsius',precipitation_unit:'mm',models:'era5'});
  const raw=await weatherSourceBody(url,signal),d=JSON.parse(raw),daily=d.daily;
  if(d.error||d.timezone!=='GMT'||d.utc_offset_seconds!==0||typeof d.latitude!=='number'||typeof d.longitude!=='number'||!Number.isFinite(d.latitude)||!Number.isFinite(d.longitude)||Math.abs(d.latitude-c.latitude)>.3||Math.abs(d.longitude-c.longitude)>.3||d.daily_units?.time!=='iso8601'||d.daily_units?.temperature_2m_max!=='°C'||d.daily_units?.temperature_2m_min!=='°C'||d.daily_units?.precipitation_sum!=='mm'||!Array.isArray(daily?.time)||daily.time.length!==1||daily.time[0]!==q.date)throw Error('archive identity or units mismatch');
  const values=['temperature_2m_max','temperature_2m_min','precipitation_sum'].map(k=>{if(!Array.isArray(daily[k])||daily[k].length!==1)throw Error('archive day shape');return daily[k][0];});
  const fetchedAt=new Date().toISOString();let value:DailyArchiveResult;
  if(values.every(v=>v===null))value={noRecord:true,station:'ERA5GRID000',date:q.date};
  else{if(values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('archive incomplete values');value={station:'ERA5GRID000',name:name+' ERA5 grid cell (not a station)',date:q.date,latitude:d.latitude,longitude:d.longitude,tempMaxC:values[0],tempMinC:values[1],precipitationMm:values[2],tracePrecipitation:false,attributes:{model:'ERA5',...(geo?{resolved_place:name}:{})},reportingPeriod:'UTC calendar day',method:'era5_reanalysis'};}
  return{identity:weatherIdentity(q),sourceUrl:url,rawBody:JSON.stringify({source_raw_body:raw,requested_coordinates:c,...(geo?{geocoder_url:geo.url,geocoder_raw_body:geo.raw,geocoder_pick:geo.pick,location_binding:'unbound location resolved by Open-Meteo geocoding; unique exact-name populated place only'}:{}),method:'ERA5 reanalysis, not a measured station record',source_docs:'https://open-meteo.com/en/docs/historical-weather-api'}),observedAt:fetchedAt,fetchedAt,value};
 }
};
