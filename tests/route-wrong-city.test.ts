import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/route-wrong-city-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {handleRouteEta} from '../src/handlers/routeEta';
import {resolveRoutePlace,resetRouteGeocoderForTests,isCityRow} from '../src/handlers/routeGeocoder';
const raw=(n:string)=>readFileSync(join(__dirname,'fixtures/route-ranked',n+'.json'),'utf8');
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime('2026-11-26T12:00:00Z');resetRouteGeocoderForTests();vi.spyOn(console,'warn').mockImplementation(()=>{});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();resetRouteGeocoderForTests();});afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
// Real captures taken 2026-11-26 from Open-Meteo and Photon for the exact query text.
const om:Record<string,string>={'Lincoln Memorial':'om-lincoln-memorial','Springfield':'springfield','Paris':'om-paris','London':'om-london','Berlin':'om-berlin','Lyon':'om-lyon','Porto':'om-porto','Florence':'om-florence','Athens':'om-athens','Barcelona':'om-barcelona','Valencia':'om-valencia','Portland':'om-portland','1600 Pennsylvania Ave Washington':'om-1600-pennsylvania'};
const ph:Record<string,string>={'Lincoln Memorial':'photon-lincoln-memorial','1600 Pennsylvania Ave Washington':'photon-1600-pennsylvania'};
function stub(o:{om?:Record<string,string>;photon?:'ok'|'500'|'hang'|'empty'}={}){const calls:string[]=[];
 vi.stubGlobal('fetch',async(u:unknown,init?:any)=>{const url=new URL(String(u));
  if(url.hostname==='geocoding-api.open-meteo.com'){const q=url.searchParams.get('name')!;calls.push('OM:'+q);return new Response(o.om?.[q]??raw(om[q]));}
  if(url.hostname==='photon.komoot.io'){const q=url.searchParams.get('q')!;calls.push('PH:'+q);const m=o.photon??'ok';
   if(m==='hang')return new Promise((_,rej)=>{init?.signal?.addEventListener('abort',()=>rej(new Error('aborted')));});
   if(m==='500')return new Response('',{status:500});if(m==='empty')return new Response(JSON.stringify({features:[]}));return new Response(raw(ph[q]));}
  const mm=/driving\/([^;]+);([^?]+)\?/.exec(url.pathname+'?')!;const [a,b]=[mm[1],mm[2]].map(x=>x.split(',').map(Number));
  return new Response(JSON.stringify({code:'Ok',routes:[{duration:900,distance:7000}],waypoints:[{location:a,distance:1},{location:b,distance:1}]}));});return calls;}
const run=async<T>(p:Promise<T>,ms=5000)=>{const s=p.then(v=>({ok:true as const,v}),e=>({ok:false as const,e}));await vi.advanceTimersByTimeAsync(ms);return s;};
it('Lincoln Memorial: Open-Meteo rank 1 is a park (PRK), so Photon answers and the place is the DC memorial',async()=>{
 const calls=stub();const r:any=await run(resolveRoutePlace('Lincoln Memorial'));expect(r.ok).toBe(true);
 expect(calls).toEqual(['OM:Lincoln Memorial','PH:Lincoln Memorial']);expect(r.v.hit.provider).toBe('Photon');
 expect(Math.abs(r.v.hit.latitude-38.8893)).toBeLessThan(0.01);expect(Math.abs(r.v.hit.longitude+77.0502)).toBeLessThan(0.01);expect(r.v.captures.length).toBe(2);
 expect(JSON.parse(raw('om-lincoln-memorial')).results[0].feature_code).toBe('PRK');
});
it('1600 Pennsylvania Ave Washington still reaches Photon and gives the White House',async()=>{
 stub();const r:any=await run(resolveRoutePlace('1600 Pennsylvania Ave Washington'));expect(r.v.hit.provider).toBe('Photon');expect(r.v.hit.label).toContain('White House');
});
it.each(Object.keys(om).filter(k=>!['Lincoln Memorial','1600 Pennsylvania Ave Washington'].includes(k)))('%s is unchanged: rank 1 of Open-Meteo, one read, same coordinates and count',async q=>{
 const calls=stub();const r:any=await run(resolveRoutePlace(q));const rows=JSON.parse(raw(om[q])).results;
 expect(r.ok).toBe(true);expect(calls).toEqual(['OM:'+q]);expect(r.v.hit.provider).toBe('Open-Meteo');expect(r.v.hit.latitude).toBe(rows[0].latitude);expect(r.v.hit.longitude).toBe(rows[0].longitude);expect(r.v.hit.count).toBe(rows.length);expect(isCityRow(rows[0])).toBe(true);
});
it('the class rule is PPL* or ADM* and nothing else; a missing feature code is not a city',()=>{
 for(const c of ['PPL','PPLA','PPLA2','PPLC','PPLX','ADM1','ADM2','ADM3'])expect(isCityRow({feature_code:c})).toBe(true);
 for(const c of ['PRK','MT','AIRP','BLDG','MNMT','STM','','pplx','XPPL','ADMD_X'.slice(0,0)])expect(isCityRow({feature_code:c})).toBe(false);
 expect(isCityRow({})).toBe(false);expect(isCityRow(undefined)).toBe(false);expect(isCityRow({feature_code:7})).toBe(false);
});
it('a row without feature_code is not taken as a city (synthetic: Lyon with the code removed), Photon is asked',async()=>{
 const j=JSON.parse(raw('om-lyon'));delete j.results[0].feature_code;const calls=stub({om:{Lyon:JSON.stringify(j)}});
 await run(resolveRoutePlace('Lyon'));expect(calls).toEqual(['OM:Lyon','PH:Lyon']);
});
it('an administrative division is accepted (synthetic: Lyon rank 1 recoded ADM1)',async()=>{
 const j=JSON.parse(raw('om-lyon'));j.results[0].feature_code='ADM1';const calls=stub({om:{Lyon:JSON.stringify(j)}});
 const r:any=await run(resolveRoutePlace('Lyon'));expect(r.ok).toBe(true);expect(calls).toEqual(['OM:Lyon']);
});
it.each(['500','hang'] as const)('non-city rank 1 and Photon %s: refuses with the existing 502, never falls back to the park',async mode=>{
 const calls=stub({photon:mode});const r:any=await run(resolveRoutePlace('Lincoln Memorial'));
 expect(r.ok).toBe(false);expect(r.e.status).toBe(502);expect(r.e.code).toBe('GEOCODER_UNREACHABLE');expect(calls).toEqual(['OM:Lincoln Memorial','PH:Lincoln Memorial']);
});
it('non-city rank 1 while Photon is halted: refuses with the existing 502 without any Photon read',async()=>{
 const calls=stub({photon:'500'});await run(resolveRoutePlace('Lincoln Memorial'));
 const c2=stub({photon:'500',om:{Lincoln:raw('om-lincoln-memorial')}});const r:any=await run(resolveRoutePlace('Lincoln'));
 expect(r.ok).toBe(false);expect(r.e.status).toBe(502);expect(r.e.code).toBe('GEOCODER_UNREACHABLE');expect(c2).toEqual(['OM:Lincoln']);void calls;
});
it('non-city rank 1 and an empty Photon answer: PLACE_NOT_FOUND 422, not the park',async()=>{
 stub({photon:'empty'});const r:any=await run(resolveRoutePlace('Lincoln Memorial'));expect(r.ok).toBe(false);expect(r.e.status).toBe(422);expect(r.e.code).toBe('PLACE_NOT_FOUND');
});
it('end to end: Lincoln Memorial routes from DC, not from Illinois',async()=>{
 stub();const r:any=await run(handleRouteEta({origin:'Lincoln Memorial',destination:'38.8977,-77.0365'}),4000);expect(r.ok).toBe(true);expect(String(r.v.origin)).toMatch(/^38\.88/);expect(String(r.v.answer)).toContain('Photon');
});
