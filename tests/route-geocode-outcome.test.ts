import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/route-geocode-outcome-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {handleRouteEta} from '../src/handlers/routeEta';
import {resolveRoutePlace,resetRouteGeocoderForTests,geocodeFailureOutcome} from '../src/handlers/routeGeocoder';
import {refusalParamClass,routePlaceClass,REFUSAL_INTENTS} from '../src/core/refusalClass';
import {recordRequestCompletion} from '../src/core/requestMetrics';
const raw=(n:string)=>readFileSync(join(__dirname,'fixtures/route-ranked',n+'.json'),'utf8');
// Real captures (2026-11-24 and 2026-11-26): Open-Meteo reply for a nonsense name (street-city-negative), Photon empty collection (negative), Open-Meteo reply whose rank 1 is a park (om-lincoln-memorial).
let info:string[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime('2026-11-26T12:00:00Z');resetRouteGeocoderForTests();info=[];vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'info').mockImplementation((m:unknown)=>{info.push(String(m));});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();resetRouteGeocoderForTests();});afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
const lines=()=>info.map(l=>JSON.parse(l)).filter(o=>o.event==='route_geocode_outcome');
const run=async<T>(p:Promise<T>,ms=5000)=>{const s=p.then(v=>({ok:true as const,v}),e=>({ok:false as const,e}));await vi.advanceTimersByTimeAsync(ms);return s;};
const stub=(om:()=>Response|Promise<Response>,ph:()=>Response|Promise<Response>=()=>new Response(raw('negative')))=>vi.stubGlobal('fetch',async(u:unknown)=>new URL(String(u)).hostname==='geocoding-api.open-meteo.com'?om():ph());
const Q='Zzz-Secret-Place-9931';
it('real empty replies from both providers: PLACE_NOT_FOUND stays 422 and both outcomes are no_result',async()=>{
 stub(()=>new Response(raw('street-city-negative')));
 const r:any=await run(resolveRoutePlace(Q,undefined,'origin'));
 expect(r.ok).toBe(false);expect(r.e).toMatchObject({status:422,code:'PLACE_NOT_FOUND'});
 expect(lines()).toEqual([{event:'route_geocode_outcome',open_meteo:'no_result',photon:'no_result',origin_or_dest:'origin'}]);
});
it('non-city Open-Meteo rank 1 (real park capture) then empty Photon: not_city and no_result',async()=>{
 stub(()=>new Response(raw('om-lincoln-memorial')));
 const r:any=await run(resolveRoutePlace('Lincoln Memorial',undefined,'destination'));
 expect(r.e).toMatchObject({status:422,code:'PLACE_NOT_FOUND'});
 expect(lines()).toEqual([{event:'route_geocode_outcome',open_meteo:'not_city',photon:'no_result',origin_or_dest:'destination'}]);
});
it.each([[429,'http_429'],[403,'http_403'],[500,'other']])('Open-Meteo HTTP %s: existing 502, outcome %s, Photon not asked',async(status,label)=>{
 stub(()=>new Response('',{status}));
 const r:any=await run(resolveRoutePlace(Q,undefined,'origin'));
 expect(r.e).toMatchObject({status:502,code:'GEOCODER_UNREACHABLE'});
 expect(lines()).toEqual([{event:'route_geocode_outcome',open_meteo:label,photon:'not_asked',origin_or_dest:'origin'}]);
});
it('Open-Meteo empty, Photon HTTP 429: no_result then http_429',async()=>{
 stub(()=>new Response(raw('street-city-negative')),()=>new Response('',{status:429}));
 const r:any=await run(resolveRoutePlace(Q,undefined,'destination'),6000);
 expect(r.e).toMatchObject({status:502,code:'GEOCODER_UNREACHABLE'});
 expect(lines()).toEqual([{event:'route_geocode_outcome',open_meteo:'no_result',photon:'http_429',origin_or_dest:'destination'}]);
});
it('a hung provider is a timeout',async()=>{
 vi.stubGlobal('fetch',(_u:unknown,init?:any)=>new Promise((_,rej)=>{init?.signal?.addEventListener('abort',()=>rej(new Error('aborted')));}));
 const r:any=await run(resolveRoutePlace(Q,undefined,'origin'),3000);
 expect(r.e.code).toBe('GEOCODER_UNREACHABLE');expect(lines()[0]).toMatchObject({open_meteo:'timeout',photon:'not_asked'});
});
it('after a 429 the halted provider is labelled halted',async()=>{
 stub(()=>new Response('',{status:429}));
 await run(resolveRoutePlace('First'+Q,undefined,'origin'));await run(resolveRoutePlace('Second'+Q,undefined,'origin'),3000);
 expect(lines().map(l=>l.open_meteo)).toEqual(['http_429','halted']);
});
it('a malformed body is parse',async()=>{
 stub(()=>new Response(JSON.stringify({results:'not-a-list'})));
 const r:any=await run(resolveRoutePlace(Q,undefined,'origin'));
 expect(r.e.code).toBe('GEOCODER_UNREACHABLE');expect(lines()[0]).toMatchObject({open_meteo:'parse',photon:'not_asked'});
});
it('a queue wait that cannot fit the budget is busy and keeps GEOCODER_BUSY',async()=>{
 stub(()=>new Response(raw('om-london')));
 await resolveRoutePlace('London');
 const r:any=await resolveRoutePlace('Paris'+Q,Date.now()+1100+1199,'origin').then(()=>null,e=>e);
 expect(r).toMatchObject({status:502,code:'GEOCODER_BUSY'});expect(lines()[0]).toMatchObject({open_meteo:'busy',photon:'not_asked'});
});
it('failure mapping covers halted, budget, parse, unknown',()=>{
 expect(geocodeFailureOutcome(new Error('geocoder reads halted'),false)).toBe('halted');
 expect(geocodeFailureOutcome(new Error('geocoder conservative budget exhausted'),false)).toBe('budget');
 expect(geocodeFailureOutcome(new Error('geocoder deadline'),false)).toBe('timeout');
 expect(geocodeFailureOutcome(new Error('x'),true)).toBe('parse');
 expect(geocodeFailureOutcome(new Error('x'),false)).toBe('other');
 expect(geocodeFailureOutcome('boom',false)).toBe('other');
});
it('end to end: the destination is named and no log line carries the query text; status and code unchanged',async()=>{
 stub(()=>new Response(raw('street-city-negative')));
 const p=handleRouteEta({origin:'38.8893,-77.0502',destination:Q}).then(()=>null,e=>e);await vi.advanceTimersByTimeAsync(6000);const e:any=await p;
 expect(e).toMatchObject({status:422,code:'PLACE_NOT_FOUND'});
 expect(lines()).toEqual([{event:'route_geocode_outcome',open_meteo:'no_result',photon:'no_result',origin_or_dest:'destination'}]);
 recordRequestCompletion('/v1/route-eta',422,2670,{query:{origin:'38.8893,-77.0502',destination:Q},errorCode:'PLACE_NOT_FOUND',rawErrorCode:'PLACE_NOT_FOUND'});
 const all=info.join('\n');for(const bad of ['Zzz','Secret','9931'])expect(all).not.toContain(bad);
 const r=info.map(l=>JSON.parse(l)).filter(o=>o.event==='refusal_param_class');
 expect(r).toHaveLength(1);
 expect(r[0]).toMatchObject({intent:'ROUTE_ETA_GENERAL',error_code:'PLACE_NOT_FOUND',status:'422',origin_place_class:'latlon',origin_has_comma:true,destination_place_class:'ascii_place',destination_has_comma:false});
});
it('place classes',()=>{
 expect(REFUSAL_INTENTS['/v1/route-eta']).toBe('ROUTE_ETA_GENERAL');
 for(const [v,c] of [['38.8,-77.0','latlon'],[' -1.5 , 2 ','latlon'],['Cairo','ascii_place'],['Springfield, IL','ascii_place'],['القاهرة','non_ascii'],['x'.repeat(251),'long'],['','absent'],[undefined,'absent']] as const)expect(routePlaceClass(v)).toBe(c);
 expect(refusalParamClass('/v1/route-eta','PLACE_NOT_FOUND',{origin:'Springfield, IL',destination:'القاهرة'})).toEqual({origin_place_class:'ascii_place',origin_has_comma:true,destination_place_class:'non_ascii',destination_has_comma:false});
});
