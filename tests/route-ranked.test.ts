import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/route-ranked-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {handleRouteEta} from '../src/handlers/routeEta';
import {parseRankedLocation,resetRouteGeocoderForTests,resolveRoutePlace} from '../src/handlers/routeGeocoder';
import {getReceiptEvidence} from '../src/core/storage';
import {sha256Hex} from '../src/core/receipt';
const raw=(name:string)=>readFileSync(join(__dirname,'fixtures/route-ranked',name+'.json'),'utf8');
const springfieldRoute=readFileSync(join(__dirname,'fixtures/route-binding/springfield-calallen.json'),'utf8');
const dcRoute=readFileSync(join(__dirname,'fixtures/route-binding/dc-calallen.json'),'utf8');
const route=readFileSync(join(__dirname,'fixtures/route-eta/osrm-corpus-to-calallen.json'),'utf8');
beforeEach(()=>resetRouteGeocoderForTests());afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();resetRouteGeocoderForTests();});afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
it('real ambiguous city uses first provider result, count and full-precision coordinates disclosed',async()=>{
 const body=raw('springfield'),j=JSON.parse(body),hit=j.results[0];const f=vi.fn(async(url:unknown)=>new Response(String(url).includes('geocoding-api')?body:springfieldRoute));vi.stubGlobal('fetch',f);
 const out=await handleRouteEta({origin:'Springfield',destination:'27.8006,-97.3961'});expect(out.origin).toBe(hit.latitude+','+hit.longitude);expect(String(out.answer)).toContain('of '+j.results.length+' matches');expect(String(out.answer)).toContain('rank 1, provider order; not confirmed unique');
 expect(f.mock.calls.some(([url])=>String(url).includes('photon'))).toBe(false);
 const r=out.receipt as any,ev=String((await getReceiptEvidence(r.receipt_id)).evidence),e=JSON.parse(ev);expect(sha256Hex(ev)).toBe(r.raw_response_sha256);expect(e.geocoders[0].raw_body).toBe(body);expect(e.origin_selection).toContain('of '+j.results.length+' matches');expect(e.origin).toBe(out.origin);
});
it('real public street capture falls through a real empty city capture, exact evidence retained',async()=>{
 const city=raw('street-city-negative'),street=raw('street'),hit=JSON.parse(street).features[0],c=hit.geometry.coordinates;
 vi.stubGlobal('fetch',async(url:unknown)=>new Response(String(url).includes('geocoding-api')?city:String(url).includes('photon')?street:dcRoute));
 const out=await handleRouteEta({origin:'1600 Pennsylvania Avenue NW, Washington DC',destination:'27.8006,-97.3961'});expect(out.origin).toBe(c[1]+','+c[0]);expect(String(out.answer)).toContain('Photon');expect(String(out.answer)).toContain('OpenStreetMap');expect(String(out.answer)).toContain('ODbL');
 const ev=JSON.parse(String((await getReceiptEvidence((out.receipt as any).receipt_id)).evidence));expect(ev.geocoders.map((g:any)=>g.raw_body)).toEqual([city,street]);
});
it('actual negative street capture gives only PLACE_NOT_FOUND',async()=>{
 vi.stubGlobal('fetch',async(url:unknown)=>new Response(String(url).includes('geocoding-api')?raw('street-city-negative'):raw('negative')));
 await expect(resolveRoutePlace('Zzznotaplaceverireceipt20261124')).rejects.toMatchObject({status:422,code:'PLACE_NOT_FOUND'});
});
it.each(['91,0','1000,0','0,181','1e3,0','1,2,3','-.,20'])('invalid coordinates %s never contact a geocoder',async origin=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);await expect(handleRouteEta({origin,destination:'0,0'})).rejects.toMatchObject({status:400,code:'BAD_LOCATION'});expect(f).not.toHaveBeenCalled();
});
it.each([403,429,500])('HTTP %s source refusal never switches providers and stops subsequent reads',async status=>{
 const f=vi.fn(async()=>new Response('',{status}));vi.stubGlobal('fetch',f);await expect(resolveRoutePlace('Springfield')).rejects.toMatchObject({code:'GEOCODER_UNREACHABLE'});await expect(resolveRoutePlace('London')).rejects.toMatchObject({code:'GEOCODER_UNREACHABLE'});expect(f).toHaveBeenCalledTimes(1);
});
it('same-query reads coalesce/cache; source acquisition timestamp is retained',async()=>{
 const f=vi.fn(async()=>new Response(raw('springfield')));vi.stubGlobal('fetch',f);const [a,b]=await Promise.all([resolveRoutePlace('Springfield'),resolveRoutePlace('Springfield')]);const c=await resolveRoutePlace('Springfield');expect(f).toHaveBeenCalledTimes(1);expect(a.captures).toEqual(b.captures);expect(c.captures).toEqual(a.captures);
});
it('malformed highest-ranked match is not skipped or guessed',()=>{
 const j=JSON.parse(raw('springfield'));j.results[0].latitude=91;expect(()=>parseRankedLocation(JSON.stringify(j),'Open-Meteo')).toThrow();const p=JSON.parse(raw('street'));p.features[0].geometry.coordinates=[null,null];expect(()=>parseRankedLocation(JSON.stringify(p),'Photon')).toThrow();
});
it('hard deadline bounds a hung source without fallback',async()=>{
 vi.useFakeTimers();const f=vi.fn(()=>new Promise(()=>{}));vi.stubGlobal('fetch',f);const p=expect(resolveRoutePlace('Springfield')).rejects.toMatchObject({code:'GEOCODER_UNREACHABLE'});await vi.advanceTimersByTimeAsync(3100);await p;expect(f).toHaveBeenCalledTimes(1);
});
it('start spacing and conservative per-day budget hold across distinct queries',async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-11-24T00:00:00Z');const starts:number[]=[];vi.stubGlobal('fetch',async()=>{starts.push(Date.now());return new Response(raw('springfield'));});
 await resolveRoutePlace('city 0');for(let n=1;n<100;n++){const p=resolveRoutePlace('city '+n);await vi.advanceTimersByTimeAsync(1100);await p;}
 expect(starts).toHaveLength(100);expect(starts.slice(1).every((t,n)=>t-starts[n]>=1100)).toBe(true);
 await expect(resolveRoutePlace('city 100')).rejects.toMatchObject({code:'GEOCODER_UNREACHABLE'});expect(starts).toHaveLength(100);
});
