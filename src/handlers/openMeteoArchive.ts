import {weatherSourceBody} from './noaaWeatherSources';
import {weatherIdentity,type PastWeatherQuery} from './weatherSources';
import type {DailyArchiveResult} from './weatherObservations';
import type {ObservationSource} from '../core/observedSources';
import coordinates from '../data/weatherArchiveCoordinates.json';
export const openMeteoArchive:ObservationSource<PastWeatherQuery,DailyArchiveResult>={
 name:'Open-Meteo ERA5 daily reanalysis archive',
 approval:{termsUrl:'https://open-meteo.com/en/terms',checkedAt:'2026-11-26',commercialUse:false,redistribution:false,ownerRiskAcceptance:{sourceReference:'owner-approved-source-policy',scope:'testnet-hackathon',acceptedAt:'2026-11-26'}},
 async read(q,signal){
  const binding=Object.entries(coordinates).find(([name])=>name.toLowerCase()===q.location.toLowerCase());if(!binding)throw Error('no reviewed archive coordinate binding');const [name,c]=binding;
  const url='https://archive-api.open-meteo.com/v1/archive?'+new URLSearchParams({latitude:String(c.latitude),longitude:String(c.longitude),start_date:q.date,end_date:q.date,daily:'temperature_2m_max,temperature_2m_min,precipitation_sum',timezone:'GMT',temperature_unit:'celsius',precipitation_unit:'mm',models:'era5'});
  const raw=await weatherSourceBody(url,signal),d=JSON.parse(raw),daily=d.daily;
  if(d.error||d.timezone!=='GMT'||d.utc_offset_seconds!==0||typeof d.latitude!=='number'||typeof d.longitude!=='number'||!Number.isFinite(d.latitude)||!Number.isFinite(d.longitude)||Math.abs(d.latitude-c.latitude)>.3||Math.abs(d.longitude-c.longitude)>.3||d.daily_units?.time!=='iso8601'||d.daily_units?.temperature_2m_max!=='°C'||d.daily_units?.temperature_2m_min!=='°C'||d.daily_units?.precipitation_sum!=='mm'||!Array.isArray(daily?.time)||daily.time.length!==1||daily.time[0]!==q.date)throw Error('archive identity or units mismatch');
  const values=['temperature_2m_max','temperature_2m_min','precipitation_sum'].map(k=>{if(!Array.isArray(daily[k])||daily[k].length!==1)throw Error('archive day shape');return daily[k][0];});
  const fetchedAt=new Date().toISOString();let value:DailyArchiveResult;
  if(values.every(v=>v===null))value={noRecord:true,station:'ERA5GRID000',date:q.date};
  else{if(values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('archive incomplete values');value={station:'ERA5GRID000',name:name+' ERA5 grid cell (not a station)',date:q.date,latitude:d.latitude,longitude:d.longitude,tempMaxC:values[0],tempMinC:values[1],precipitationMm:values[2],tracePrecipitation:false,attributes:{model:'ERA5'},reportingPeriod:'UTC calendar day',method:'era5_reanalysis'};}
  return{identity:weatherIdentity(q),sourceUrl:url,rawBody:JSON.stringify({source_raw_body:raw,requested_coordinates:c,method:'ERA5 reanalysis, not a measured station record',source_docs:'https://open-meteo.com/en/docs/historical-weather-api'}),observedAt:fetchedAt,fetchedAt,value};
 }
};
