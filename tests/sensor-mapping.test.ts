import {afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {load} from 'js-yaml';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{}),storageBackend:()=> 'postgres'}));
import {buildServer} from '../src/server';
import {OUTPUT_MAPPING,FIELD_FORMAT,valueMatchesFormat,readPath,reconcileShaped} from '../src/core/shapedFields';
const intent='SENSOR_TELEMETRY_VERIFY_GENERAL',yaml=load(readFileSync('miner.yaml','utf8')) as any;
const raw=readFileSync('tests/fixtures/ndbc/44013-20261125.txt','utf8'),meta=readFileSync('tests/fixtures/ndbc/44013-metadata.html','utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it('declares exact canonical inputs and literal schema unit with narrow station scope',()=>{
 const m=yaml.intent_mapping[intent];expect(m.endpoint).toBe('/v1/sensor-telemetry');expect(m.input).toEqual({sensor:{from:'sensor'},metric:{from:'metric'}});expect(m.output).toEqual({sensor:{path:'sensor'},metric:{path:'metric'},value:{path:'value',unit:"the sensor's unit"},unit:{path:'unit'},observed_at:{path:'observed_at'}});
 const e=yaml.endpoints.find((e:any)=>e.path===m.endpoint);expect(e.params.query.required.map((p:any)=>p.name)).toEqual(['sensor','metric']);for(const phrase of['NDBC:44013','water_temperature or air_temperature','at most hourly per process','90 minutes','Missing latest MM','Automated gross-error QC only'])expect(e.description).toContain(phrase);
});
it('actual buoy values through route satisfy mirror with Celsius unit disclosed and no numeric raw backfill',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-25T01:55:00Z'));const f=vi.fn(async(url:string)=>new Response(url.includes('station_page')?meta:raw));vi.stubGlobal('fetch',f);const app=buildServer();
 try{for(const [metric,expected]of [['water_temperature',11.4],['air_temperature',5.5]]as const){const response=await app.inject({method:'GET',url:'/v1/sensor-telemetry?sensor=NDBC:44013&metric='+metric});expect(response.statusCode).toBe(200);const out=response.json();expect(out.value).toBe(expected);expect(out.unit).toBe('degC');expect(out.observed_at).toBe('2026-11-25T01:00:00.000Z');for(const[field,m]of Object.entries(OUTPUT_MAPPING[intent]))expect(valueMatchesFormat(readPath(out,m.path),FIELD_FORMAT[intent][field],field)).toBe(true);const shaped=reconcileShaped({intent,result:{},field_status:{value:'unavailable'}},out,{rawVerified:true});expect(shaped.value.value).toBeNull();}expect(f).toHaveBeenCalledTimes(2);
 }finally{await app.close();}
});
