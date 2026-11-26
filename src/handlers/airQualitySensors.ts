import {PublicBodyCache,StartBudget,readPublicBody,publicSourceFailure} from '../core/publicSource';
import {sha256Hex} from '../core/receipt';
import {particulateSummary} from './airQualityParticulate';
let cache=new PublicBodyCache(64,60000,()=>Date.now()),budget=new StartBudget(20,60000,()=>Date.now()),active=0,cooldown=0;
export function resetAirSensorsForTests(){cache=new PublicBodyCache(64,60000,()=>Date.now());budget=new StartBudget(20,60000,()=>Date.now());active=0;cooldown=0;}
const RADIUS_KM=10,MAX_AGE_MS=20*60000;
const attribution='Sensor.Community contributor-run sensors; Database Contents License (DbCL) 1.0; https://sensor.community/ ; not regulatory reference monitors';
export function sensorDistance(lat:number,lon:number,a:number,b:number){const r=Math.PI/180,x=Math.sin((a-lat)*r/2)**2+Math.cos(lat*r)*Math.cos(a*r)*Math.sin((b-lon)*r/2)**2;return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));}
export function parseAirSensors(raw:string,lat:number,lon:number,now:number){
 const rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.length>2000)throw Error('invalid sensor array');
 const bySensor=new Map<number,{sensor_id:number;sensor_type:string;latitude:number;longitude:number;distance_km:number;observed_at:string;pm2_5_ugm3:number;pm10_ugm3:number}>();
 for(const row of rows){
  const type=row?.sensor?.sensor_type?.name,id=row?.sensor?.id,loc=row?.location;
  if(!['SDS011','PMS1003','PMS3003','PMS5003','PMS6003','PMS7003'].includes(type)||!Number.isSafeInteger(id)||id<=0||loc?.indoor!==0)continue;
  const numeric=(v:unknown)=>typeof v==='string'&&/^-?\d+(?:\.\d+)?$/.test(v)?Number(v):NaN;
  const a=numeric(loc.latitude),b=numeric(loc.longitude);if(!Number.isFinite(a)||Math.abs(a)>90||!Number.isFinite(b)||Math.abs(b)>180)continue;
  const distance=sensorDistance(lat,lon,a,b);if(distance>RADIUS_KM)continue;
  const t=row.timestamp;if(typeof t!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t))continue;
  const iso=t.replace(' ','T')+'Z',stamp=Date.parse(iso);if(!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,19)!==iso.slice(0,19)||now-stamp>MAX_AGE_MS||stamp-now>120000)continue;
  if(!Array.isArray(row.sensordatavalues))continue;
  const values=(keys:string[])=>row.sensordatavalues.filter((v:any)=>keys.includes(v?.value_type));
  const p25=values(['P2','SDS_P2']),p10=values(['P1','SDS_P1']);if(p25.length!==1||p10.length!==1)continue;
  const pm25=numeric(p25[0].value),pm10=numeric(p10[0].value);if(!Number.isFinite(pm25)||pm25<0||pm25>10000||!Number.isFinite(pm10)||pm10<0||pm10>10000)continue;
  const old=bySensor.get(id);if(old&&Date.parse(old.observed_at)>=stamp)continue;
  bySensor.set(id,{sensor_id:id,sensor_type:type,latitude:a,longitude:b,distance_km:distance,observed_at:iso,pm2_5_ugm3:pm25,pm10_ugm3:pm10});
 }
 const eligible=[...bySensor.values()].sort((a,b)=>a.distance_km-b.distance_km||a.sensor_id-b.sensor_id),nearest=eligible[0];
 return {observed:nearest?{...nearest,...particulateSummary(nearest.pm2_5_ugm3,nearest.pm10_ugm3),eligible_sensor_count:eligible.length,selection:'nearest eligible outdoor PM sensor within 10km, latest reading per sensor; no spatial averaging',reading_scope:'Recent contributor sensor snapshot; uncalibrated citizen sensor, not regulatory data, not EPA daily AQI, not EPA NowCast',attribution}:null,eligible_sensor_count:eligible.length};
}
export function sensorBox(lat:number,lon:number):string|null{
 const d=RADIUS_KM/6371*180/Math.PI,min=Math.max(-90,lat-d),max=Math.min(90,lat+d);
 const width=Math.abs(lat)+d>=90?180:Math.asin(Math.min(1,Math.sin(d*Math.PI/180)/Math.cos(lat*Math.PI/180)))*180/Math.PI;
 // Do not request an enormous or wrapped box. Sparse polar/dateline coverage stays null.
 if(width>5||lon-width < -180||lon+width>180)return null;
 return [min,lon-width,max,lon+width].map(n=>n.toFixed(6)).join(',');
}
export async function readAirSensors(lat:number,lon:number){
 const box=sensorBox(lat,lon);
 const url=box?`https://data.sensor.community/airrohr/v1/filter/box=${box}`:null;
 let rawHash:string|null=null,fetchedAt:string|null=null;
 try{
  if(!url)throw Error("bounded box unavailable");
  const got=await cache.get(url,async()=>{if(Date.now()<cooldown||active>=3||!budget.take())throw Error('sensor capacity');active++;let timer:ReturnType<typeof setTimeout>;
   const io=readPublicBody(url,500000,2500,'VeriReceipt/2.0 air-quality observer (+https://verireceipt.vercel.app)').then(body=>{const parsed=parseAirSensors(body.raw,lat,lon,Date.now());return {...body,raw:JSON.stringify({...parsed,raw_body_sha256:sha256Hex(body.raw),evidence_transformation:'Only nearest eligible sensor fields plus unique eligible count retained; all other source rows discarded before cache/storage'})};}).catch(e=>{if(['http_403','http_429'].includes(publicSourceFailure(e)))cooldown=Date.now()+300000;throw e;}).finally(()=>active--);
   try{return await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('sensor deadline')),2600);})]);}finally{clearTimeout(timer!);}
  });fetchedAt=got.fetchedAt;
  const finalNow=Date.now();if(finalNow-Date.parse(fetchedAt)<0||finalNow-Date.parse(fetchedAt)>=60000)throw Error('sensor cache expired');
  const parsed=JSON.parse(got.raw);rawHash=parsed.raw_body_sha256;
  if(parsed.observed&&(finalNow-Date.parse(parsed.observed.observed_at)>MAX_AGE_MS||Date.parse(parsed.observed.observed_at)-finalNow>120000)){parsed.observed=null;parsed.eligible_sensor_count=0;}
  return {...parsed,evidence_transformation:parsed.evidence_transformation,status:parsed.observed?'observed':'no_eligible_sensor',source_url:url,raw_body_sha256:rawHash,fetched_at:fetchedAt,search_radius_km:RADIUS_KM,max_age_seconds:MAX_AGE_MS/1000,cache_max_age_seconds:60,attribution};
 }catch{return {observed:null,eligible_sensor_count:0,status:'unavailable_or_invalid',source_url:url,raw_body_sha256:rawHash,fetched_at:fetchedAt,search_radius_km:RADIUS_KM,max_age_seconds:MAX_AGE_MS/1000,cache_max_age_seconds:60,attribution};}
}
