import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {load} from 'js-yaml';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {createWiredWeatherHandlers} from '../src/handlers/weatherWired';
import {FIELD_FORMAT,OUTPUT_MAPPING,readPath,valueMatchesFormat,reconcileShaped} from '../src/core/shapedFields';
const intent='WEATHER_FORECAST_VERIFY_GENERAL';
const fixture=(file:string)=>JSON.parse(readFileSync(resolve('tests/fixtures/weather-history',file),'utf8'));
const capture=fixture('source-capture.json');
const contract=fixture('official-format.json');
const yaml=load(readFileSync(resolve('miner.yaml'),'utf8')) as any;
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it('declares the measured route with canonical location and date inputs and exact output units',()=>{
 const mapping=yaml.intent_mapping[intent];expect(mapping.endpoint).toBe('/v1/weather-history');
 expect(mapping.input).toEqual({location:{from:'location'},date:{from:'date'}});
 const endpoint=yaml.endpoints.find((e:any)=>e.path===mapping.endpoint);
 expect(endpoint.params.query.required.map((p:any)=>p.name)).toEqual(contract.request.params.map((p:any)=>p.name));
 expect(endpoint.params.query.required.every((p:any)=>p.intents.includes(intent))).toBe(true);
 for(const field of contract.response.fields){
  expect(mapping.output[field.name]).toEqual({path:field.name,...(field.unit?{unit:field.unit}:{})});
  expect(FIELD_FORMAT[intent][field.name].type).toBe(field.type);
 }
 expect(Object.keys(mapping.output)).toEqual(contract.response.fields.map((f:any)=>f.name));
 expect(endpoint.description).toContain('Missing or quality-failed days are refused');
});
it('a real archive capture supplies every mapped official field without inventing condition',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(capture.fetched_at));
 const row=capture.rows.find((r:any)=>r.location==='New York JFK');
 vi.stubGlobal('fetch',async(url:unknown)=>{expect(String(url)).toBe(row.url);return new Response(row.raw);});
 const out=await createWiredWeatherHandlers().past({location:'New York JFK',date:'2026-11-01'});
 for(const [field,mapping] of Object.entries(OUTPUT_MAPPING[intent])){
  const value=readPath(out,mapping.path);expect(valueMatchesFormat(value,FIELD_FORMAT[intent][field],field),field).toBe(true);
 }
 expect(out.temp_max_c).toBe(14.4);expect(out.temp_min_c).toBe(5.6);expect(out.precipitation_mm).toBe(0);
 expect(out.condition).toContain('not reported');expect(saveReceipt).toHaveBeenCalledTimes(1);
 const result=reconcileShaped({intent,result:{},field_status:{date:'unavailable',temp_max_c:'unavailable'}},out,{rawVerified:true});
 expect(result.date.value).toBe('2026-11-01');expect(result.temp_max_c.value).toBeNull();
});
it.each(['2026-11-01','2024-02-29'])('date field accepts canonical real date %s',date=>{
 expect(valueMatchesFormat(date,FIELD_FORMAT[intent].date)).toBe(true);
});
it.each(['2026-02-29','2026-11-31','2026-11-01T00:00:00Z','2026-1-1','',null,1])('date field refuses invalid date %s',date=>{
 expect(valueMatchesFormat(date,FIELD_FORMAT[intent].date)).toBe(false);
});
it('unsupported locations and missing dates remain refusals before any external request',async()=>{
 const fetch=vi.fn(async()=>new Response('{"results":[]}'));vi.stubGlobal('fetch',fetch);const h=createWiredWeatherHandlers();
 await expect(h.past({location:'Unbound place',date:'2026-11-01'})).rejects.toMatchObject({code:'APPROVED_SOURCES_UNAVAILABLE'});
 expect(fetch.mock.calls.map(c=>String(c[0]).split('?')[0])).toEqual(['https://geocoding-api.open-meteo.com/v1/search']);
 fetch.mockClear();
 await expect(h.past({location:'New York JFK'})).rejects.toMatchObject({status:400});
 expect(fetch).not.toHaveBeenCalled();expect(saveReceipt).not.toHaveBeenCalled();
});
