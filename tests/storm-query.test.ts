import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleStormAlert,stormQueryLocations} from '../src/handlers/stormAlert';
import {resetStormForecastForTests} from '../src/handlers/stormForecast';
const raw=(n:string)=>readFileSync('tests/fixtures/storm-query/'+n,'utf8');
const geo=raw('miami-florida.json'),points=raw('miami-points.json'),alerts=raw('miami-alerts.json');
const sentence='Are there any storm alerts in Miami, Florida right now?';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();resetStormForecastForTests();});
function replay(hitAt:string|null){
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-25T16:13:36Z'));
 const calls:string[]=[];
 vi.stubGlobal('fetch',async(input:unknown)=>{
  const u=new URL(String(input));
  if(u.hostname==='geocoding-api.open-meteo.com'){const name=u.searchParams.get('name')!;calls.push(name);return new Response(name===hitAt?geo:'{"results":[]}');}
  if(u.hostname==='api.open-meteo.com')throw Error('forecast unavailable negative control');
  if(u.hostname==='api.weather.gov')return new Response(u.pathname.startsWith('/points/')?points:alerts);
  throw Error('unexpected source');
 });return calls;
}
it('query sentence extracts real Miami geocoder capture, stops after first hit and retains selection evidence',async()=>{
 const calls=replay('Miami, Florida');const out=await handleStormAlert({query:sentence});
 expect(calls).toEqual(['Miami, Florida']);expect(out.location).toBe('25.77427,-80.19366');
 expect(out.answer).toContain('Miami, Florida, United States');expect(out.answer).toContain('rank 1, provider order; not confirmed unique');
 const ev=JSON.parse(String(vi.mocked(saveReceipt).mock.calls[0][1]));expect(ev.geocoder.raw_body).toBe(geo);expect(ev.geocoder.url).toContain('name=Miami%2C%20Florida');expect(ev.raw_bodies.alerts).toBe(alerts);
});
it('query candidates retry stripped then whole text in order, all empty stays422',async()=>{
 const calls=replay(null);await expect(handleStormAlert({query:sentence})).rejects.toMatchObject({status:422,code:'PLACE_NOT_FOUND'});
 expect(calls).toEqual(['Miami, Florida','in Miami, Florida',sentence]);expect(saveReceipt).not.toHaveBeenCalled();
});
it.each(['in Miami, Florida',sentence])('first real candidate hit at %s stops later fallback',async hit=>{
 const calls=replay(hit);const out=await handleStormAlert({query:sentence});expect(out.location).toBe('25.77427,-80.19366');expect(calls.at(-1)).toBe(hit);expect(calls.length).toBe(hit===sentence?3:2);
});
it('declared location wins and is never reinterpreted as query prose',async()=>{
 const calls=replay('Miami, Florida');await expect(handleStormAlert({location:sentence,query:'Miami, Florida'})).rejects.toMatchObject({code:'PLACE_NOT_FOUND'});expect(calls).toEqual([sentence]);
});
it('inline coordinates skip geocoder and preserve out-of-range refusal',async()=>{
 const calls=replay(null);const out=await handleStormAlert({query:'Any storm alerts near 25.77427,-80.19366 today?'});expect(out.location).toBe('25.77427,-80.19366');expect(calls).toEqual([]);
 await expect(handleStormAlert({query:'storm at 91,0 tonight'})).rejects.toMatchObject({code:'BAD_LOCATION'});
});
it.each(['in','for','near','around','at','over','of'])('extracts place after %s while preserving internal comma',prefix=>{
 expect(stormQueryLocations('Are there any storm alerts '+prefix+' Miami, Florida currently?')[0]).toBe('Miami, Florida');
});
it.each(['right now','today','tonight','currently'])('strips temporal suffix %s and filler without a preposition',suffix=>{
 expect(stormQueryLocations('current weather warning Miami '+suffix+'?')[0]).toBe('Miami');
});
it('malformed top geocoder result is not skipped in favor of fallback guesses',async()=>{
 const calls=replay(null);vi.stubGlobal('fetch',async()=>{calls.push('attempt');return new Response('{"results":[{"latitude":91}]}');});await expect(handleStormAlert({query:sentence})).rejects.toMatchObject({code:'GEOCODER_UNREACHABLE'});expect(calls).toHaveLength(1);
});

it('sentence punctuation ends extracted place without losing administrative comma',()=>{expect(stormQueryLocations('storm alerts in Miami, Florida. Please check.')[0]).toBe('Miami, Florida');});

it.each(['fetch','body'])('geocoder candidates share6s with abort-ignoring second %s',async mode=>{
 replay(null);const start=Date.now();const calls:number[]=[];
 vi.stubGlobal('fetch',async()=>{
  calls.push(Date.now()-start);
  if(calls.length===1){await new Promise(r=>setTimeout(r,2000));return new Response('{"results":[]}');}
  if(mode==='fetch')return new Promise<Response>(()=>{});
  return {status:200,text:()=>new Promise<string>(()=>{})} as Response;
 });
 let done=false;const p=handleStormAlert({query:sentence}).catch(e=>{done=true;return e;});
 await vi.advanceTimersByTimeAsync(5999);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(done).toBe(true);expect(await p).toMatchObject({code:'GEOCODER_UNREACHABLE'});expect(calls).toEqual([0,2000]);expect(saveReceipt).not.toHaveBeenCalled();
});
