import {afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
const dir=mkdtempSync('/tmp/storm-forecast-');process.env.SQLITE_PATH=join(dir,'db.sqlite');
import {parseStormForecast,forecastWindow,stormForecastUrl,readStormForecast,resetStormForecastForTests,stormBudgetCountsForTests} from '../src/handlers/stormForecast';
import {handleStormAlert} from '../src/handlers/stormAlert';
import {getReceiptEvidence} from '../src/core/storage';import {sha256Hex} from '../src/core/receipt';
const raw=readFileSync(join(__dirname,'fixtures/storm-forecast/cairo.json'),'utf8');
const meta=JSON.parse(readFileSync(join(__dirname,'fixtures/storm-forecast/provenance.json'),'utf8'));
const start=Date.parse(meta.assessed_start),end=Date.parse(meta.assessed_end);
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();resetStormForecastForTests();});afterAll(()=>rmSync(dir,{recursive:true,force:true}));
const body=()=>JSON.parse(raw);
function control(gust:number,rain:number,n=24){const j=body();j.hourly={time:Array.from({length:n},(_,i)=>start/1000+(i+1)*3600),wind_gusts_10m:Array(n).fill(gust),precipitation:Array(n).fill(rain)};return JSON.stringify(j);}
describe('storm complete aligned forecast window',()=>{
 it('replays actual Cairo body with original hash and exact future window',()=>{
  expect(sha256Hex(Buffer.from(raw))).toBe(meta.sha256);const f=parseStormForecast(raw,start,end);expect(f.peakGust).toBe(22.3);expect(f.precipitation).toBe(0);expect(f.score).toBe(0);expect(stormForecastUrl(30.0444,31.2357,start,end)).toBe(meta.url);
 });
 it('rounds forward, never includes preceding current-hour rain',()=>{
  expect(forecastWindow(start-1,24)).toEqual({start,end});expect(forecastWindow(start,24)).toEqual({start,end});expect(forecastWindow(start+1,1)).toEqual({start:start+3600000,end:start+7200000});
 });
 it.each([[59.9,0,0],[60,0,.5],[90,0,.75],[120,0,1],[0,25/24,.5],[0,50/24,.75],[0,100/24,1]])('threshold control gust %s rain/h %s score %s',(g,r,score)=>expect(parseStormForecast(control(g,r),start,end).score).toBe(score));
 it('ten-day accumulation is not mistaken for one severe day',()=>{const f=parseStormForecast(control(0,1,240),start,start+240*3600000);expect(f.precipitation).toBe(240);expect(f.max24hPrecipitation).toBe(24);expect(f.score).toBe(0);});
 it.each(['missing','null','negative','units','rain-units','time-gap','duplicate','extra','nan','range'])('refuses %s malformed control',kind=>{
  const j=body();if(kind==='missing')j.hourly.precipitation.pop();if(kind==='null')j.hourly.precipitation[0]=null;if(kind==='negative')j.hourly.wind_gusts_10m[0]=-1;if(kind==='units')j.hourly_units.wind_gusts_10m='m/s';if(kind==='rain-units')j.hourly_units.precipitation='inch';if(kind==='time-gap')j.hourly.time[1]+=3600;if(kind==='duplicate')j.hourly.time[1]=j.hourly.time[0];if(kind==='extra')j.hourly.time.push(end/1000+3600);if(kind==='nan')j.hourly.precipitation[0]='NaN';if(kind==='range')j.hourly.wind_gusts_10m[0]=501;
  expect(()=>parseStormForecast(JSON.stringify(j),start,end)).toThrow();
 });
 it('global forecast-only answer preserves exact bytes, model grid, window and warning caveat',async()=>{
  vi.useFakeTimers();vi.setSystemTime(start);vi.stubGlobal('fetch',async(u:unknown)=>String(u).includes('api.open-meteo.com')?new Response(raw):new Response('{}',{status:404}));
  const out=await handleStormAlert({location:'30.0444,31.2357'});expect(out.peak_gust_kmh).toBe(22.3);expect(out.precipitation_mm).toBe(0);expect(out.nws_status).toBe('outside NWS grid');expect(out.answer).toContain('does not confirm absence of official warnings');expect(out.answer).toContain('VeriReceipt heuristic');expect(out.window).toBe(new Date(start).toISOString()+'/'+new Date(end).toISOString());
  const receipt=out.receipt as any,stored=await getReceiptEvidence(receipt.receipt_id),ev=JSON.parse(stored.evidence!.toString());expect(ev.raw_bodies.forecast).toBe(raw);expect(ev.forecast.grid.latitude).toBe(body().latitude);expect(sha256Hex(stored.evidence!)).toBe(receipt.raw_response_sha256);
 });
 it('optional hanging NWS cannot delay forecast result indefinitely',async()=>{
  vi.useFakeTimers();vi.setSystemTime(start);vi.stubGlobal('fetch',async(u:unknown)=>String(u).includes('api.open-meteo.com')?new Response(raw):new Promise<Response>(()=>{}));
  const pending=handleStormAlert({location:'30.0444,31.2357'});await vi.advanceTimersByTimeAsync(4100);expect((await pending).nws_status).toBe('unavailable');
 });
 it('same-URL cache preserves original acquisition time and raw bytes',async()=>{
  vi.useFakeTimers();vi.setSystemTime(start);const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);const a=await readStormForecast(meta.url);await vi.advanceTimersByTimeAsync(1000);const b=await readStormForecast(meta.url);expect(b).toEqual(a);expect(f).toHaveBeenCalledTimes(1);
 });
 it('forecast failure with unavailable NWS refuses',async()=>{vi.stubGlobal('fetch',async(u:unknown)=>String(u).includes('api.open-meteo.com')?new Response('',{status:503}):new Response('{}',{status:404}));await expect(handleStormAlert({location:'30,31'})).rejects.toMatchObject({status:502,code:'STORM_FORECAST_UNAVAILABLE'});});
 it('backs off after throttling and resumes after one hour',async()=>{vi.useFakeTimers();const f=vi.fn(async()=>new Response('',{status:429}));vi.stubGlobal('fetch',f);await expect(readStormForecast(meta.url)).rejects.toThrow();await expect(readStormForecast(meta.url)).rejects.toThrow();expect(f).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(3600000);f.mockImplementation(async()=>new Response(raw));expect((await readStormForecast(meta.url)).raw).toBe(raw);expect(f).toHaveBeenCalledTimes(2);});
});

it('503 fails one request but does not halt future reads',async()=>{const f=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(new Response(raw));vi.stubGlobal('fetch',f);await expect(readStormForecast(meta.url)).rejects.toThrow();expect((await readStormForecast(meta.url)).raw).toBe(raw);});
it('nearby requests coalesce into quantized cache cell with original URL',async()=>{const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);const a=await readStormForecast(meta.url);const u=new URL(meta.url);u.searchParams.set('latitude','30.04445');const b=await readStormForecast(u.toString());expect(b).toEqual(a);expect(b.url).toBe(meta.url);expect(f).toHaveBeenCalledTimes(1);});
it('US NWS-only fallback preserves previous severity when forecast 503',async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T01:00:00Z'));const alerts=readFileSync(join(__dirname,'fixtures/storm-alert/nws-active-corpus-christi.json'),'utf8');vi.stubGlobal('fetch',async(u:unknown)=>String(u).includes('api.open-meteo.com')?new Response('',{status:503}):new Response(String(u).includes('/points/')?'{}':alerts));const r=await handleStormAlert({location:'27,-97'});expect(r.risk_score).toBe(.75);expect(r.peak_gust_kmh).toBeNull();expect(r.forecast_status).toBe('unavailable');expect(r.answer).toContain('NWS-only');});

it('total rain over 5000 refuses despite individually valid hourly amounts',()=>{expect(()=>parseStormForecast(control(0,250,24),start,end)).toThrow('contract range');});
it('daily budget permits 101st URL, stops at 2000 and recovers with time',async()=>{
 vi.useFakeTimers();vi.setSystemTime(start);const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);
 for(let i=0;i<2000;i++){const u=new URL(meta.url);u.searchParams.set('latitude',String(-80+i*.05));await readStormForecast(u.toString());await vi.advanceTimersByTimeAsync(13000);}
 expect(f).toHaveBeenCalledTimes(2000);const u=new URL(meta.url);u.searchParams.set('latitude','89');await expect(readStormForecast(u.toString())).rejects.toThrow();expect(f).toHaveBeenCalledTimes(2000);await vi.advanceTimersByTimeAsync(86400000);expect((await readStormForecast(u.toString())).raw).toBe(raw);
});
it.each([403,429])('explicit %s blocks distinct URLs only during backoff',async status=>{
 vi.useFakeTimers();const f=vi.fn(async()=>new Response('',{status}));vi.stubGlobal('fetch',f);await expect(readStormForecast(meta.url)).rejects.toThrow();await expect(readStormForecast(meta.url+'&control=1')).rejects.toThrow();expect(f).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(3600000);f.mockImplementation(async()=>new Response(raw));expect((await readStormForecast(meta.url)).raw).toBe(raw);
});
it('US still answers NWS-only when forecast minute budget is exhausted',async()=>{
 vi.useFakeTimers();vi.setSystemTime(start);vi.stubGlobal('fetch',async()=>new Response(raw));for(let i=0;i<30;i++)await readStormForecast(meta.url+'&distinct='+i);
 vi.stubGlobal('fetch',async(u:unknown)=>{if(String(u).includes('api.open-meteo.com'))throw new Error('should not call capped source');return new Response(String(u).includes('/points/')?'{}':'{"features":[]}');});
 const r=await handleStormAlert({location:'27,-97'});expect(r.forecast_status).toBe('unavailable');expect(r.risk_score).toBe(0);expect(r.peak_gust_kmh).toBeNull();expect(r.answer).toContain('NWS-only');
});

it('actual 240h capture is complete through the maximum contract horizon',()=>{
 const r=readFileSync(join(__dirname,'fixtures/storm-forecast/cairo-240h.json'),'utf8'),m=JSON.parse(readFileSync(join(__dirname,'fixtures/storm-forecast/provenance-240h.json'),'utf8'));expect(sha256Hex(Buffer.from(r))).toBe(m.sha256);const f=parseStormForecast(r,Date.parse(m.start),Date.parse(m.end));expect(f.peakGust).toBe(45);expect(f.precipitation).toBe(1.96);
});
it('US fallback also handles invalid forecast body without inventing forecast numerics',async()=>{vi.stubGlobal('fetch',async(u:unknown)=>new Response(String(u).includes('api.open-meteo.com')?'{}':String(u).includes('/points/')?'{}':'{"features":[]}'));const r=await handleStormAlert({location:'27,-97'});expect(r.forecast_status).toBe('unavailable');expect(r.peak_gust_kmh).toBeNull();expect(r.risk_score).toBe(0);});
it('transport failure does not pause different subsequent healthy URL',async()=>{const f=vi.fn().mockRejectedValueOnce(new Error('transient network failure')).mockResolvedValueOnce(new Response(raw));vi.stubGlobal('fetch',f);await expect(readStormForecast(meta.url)).rejects.toThrow();expect((await readStormForecast(meta.url+'&different=1')).raw).toBe(raw);expect(f).toHaveBeenCalledTimes(2);});

it('burst rejections consume no budgets: real read counts recover atomically',async()=>{
 vi.useFakeTimers();vi.setSystemTime(start);const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);
 for(let i=0;i<2000;i++){const p=readStormForecast(meta.url+'&burst='+i);if(i<30)await p;else await expect(p).rejects.toThrow();}
 expect(f).toHaveBeenCalledTimes(30);expect(stormBudgetCountsForTests()).toEqual({day:30,hour:30,minute:30});
 await vi.advanceTimersByTimeAsync(60000);await readStormForecast(meta.url+'&after-minute=1');expect(f).toHaveBeenCalledTimes(31);expect(stormBudgetCountsForTests()).toEqual({day:31,hour:31,minute:1});
 await vi.advanceTimersByTimeAsync(3600000);await readStormForecast(meta.url+'&after-hour=1');expect(f).toHaveBeenCalledTimes(32);expect(stormBudgetCountsForTests()).toEqual({day:32,hour:1,minute:1});
});
