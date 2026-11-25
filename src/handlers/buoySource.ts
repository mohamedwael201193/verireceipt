import {boundedSourceText} from '../core/boundedSource';
import {badRequest} from '../core/errors';
import {observeFromSources,type ObservationSource,type SourceApproval} from '../core/observedSources';
import {parseBostonBuoySensor,NDBC_STATION_CACHE_MS,NDBC_MAX_OBSERVATION_AGE_MS,type BuoySensorObservation} from './buoySensor';
export interface BuoyQuery {sensor:string;metric:string}
const sourceUrl='https://www.ndbc.noaa.gov/data/realtime2/44013.txt';
const metadataUrl='https://www.ndbc.noaa.gov/station_page.php?station=44013';
interface Capture {raw:string;metadataHtml:string;fetchedAt:string;metadataFetchedAt:string}
function supported(q:BuoyQuery){return q.sensor==='NDBC:44013'&&['water_temperature','air_temperature'].includes(q.metric);}
/** Per-process station cache. Both success and failure consume an hourly attempt.
 * No background polling. Concurrent metrics share one exact pair of source bodies.
 * Multi-process deployments must provide a shared equivalent before scaling out. */
export function bostonBuoySource(approval:SourceApproval):ObservationSource<BuoyQuery,BuoySensorObservation>{
 let nextAttempt=0,cache:Capture|undefined,pending:Promise<Capture>|undefined;
 async function capture():Promise<Capture>{
  if(pending)return pending;
  if(Date.now()<nextAttempt){if(cache)return cache;throw Error('NDBC hourly attempt already consumed');}
  nextAttempt=Date.now()+NDBC_STATION_CACHE_MS;cache=undefined;
  pending=Promise.all([
   boundedSourceText(sourceUrl,{timeoutMs:2000,maxBytes:1000000}),
   boundedSourceText(metadataUrl,{timeoutMs:2000,maxBytes:250000}),
  ]).then(([table,metadata])=>{const value={raw:table.raw,metadataHtml:metadata.raw,fetchedAt:table.fetchedAt,metadataFetchedAt:metadata.fetchedAt};cache=value;return value;}).finally(()=>{pending=undefined;});
  return pending;
 }
 return {name:'NOAA NDBC Boston buoy measured temperatures, hourly station cache',approval,read:async(q,signal)=>{
  if(!supported(q)||signal.aborted)throw Error('unsupported or aborted buoy observation');
  const c=await capture();if(signal.aborted)throw Error('aborted buoy observation');
  const value=parseBostonBuoySensor({...q,...c,sourceUrl,metadataUrl,nowMs:Date.now()});
  return {identity:JSON.stringify([value.sensor,value.metric]),sourceUrl,rawBody:JSON.stringify({station_raw_body:c.raw,metadata_raw_body:c.metadataHtml,metadata_url:metadataUrl,metadata_fetched_at:c.metadataFetchedAt,cache_policy:'One station pair attempt per hour per process, including failures. Original source observation and fetch timestamps retained.'}),observedAt:value.observed_at,fetchedAt:c.fetchedAt,value};
 }};
}
/** Unwired factory: no default source approval or route. */
export function createBuoyObservationHandler(approval:SourceApproval){
 const source=bostonBuoySource(approval);
 return async(q:Record<string,string|undefined>)=>{
  const query={sensor:q.sensor??'',metric:q.metric??''};if(!supported(query))throw badRequest('INVALID_SENSOR_METRIC','Only NDBC:44013 water_temperature or air_temperature is supported');
  return observeFromSources(query,[source],{intent:'SENSOR_TELEMETRY_VERIFY_GENERAL',identity:q=>JSON.stringify([q.sensor,q.metric]),validate:v=>{if(v.sensor!==query.sensor||v.metric!==query.metric)throw Error('buoy identity drift');},fields:v=>({...v}),answer:v=>`${v.sensor} ${v.metric}: ${v.value} ${v.unit}. ${v.quality} ${v.scope}`,maxAgeMs:NDBC_MAX_OBSERVATION_AGE_MS,sourceTimeoutMs:2500,totalTimeoutMs:2500,stopAfterTimeout:true,scope:'Single NOAA NDBC Boston station measurement, hourly per-process cache. Not independent sensor authentication or arbitrary-device coverage. Automated realtime QC only, subject to revision.'});
 };
}
