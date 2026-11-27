import {weatherSourceBody} from './noaaWeatherSources';
import {weatherIdentity,type PastWeatherQuery} from './weatherSources';
import type {DailyArchiveResult} from './weatherObservations';
import type {ObservationSource} from '../core/observedSources';
import coordinates from '../data/weatherArchiveCoordinates.json';
const GEOCODER='https://geocoding-api.open-meteo.com/v1/search';
export interface GeocodePick{name:string,country_code:string,admin1:string|null,latitude:number,longitude:number,population:number|null,feature_code:string,country?:string}
const fold=(v:string)=>v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
/** Folded common qualifier aliases: the geocoder's ISO country_code is GB for the United Kingdom and US for the
 * United States, so the everyday codes UK and USA match by alias. Only these two are aliased. */
const QUALIFIER_ALIASES:Record<string,string>={uk:'gb',usa:'us'};
/** "City, Country" qualifier match, accent and case folded: the qualifier must equal the result's country name,
 * its ISO country_code (common aliases UK->GB, USA->US accepted), or its admin1 region. Exported for tests. */
export function qualifierMatches(qualifier:string,r:{country?:unknown,country_code?:unknown,admin1?:unknown}):boolean{
 const f=fold(qualifier),aliased=QUALIFIER_ALIASES[f]??f;
 return (typeof r.country==='string'&&fold(r.country)===f)||(typeof r.country_code==='string'&&(fold(r.country_code)===f||fold(r.country_code)===aliased))||(typeof r.admin1==='string'&&fold(r.admin1)===f);
}
/** Unbound-location resolution. Exact (accent and case folded) name matches among populated places only; accepted when
 * unique, or when the most populous match has at least 10x the population of every other match. Anything else refuses.
 * When a qualifier is given (the part after the first comma in a "City, Country" location), exact matches are first
 * filtered to those whose country name, country_code or admin1 matches it; none matching refuses like any no-match. */
export function pickGeocode(query:string,raw:string,qualifier?:string):GeocodePick{
 const d=JSON.parse(raw),results:any[]=Array.isArray(d?.results)?d.results:[];
 let exact=results.filter(r=>r&&typeof r.name==='string'&&fold(r.name)===fold(query)&&typeof r.feature_code==='string'&&/^PPL/.test(r.feature_code)&&typeof r.country_code==='string'&&/^[A-Z]{2}$/.test(r.country_code)&&Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)&&Math.abs(r.latitude)<=90&&Math.abs(r.longitude)<=180);
 if(!exact.length)throw Error('geocoder found no exact populated place');
 if(qualifier!==undefined){
  exact=exact.filter(r=>qualifierMatches(qualifier,r));
  if(!exact.length)throw Error('geocoder qualifier matched no place');
 }
 const pop=(r:any)=>Number.isFinite(r.population)&&r.population>0?r.population:0;
 const sorted=[...exact].sort((a,b)=>pop(b)-pop(a)),top=sorted[0];
 if(sorted.length>1&&!(pop(top)>0&&pop(top)>=10*pop(sorted[1])))throw Error('geocoder match is ambiguous');
 return{name:top.name,country_code:top.country_code,admin1:typeof top.admin1==='string'?top.admin1:null,latitude:top.latitude,longitude:top.longitude,population:pop(top)>0?pop(top):null,feature_code:top.feature_code,...(qualifier!==undefined?{country:typeof top.country==='string'?top.country:null}:{})};
}
export const openMeteoArchive:ObservationSource<PastWeatherQuery,DailyArchiveResult>={
 name:'Open-Meteo ERA5 daily reanalysis archive',
 approval:{termsUrl:'https://open-meteo.com/en/terms',checkedAt:'2026-11-26',commercialUse:false,redistribution:false,ownerRiskAcceptance:{sourceReference:'owner-approved-source-policy',scope:'testnet-hackathon',acceptedAt:'2026-11-26'}},
 async read(q,signal){
  const binding=Object.entries(coordinates).find(([name])=>name.toLowerCase()===q.location.toLowerCase());
  let name:string,c:{latitude:number,longitude:number},geo:{url:string,raw:string,pick:GeocodePick,requested?:string,matchedCountry?:string}|undefined;
  if(binding){[name,c]=binding;}
  else{
   // "City, Country": geocode the city only (the geocoder returns nothing
   // for the whole comma string), then require the qualifier to match the
   // result's country name, country_code or admin1.
   const requested=q.location.trim();
   const comma=requested.indexOf(',');
   const city=comma<0?requested:requested.slice(0,comma).trim();
   const qualifier=comma<0?undefined:requested.slice(comma+1).trim()||undefined;
   const url=GEOCODER+'?'+new URLSearchParams({name:city,count:'10',language:'en',format:'json'});
   const raw=await weatherSourceBody(url,signal);
   const pick=pickGeocode(city,raw,qualifier);
   geo={url,raw,pick,...(qualifier!==undefined?{requested,matchedCountry:typeof pick.country==='string'?pick.country:pick.country_code}:{})};
   name=pick.name+', '+pick.country_code;c={latitude:pick.latitude,longitude:pick.longitude};
  }
  const url='https://archive-api.open-meteo.com/v1/archive?'+new URLSearchParams({latitude:String(c.latitude),longitude:String(c.longitude),start_date:q.date,end_date:q.date,daily:'temperature_2m_max,temperature_2m_min,precipitation_sum',timezone:'GMT',temperature_unit:'celsius',precipitation_unit:'mm',models:'era5'});
  const raw=await weatherSourceBody(url,signal),d=JSON.parse(raw),daily=d.daily;
  if(d.error||d.timezone!=='GMT'||d.utc_offset_seconds!==0||typeof d.latitude!=='number'||typeof d.longitude!=='number'||!Number.isFinite(d.latitude)||!Number.isFinite(d.longitude)||Math.abs(d.latitude-c.latitude)>.3||Math.abs(d.longitude-c.longitude)>.3||d.daily_units?.time!=='iso8601'||d.daily_units?.temperature_2m_max!=='°C'||d.daily_units?.temperature_2m_min!=='°C'||d.daily_units?.precipitation_sum!=='mm'||!Array.isArray(daily?.time)||daily.time.length!==1||daily.time[0]!==q.date)throw Error('archive identity or units mismatch');
  const values=['temperature_2m_max','temperature_2m_min','precipitation_sum'].map(k=>{if(!Array.isArray(daily[k])||daily[k].length!==1)throw Error('archive day shape');return daily[k][0];});
  const fetchedAt=new Date().toISOString();let value:DailyArchiveResult;
  if(values.every(v=>v===null))value={noRecord:true,station:'ERA5GRID000',date:q.date};
  else{if(values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('archive incomplete values');value={station:'ERA5GRID000',name:name+' ERA5 grid cell (not a station)',date:q.date,latitude:d.latitude,longitude:d.longitude,tempMaxC:values[0],tempMinC:values[1],precipitationMm:values[2],tracePrecipitation:false,attributes:{model:'ERA5',...(geo?{resolved_place:name}:{})},reportingPeriod:'UTC calendar day',method:'era5_reanalysis'};}
  return{identity:weatherIdentity(q),sourceUrl:url,rawBody:JSON.stringify({source_raw_body:raw,requested_coordinates:c,...(geo?{geocoder_url:geo.url,geocoder_raw_body:geo.raw,geocoder_pick:geo.pick,...(geo.requested!==undefined?{requested_location:geo.requested,matched_country:geo.matchedCountry??null}:{}),location_binding:geo.requested!==undefined?'unbound location resolved by Open-Meteo geocoding; exact-name populated place for the city part, qualifier matched against country name/country_code/admin1':'unbound location resolved by Open-Meteo geocoding; unique exact-name populated place only'}:{}),method:'ERA5 reanalysis, not a measured station record',source_docs:'https://open-meteo.com/en/docs/historical-weather-api'}),observedAt:fetchedAt,fetchedAt,value};
 }
};
