/** EPA 2024 PM breakpoints. Applying them to snapshots is an indicative
 * PM-only equivalent, never daily AQI or an EPA NowCast. No gas conversion. */
export const EPA_PM_SOURCE='https://aqs.epa.gov/aqsweb/documents/codetables/aqi%5Fbreakpoints.html';
const bands25=[[0,9,0,50],[9.1,35.4,51,100],[35.5,55.4,101,150],[55.5,125.4,151,200],[125.5,225.4,201,300],[225.5,325.4,301,500]];
const bands10=[[0,54,0,50],[55,154,51,100],[155,254,101,150],[255,354,151,200],[355,424,201,300],[425,604,301,500]];
export function aqiCategory(aqi:number):string{return aqi<=50?'Good':aqi<=100?'Moderate':aqi<=150?'Unhealthy for Sensitive Groups':aqi<=200?'Unhealthy':aqi<=300?'Very Unhealthy':'Hazardous';}
export function particulateIndex(value:number|null,kind:'pm2_5'|'pm10'):number|null{
 if(value===null||!Number.isFinite(value)||value<0)return null;
 const c=kind==='pm2_5'?Math.floor(value*10+1e-9)/10:Math.floor(value);
 const b=(kind==='pm2_5'?bands25:bands10).find(([lo,hi])=>c>=lo&&c<=hi);if(!b)return null;
 return Math.round((b[3]-b[2])/(b[1]-b[0])*(c-b[0])+b[2]);
}
export function particulateSummary(pm25:number|null,pm10:number|null){
 const p25=particulateIndex(pm25,'pm2_5'),p10=particulateIndex(pm10,'pm10');
 // Unknown/out-of-table pollutant cannot silently lose to the other pollutant.
 const complete=p25!==null&&p10!==null,index=complete?Math.max(p25,p10):null;
 return {pm2_5_index:p25,pm10_index:p10,indicative_pm_aqi:index,aqi_category:index===null?null:aqiCategory(index),dominant_pollutant:!complete?null:p25===p10?'pm2_5,pm10':p25>p10?'pm2_5':'pm10',dominant_pollutant_scope:'PM2.5 versus PM10 only; excludes gases; EPA 2024 breakpoint arithmetic on the supplied snapshot, not a 24-hour AQI or NowCast',breakpoint_source:EPA_PM_SOURCE};
}
