import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/route-halt-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {handleRouteEta} from '../src/handlers/routeEta';
import {resolveRoutePlace,resetRouteGeocoderForTests,PROVIDER_HALT_MS} from '../src/handlers/routeGeocoder';
const raw=(n:string)=>readFileSync(join(__dirname,'fixtures/route-ranked',n+'.json'),'utf8');
let warn:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime('2026-11-26T12:00:00Z');resetRouteGeocoderForTests();warn=vi.spyOn(console,'warn').mockImplementation(()=>{});});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();resetRouteGeocoderForTests();warn.mockRestore();});afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
const city=(q:string)=>JSON.stringify({results:[{name:q,latitude:10+q.length,longitude:20+q.length,admin1:'A',country:'C',feature_code:'PPL',population:1000000}]});
const LANDMARKS=['Space Needle','Pike Place','Ferry Building','Lumen Field','Gas Works Park','Secret Street 12']; // Open-Meteo has no city of these names, so the street geocoder is needed
type Mode='ok'|'hang'|'429'|'500'|'403';
function stub(mode:{photon:Mode;om:Mode}){const calls:string[]=[];
 vi.stubGlobal('fetch',async(u:unknown,init?:any)=>{const url=new URL(String(u));
  const om=url.hostname==='geocoding-api.open-meteo.com';const ph=url.hostname==='photon.komoot.io';const m=om?mode.om:mode.photon;
  if(om||ph){calls.push((om?'OM:':'PH:')+(url.searchParams.get(om?'name':'q')));
   if(m==='hang')return new Promise((_,rej)=>{init?.signal?.addEventListener('abort',()=>rej(new Error('aborted')));});
   if(m!=='ok')return new Response('',{status:Number(m)});
   return new Response(om?(LANDMARKS.includes(url.searchParams.get('name')!)?JSON.stringify({results:[]}):city(url.searchParams.get('name')!)):raw('photon-lincoln-memorial'));}
  const mm=/driving\/([^;]+);([^?]+)\?/.exec(url.pathname+'?')!;const [a,b]=[mm[1],mm[2]].map(x=>x.split(',').map(Number));
  return new Response(JSON.stringify({code:'Ok',routes:[{duration:1000,distance:5000}],waypoints:[{location:a,distance:1},{location:b,distance:1}]}));});
 return calls;}
const run=async<T>(p:Promise<T>,ms=3000)=>{const s=p.then(v=>({ok:true as const,v}),e=>({ok:false as const,e}));await vi.advanceTimersByTimeAsync(ms);return s;};
it('a Photon timeout on a landmark does not stop Open-Meteo city pairs (the production Seattle-Portland failure)',async()=>{
 const calls=stub({photon:'hang',om:'ok'});
 const bad:any=await run(handleRouteEta({origin:'Space Needle',destination:'Seattle'}),5000);expect(bad.ok).toBe(false);expect(bad.e.code).toBe('GEOCODER_UNREACHABLE');expect(bad.e.status).toBe(502);
 const good:any=await run(handleRouteEta({origin:'Seattle',destination:'Portland'}),4000);expect(good.ok).toBe(true);expect(good.v.duration_seconds).toBe(1000);
 expect(calls.filter(c=>c.startsWith('PH')).length).toBe(1);
});
it('Photon stays halted for the halt window, then reads again; no retry inside the window',async()=>{
 const calls=stub({photon:'hang',om:'ok'});
 await run(resolveRoutePlace('Space Needle'));expect(calls.filter(c=>c.startsWith('PH')).length).toBe(1);
 await run(resolveRoutePlace('Pike Place'));await run(resolveRoutePlace('Ferry Building'));expect(calls.filter(c=>c.startsWith('PH')).length).toBe(1);
 await vi.advanceTimersByTimeAsync(PROVIDER_HALT_MS-8000);await run(resolveRoutePlace('Lumen Field'));expect(calls.filter(c=>c.startsWith('PH')).length).toBe(1);
 await vi.advanceTimersByTimeAsync(10000);await run(resolveRoutePlace('Gas Works Park'));expect(calls.filter(c=>c.startsWith('PH')).length).toBe(2);
});
it('an Open-Meteo timeout or 500 does not halt anything: the next city read goes out',async()=>{
 for(const om of ['hang','500'] as Mode[]){resetRouteGeocoderForTests();const calls=stub({photon:'ok',om});
  const a:any=await run(resolveRoutePlace('Aville'));expect(a.ok).toBe(false);expect(a.e.code).toBe('GEOCODER_UNREACHABLE');
  stub({photon:'ok',om:'ok'});const b:any=await run(resolveRoutePlace('Bville'));expect(b.ok).toBe(true);void calls;}
});
it.each(['403','429'] as Mode[])('an explicit Open-Meteo HTTP %s refusal halts Open-Meteo only, for the window, then reads again',async m=>{
 const calls=stub({photon:'ok',om:m});await run(resolveRoutePlace('Aville'));await run(resolveRoutePlace('Bville'));expect(calls.filter(c=>c.startsWith('OM')).length).toBe(1);
 stub({photon:'ok',om:'ok'});const still:any=await run(resolveRoutePlace('Cville'));expect(still.ok).toBe(false);
 await vi.advanceTimersByTimeAsync(PROVIDER_HALT_MS+1000);const after:any=await run(resolveRoutePlace('Dville'));expect(after.ok).toBe(true);
});
it('a failed read is logged with provider, error name, timeout flag and elapsed ms, without the query',async()=>{
 stub({photon:'hang',om:'ok'});await run(resolveRoutePlace('Secret Street 12'));
 const lines=warn.mock.calls.map(c=>String(c[0])).filter(l=>l.includes('route_geocoder_read_failed'));expect(lines.length).toBe(1);
 const j=JSON.parse(lines[0]);expect(j.provider).toBe('Photon');expect(typeof j.error).toBe('string');expect(j.timeout).toBe(true);expect(j.elapsed_ms).toBeGreaterThanOrEqual(1100);expect(j.halts_provider_ms).toBe(PROVIDER_HALT_MS);expect(lines[0]).not.toContain('Secret');
});
it('refusals stay non-200 with the same disclosed code when a halted Photon is needed',async()=>{
 stub({photon:'hang',om:'ok'});await run(resolveRoutePlace('Space Needle'));
 const r:any=await run(resolveRoutePlace('Pike Place'));expect(r.ok).toBe(false);expect(r.e.status).toBe(502);expect(r.e.code).toBe('GEOCODER_UNREACHABLE');
});
it('a read refused because Photon is halted takes no start slot: the next city read is not delayed by it',async()=>{
 stub({photon:'hang',om:'ok'});await run(resolveRoutePlace('Space Needle'),5000);
 const inner=globalThis.fetch;const t:Record<string,number>={};const z=Date.now();
 vi.stubGlobal('fetch',async(u:unknown,i?:any)=>{const url=new URL(String(u));if(url.hostname==='geocoding-api.open-meteo.com')t[url.searchParams.get('name')!]=Date.now()-z;return (inner as any)(u,i);});
 const a=await run(resolveRoutePlace('Pike Place'),50);expect(a.ok).toBe(false);const b=await run(resolveRoutePlace('Qville'),3000);expect(b.ok).toBe(true);
 expect(t['Qville']-t['Pike Place']).toBe(1100);
});
