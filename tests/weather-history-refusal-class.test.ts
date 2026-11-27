import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {recordRequestCompletion} from '../src/core/requestMetrics';
import {refusalParamClass,weatherLocationClass,REFUSAL_INTENTS} from '../src/core/refusalClass';
import {dateAgeBucket} from '../src/core/dateAgeBucket';
import {answerDiagnostics} from '../src/core/answerClass';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {createWiredWeatherHandlers} from '../src/handlers/weatherWired';
let lines:string[];
beforeEach(()=>{lines=[];vi.spyOn(console,'info').mockImplementation((m:unknown)=>{lines.push(String(m));});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const parsed=()=>lines.map(l=>JSON.parse(l));
const refusal=()=>parsed().filter(o=>o.event==='refusal_param_class');
const daysAgo=(n:number)=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);
it('weather-history route is registered for the refusal class line',()=>{expect(REFUSAL_INTENTS['/v1/weather-history']).toBe('WEATHER_FORECAST_VERIFY_GENERAL');});
it('location_class: bound, has_comma, unbound_ascii, unbound_nonascii',()=>{
 expect(weatherLocationClass('Cairo')).toBe('bound');
 expect(weatherLocationClass(' new york ')).toBe('bound');
 expect(weatherLocationClass('Cairo, Egypt')).toBe('has_comma');
 expect(weatherLocationClass('Atlantis')).toBe('unbound_ascii');
 expect(weatherLocationClass('القاهرة')).toBe('unbound_nonascii');
 expect(weatherLocationClass(undefined)).toBe('unbound_ascii');
});
it.each([
 [0,'<=7d'],[7,'<=7d'],[8,'8-30d'],[30,'8-30d'],[31,'>30d'],[400,'>30d'],
])('a date %i days ago falls in bucket %s',(n,b)=>{expect(dateAgeBucket(daysAgo(n))).toBe(b);});
it('date_age_bucket: future and invalid dates',()=>{
 expect(dateAgeBucket(daysAgo(-1))).toBe('future');
 expect(dateAgeBucket('yesterday')).toBe('invalid');
 expect(dateAgeBucket('2026-02-30')).toBe('invalid');
 expect(dateAgeBucket('')).toBe('invalid');
 expect(dateAgeBucket(undefined)).toBe('invalid');
});
it('a 502 APPROVED_SOURCES_UNAVAILABLE logs both fixed labels and no input text; the completion line keeps the code',()=>{
 const secret='Secret-Place-Zq31337';
 recordRequestCompletion('/v1/weather-history',502,5,{query:{location:secret,date:daysAgo(10)},errorCode:'APPROVED_SOURCES_UNAVAILABLE'});
 const r=refusal();expect(r).toHaveLength(1);
 expect(r[0]).toMatchObject({intent:'WEATHER_FORECAST_VERIFY_GENERAL',error_code:'APPROVED_SOURCES_UNAVAILABLE',status:'502',location_class:'unbound_ascii',date_age_bucket:'8-30d'});
 const all=lines.join('\n');for(const bad of ['Secret','Zq31337','31337'])expect(all).not.toContain(bad);
 expect(parsed().some(o=>o.error_code==='APPROVED_SOURCES_UNAVAILABLE'&&o.event!=='refusal_param_class')).toBe(true);
});
it('a bound location and an invalid date class the 502 the same way',()=>{
 recordRequestCompletion('/v1/weather-history',502,5,{query:{location:'London',date:'not-a-date'},errorCode:'APPROVED_SOURCES_UNAVAILABLE'});
 expect(refusal()[0]).toMatchObject({location_class:'bound',date_age_bucket:'invalid'});
 expect(lines.join('\n')).not.toContain('not-a-date');
});
it('a 200 weather-history answer logs no class line',()=>{
 recordRequestCompletion('/v1/weather-history',200,5,{query:{location:'Cairo',date:daysAgo(3)}});
 expect(refusal()).toHaveLength(0);
});
it('missing or inherited query values give the empty-input classes, never throw',()=>{
 expect(refusalParamClass('/v1/weather-history','X',undefined)).toEqual({location_class:'unbound_ascii',date_age_bucket:'invalid'});
 expect(refusalParamClass('/v1/weather-history','X',Object.create({location:'inherited secret'}))).toEqual({location_class:'unbound_ascii',date_age_bucket:'invalid'});
});
it('the 200 no-record answer_class carries the same date_age_bucket label',async()=>{
 vi.stubGlobal('fetch',async()=>new Response('[]'));
 const out=await createWiredWeatherHandlers({archiveFallback:false}).past({location:'London',date:daysAgo(20)});
 expect(out.data_status).toBe('no_record');
 expect(answerDiagnostics('WEATHER_FORECAST_VERIFY_GENERAL',out).answerClass).toMatchObject({weather_result:'no_record',date_age_bucket:'8-30d'});
});
