// Parser only. No network, cache, route, declaration or registration.
export const NDBC_STATION_CACHE_MS=3600000;
export const NDBC_MAX_OBSERVATION_AGE_MS=5400000;
export interface BuoySensorObservation {sensor:'NDBC:44013';metric:'water_temperature'|'air_temperature';value:number;unit:'degC';observed_at:string;station:string;quality:string;scope:string}
const columns='#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE';
const units='#yr mo dy hr mn degT m/s m/s m sec sec degT hPa degC degC degC nmi hPa ft';
function refuse():never{throw Error('unsupported or invalid NDBC station observation');}
function normalize(s:string){return s.trim().replace(/\s+/g,' ');}
function observationTime(row:string[]):number{
 if(row.slice(0,5).some((v,i)=>!(i===0?/^\d{4}$/:/^\d{2}$/).test(v)))refuse();
 const iso=`${row[0]}-${row[1]}-${row[2]}T${row[3]}:${row[4]}:00Z`,n=Date.parse(iso);
 if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,19)!==iso.slice(0,19))refuse();return n;
}
/** Caller must bind bytes to these exact independently fetched HTTPS sources.
 * Text table has no embedded station identity: metadata/URL binding is necessary,
 * not cryptographic authentication of the table's contents. */
export function parseBostonBuoySensor(input:{sensor:string;metric:string;sourceUrl:string;metadataUrl:string;raw:string;metadataHtml:string;nowMs:number}):BuoySensorObservation{
 const {sensor,metric,sourceUrl,metadataUrl,raw,metadataHtml,nowMs}=input;
 if(sensor!=='NDBC:44013'||!['water_temperature','air_temperature'].includes(metric)||sourceUrl!=='https://www.ndbc.noaa.gov/data/realtime2/44013.txt'||metadataUrl!=='https://www.ndbc.noaa.gov/station_page.php?station=44013')refuse();
 if(!Number.isFinite(nowMs)||Buffer.byteLength(raw)>1000000||Buffer.byteLength(metadataHtml)>250000)refuse();
 if(!metadataHtml.includes('<title>NDBC - Station 44013 Recent Data</title>')||!metadataHtml.includes('<link rel="canonical" href="https://www.ndbc.noaa.gov/station_page.php?station=44013">')||!metadataHtml.includes('BOSTON 16 NM East of Boston, MA')||!metadataHtml.includes('42.346 N 70.651 W')||!metadataHtml.includes('Owned and maintained by National Data Buoy Center'))refuse();
 const lines=raw.trim().split(/\r?\n/);if(lines.length<3||normalize(lines[0])!==columns||normalize(lines[1])!==units)refuse();
 const rows=lines.slice(2).filter(x=>x.trim()).map(x=>x.trim().split(/\s+/));
 if(!rows.length||rows.length>12000||rows.some(row=>row.length!==19))refuse();
 // Verify descending order, never choose an older row to repair a missing latest value.
 const times=rows.map(observationTime);if(times.some((t,i)=>i>0&&t>=times[i-1]))refuse();
 const time=times[0];if(time>nowMs||nowMs-time>NDBC_MAX_OBSERVATION_AGE_MS)refuse();
 const token=rows[0][metric==='water_temperature'?14:13];if(!/^-?\d+(?:\.\d+)?$/.test(token))refuse();
 const value=Number(token);if(!Number.isFinite(value)||value< -50||value>60)refuse();
 return {sensor:'NDBC:44013',metric:metric as BuoySensorObservation['metric'],value,unit:'degC',observed_at:new Date(time).toISOString(),station:'Boston buoy 44013, 42.346 N 70.651 W',quality:'NOAA NDBC realtime data: automated gross-error checks only, not final post-processed quality assurance; subject to revision.',scope:'Exact Boston buoy and reviewed temperature metrics only, not arbitrary sensor telemetry. Source table UTC observation time, not fetch time. Future adapter must cache each station fetch for at least one hour and refuse data older than 90 minutes; no older-row substitution for missing values.'};
}
