import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleMacro,resetMacroCachesForTests,startMacroBootWarm,stopMacroBootWarm,resetMacroBootWarmForTests} from '../src/handlers/macroEconomic';
import {sha256Hex} from '../src/core/receipt';
const dir='tests/fixtures/macro-coverage/';
const catalog=readFileSync('tests/fixtures/macro-fuzzy/countries.json','utf8');
const raw=readFileSync(dir+'SL.UEM.1524.ZS-observation.json','utf8');
afterEach(()=>{stopMacroBootWarm();resetMacroBootWarmForTests();resetMacroCachesForTests();vi.unstubAllGlobals();vi.clearAllMocks();vi.useRealTimers();});
it.each(['catalog','observation'])('cold%s timeout recovers once with real bytes within shared20secondbudget',async(part)=>{
 vi.useFakeTimers();let catalogs=0,observations=0;
 vi.stubGlobal('fetch',async(u:any,o:any)=>{
  const country=!String(u).includes('/indicator/');const n=country?++catalogs:++observations;
  if(n===1&&((part==='catalog')===country))return new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'}))));
  return new Response(country?catalog:raw);
 });
 const p=handleMacro({indicator:'youth unemployment',country:'US',year:'2022'});await vi.advanceTimersByTimeAsync(10000);const out=await p;
 expect(out.indicator_id).toBe('SL.UEM.1524.ZS');expect(out.value).toBe(JSON.parse(raw)[1][0].value);expect((out.receipt as any).raw_response_sha256).toBe(sha256Hex(raw));expect(vi.mocked(saveReceipt).mock.calls.at(-1)?.[1]).toBe(raw);
 expect(catalogs).toBe(part==='catalog'?2:1);expect(observations).toBe(part==='observation'?2:1);
});
it('one failed warm series does not block the other24explicitseries orcountry',async()=>{
 vi.useFakeTimers();const urls:string[]=[];vi.stubGlobal('fetch',async(u:any)=>{urls.push(String(u));return new Response(String(u).includes('/indicator/SL.UEM.1524.ZS')?'outage':String(u).includes('/indicator/')?raw:catalog,{status:String(u).includes('/indicator/SL.UEM.1524.ZS')?503:200});});startMacroBootWarm();await vi.advanceTimersByTimeAsync(60000);
 expect(urls.some(u=>u.includes('NY.GDP.PCAP.KD.ZG'))).toBe(true);expect(urls.some(u=>u.includes('NE.TRD.GNFS.ZS'))).toBe(true);expect(vi.mocked(saveReceipt)).not.toHaveBeenCalled();
});
it('boot-warmed youth observation serves exact matching request without another fetch',async()=>{
 vi.useFakeTimers();const f=vi.fn(async(u:any)=>new Response(String(u).includes('/indicator/')?raw:catalog));vi.stubGlobal('fetch',f);startMacroBootWarm();await vi.advanceTimersByTimeAsync(1001);stopMacroBootWarm();const n=f.mock.calls.length;
 const out=await handleMacro({indicator:'youth unemployment',country:'US'});expect(f).toHaveBeenCalledTimes(n);expect(out.indicator_id).toBe('SL.UEM.1524.ZS');expect((out.receipt as any).raw_response_sha256).toBe(sha256Hex(raw));
});
it('shutdown prevents country timeout retry in background',async()=>{
 vi.useFakeTimers();const f=vi.fn(async(_u:any,o:any)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})))));vi.stubGlobal('fetch',f);startMacroBootWarm();await vi.advanceTimersByTimeAsync(1000);stopMacroBootWarm();await vi.advanceTimersByTimeAsync(120000);expect(f).toHaveBeenCalledTimes(1);
});
it.each([429,404])('cold country HTTP%s never retries',async(status)=>{
 const f=vi.fn(async()=>new Response('unavailable',{status}));vi.stubGlobal('fetch',f);await expect(handleMacro({indicator:'youth unemployment',country:'US'})).rejects.toMatchObject({status:502});expect(f).toHaveBeenCalledTimes(1);expect(saveReceipt).not.toHaveBeenCalled();
});

it('boot country repeated timeouts use exactly two underlying attempts, never nested four',async()=>{
 vi.useFakeTimers();const f=vi.fn(async(_u:any,o:any)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})))));vi.stubGlobal('fetch',f);startMacroBootWarm();await vi.advanceTimersByTimeAsync(120000);expect(f).toHaveBeenCalledTimes(2);
});
