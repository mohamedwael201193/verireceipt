import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleWeatherForecast} from '../src/handlers/weatherForecast';
import {readForecastSource,resetForecastSourcesForTests} from '../src/handlers/forecastSourceCache';
const geo=readFileSync('tests/fixtures/weather-forecast/geocode-cairo.json','utf8');
const fc=readFileSync('tests/fixtures/weather-forecast/forecast-cairo.json','utf8');
afterEach(()=>{resetForecastSourcesForTests();vi.unstubAllGlobals();vi.restoreAllMocks();vi.clearAllMocks();vi.useRealTimers();});
function freeze(){vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));}
it('reuses exact validated geocode and forecast bytes with original forecast acquisition time',async()=>{
 freeze();const f=vi.fn(async(u:any)=>new Response(String(u).includes('geocoding-')?geo:fc));vi.stubGlobal('fetch',f);
 const a=await handleWeatherForecast({location:'Cairo'});await vi.advanceTimersByTimeAsync(299999);const b=await handleWeatherForecast({location:'Cairo'});expect(f).toHaveBeenCalledTimes(2);expect((b.receipt as any).fetched_at).toBe((a.receipt as any).fetched_at);
 await vi.advanceTimersByTimeAsync(1);await handleWeatherForecast({location:'Cairo'});expect(f).toHaveBeenCalledTimes(3);expect(f.mock.calls.filter(([u])=>String(u).includes('geocoding-'))).toHaveLength(1);
});
it.each([429,500,503])('HTTP%s retries only once after1second and never logs query or body',async(status)=>{
 freeze();const spy=vi.spyOn(console,'info').mockImplementation(()=>{});let n=0;const f=vi.fn(async()=>++n===1?new Response('PRIVATE BODY',{status}):new Response(fc));vi.stubGlobal('fetch',f);
 const p=readForecastSource('forecast','https://api.open-meteo.com/private?secret=PRIVATE');await vi.advanceTimersByTimeAsync(999);expect(n).toBe(1);await vi.advanceTimersByTimeAsync(1);expect((await p).body).toBe(fc);expect(n).toBe(2);const log=JSON.stringify(spy.mock.calls);expect(log).not.toContain('PRIVATE');expect(log).toContain(String(status));
});
it.each([400,404])('HTTP%s never retries',async(status)=>{freeze();const f=vi.fn(async()=>new Response('bad',{status}));vi.stubGlobal('fetch',f);await expect(readForecastSource('forecast','https://api.open-meteo.com/no')).rejects.toThrow();expect(f).toHaveBeenCalledTimes(1);});
it('malformed successful forecast is not cached, and no receipt is saved',async()=>{
 freeze();const f=vi.fn(async()=>new Response('not json'));vi.stubGlobal('fetch',f);for(let i=0;i<2;i++)await expect(handleWeatherForecast({location:'30,31'})).rejects.toMatchObject({code:'FORECAST_MALFORMED'});expect(f).toHaveBeenCalledTimes(2);expect(saveReceipt).not.toHaveBeenCalled();
});
it('expired forecast unavailable refuses rather than serving stale as fresh',async()=>{
 freeze();let fail=false;vi.stubGlobal('fetch',async()=>new Response(fail?'bad':fc,{status:fail?503:200}));await handleWeatherForecast({location:'30,31'});await vi.advanceTimersByTimeAsync(300000);fail=true;const p=expect(handleWeatherForecast({location:'30,31'})).rejects.toMatchObject({status:502});await vi.advanceTimersByTimeAsync(1000);await p;expect(saveReceipt).toHaveBeenCalledTimes(1);
});
it('abort-ignoring source retains single flight through deadline and late body never caches',async()=>{
 freeze();let resolve!:(s:string)=>void;const f=vi.fn(async()=>({ok:true,text:()=>new Promise<string>(r=>resolve=r)}));vi.stubGlobal('fetch',f);const u='https://api.open-meteo.com/stalled';const a=readForecastSource('forecast',u).catch(e=>e),b=readForecastSource('forecast',u).catch(e=>e);await vi.advanceTimersByTimeAsync(31000);expect(await a).toBeInstanceOf(Error);expect(await b).toBeInstanceOf(Error);expect(f).toHaveBeenCalledTimes(1);resolve(fc);await vi.advanceTimersByTimeAsync(1);f.mockImplementation(async()=>new Response(fc) as any);expect((await readForecastSource('forecast',u)).body).toBe(fc);expect(f).toHaveBeenCalledTimes(2);
});
it('body completing after15second abort but before outer deadline is refused',async()=>{
 freeze();vi.stubGlobal('fetch',async()=>({ok:true,text:async()=>{await new Promise(r=>setTimeout(r,16000));return fc;}}));const p=readForecastSource('forecast','https://api.open-meteo.com/late').catch(e=>e);await vi.advanceTimersByTimeAsync(16000);expect(await p).toBeInstanceOf(Error);
});
