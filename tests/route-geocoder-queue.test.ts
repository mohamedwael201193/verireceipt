import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/route-queue-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {handleRouteEta} from '../src/handlers/routeEta';
import {resetRouteSourceForTests} from '../src/handlers/routeEta';
import {resolveRoutePlace,resetRouteGeocoderForTests,ROUTE_GEOCODE_BUDGET_MS} from '../src/handlers/routeGeocoder';
const raw=(n:string)=>readFileSync(join(__dirname,'fixtures/route-ranked',n+'.json'),'utf8');
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime('2026-11-26T12:00:00Z');resetRouteGeocoderForTests();resetRouteSourceForTests();});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();resetRouteGeocoderForTests();});afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
// Synthetic bodies in the real Open-Meteo and OSRM shapes: one city per name, route echoing the requested waypoints.
const coords=(name:string)=>{let h=0;for(const c of name)h=(h*31+c.charCodeAt(0))%9973;return {lat:10+(h%700)/10,lon:20+((h*7)%1200)/10};};
function stub(log:{t:number;kind:string;q:string}[]=[],zero=Date.now()){
 vi.stubGlobal('fetch',async(u:unknown)=>{const url=new URL(String(u));
  if(url.hostname==='geocoding-api.open-meteo.com'){const q=url.searchParams.get('name')!;log.push({t:Date.now()-zero,kind:'city',q});
   if(q.startsWith('street '))return new Response(raw('street-city-negative'));const c=coords(q);return new Response(JSON.stringify({results:[{name:q,latitude:c.lat,longitude:c.lon,admin1:'A',country:'C',feature_code:'PPL'}]}));}
  if(url.hostname==='photon.komoot.io'){const q=url.searchParams.get('q')!;log.push({t:Date.now()-zero,kind:'street',q});const c=coords(q);return new Response(JSON.stringify({features:[{geometry:{type:'Point',coordinates:[c.lon,c.lat]},properties:{name:q,city:'X',country:'C'}}]}));}
  const m=/driving\/([^;]+);([^?]+)\?/.exec(url.pathname+'?')!;const [a,b]=[m[1],m[2]].map(s=>s.split(',').map(Number));
  return new Response(JSON.stringify({code:'Ok',routes:[{duration:1000+Math.round(a[0]+b[0]),distance:5000}],waypoints:[{location:a,distance:0.5},{location:b,distance:0.5}]}));});
 return log;
}
const settle=(p:Promise<any>)=>p.then(v=>({ok:true as const,v}),e=>({ok:false as const,code:e?.code,status:e?.status}));
it('three simultaneous requests with two places each all succeed, reads queued 1.1 s apart',async()=>{
 const log=stub();
 const ps=[['Alpha','Bravo'],['Charlie','Delta'],['Echo','Foxtrot']].map(([o,d])=>settle(handleRouteEta({origin:o,destination:d})));
 await vi.advanceTimersByTimeAsync(7000);const rs=await Promise.all(ps);
 expect(rs.every(r=>r.ok)).toBe(true);
 expect(log.map(l=>l.t)).toEqual([0,1100,2200,3300,4400,5500]);
 expect(new Set(log.map(l=>l.q)).size).toBe(6);
});
it('the same two places in three simultaneous requests share two reads',async()=>{
 const log=stub();
 const ps=[1,2,3].map(()=>settle(handleRouteEta({origin:'Alpha',destination:'Bravo'})));
 await vi.advanceTimersByTimeAsync(3000);const rs=await Promise.all(ps);
 expect(rs.every(r=>r.ok)).toBe(true);expect(log).toHaveLength(2);
});
it('the 24 h cache answers first, then expires',async()=>{
 const log=stub();const first=settle(handleRouteEta({origin:'Alpha',destination:'Bravo'}));await vi.advanceTimersByTimeAsync(2500);expect((await first).ok).toBe(true);expect(log).toHaveLength(2);
 await vi.advanceTimersByTimeAsync(23*3600*1000);const again=await settle(handleRouteEta({origin:'Alpha',destination:'Bravo'}));expect(again.ok).toBe(true);expect(log).toHaveLength(2);
 await vi.advanceTimersByTimeAsync(2*3600*1000);const later=settle(handleRouteEta({origin:'Alpha',destination:'Bravo'}));await vi.advanceTimersByTimeAsync(2500);expect((await later).ok).toBe(true);expect(log).toHaveLength(4);
});
it('reads that would finish after the budget are refused as GEOCODER_BUSY and never consume a slot or halt later reads',async()=>{
 const log=stub();
 const names=['Aville','Bville','Cville','Dville','Eville','Fville','Gville','Hville'];
 const ps=[0,2,4,6].map(i=>settle(handleRouteEta({origin:names[i],destination:names[i+1]})));
 await vi.advanceTimersByTimeAsync(9000);const rs=await Promise.all(ps);
 expect(rs.slice(0,3).every(r=>r.ok)).toBe(true);
 const bad=rs[3] as any;expect(bad.ok).toBe(false);expect(bad.code).toBe('GEOCODER_BUSY');expect(bad.status).toBeGreaterThanOrEqual(500);
 expect(log.map(l=>l.t)).toEqual([0,1100,2200,3300,4400,5500,6600].slice(0,log.length));expect(log.every(l=>l.t+1200<=ROUTE_GEOCODE_BUDGET_MS+1200)).toBe(true);
 expect(Math.max(...log.map(l=>l.t))).toBeLessThanOrEqual(ROUTE_GEOCODE_BUDGET_MS-1200);
 const after=settle(handleRouteEta({origin:'Zulu',destination:'Yankee'}));await vi.advanceTimersByTimeAsync(3000);expect((await after).ok).toBe(true);
});
it('the budget boundary is exact',async()=>{
 stub();await resolveRoutePlace('Alpha');
 const ok=resolveRoutePlace('Bravo',Date.now()+1100+1200);await vi.advanceTimersByTimeAsync(1100);await expect(ok).resolves.toBeTruthy();
 const tight=resolveRoutePlace('Charlie',Date.now()+1100+1199);await expect(tight).rejects.toMatchObject({code:'GEOCODER_BUSY'});
});
it('a street fallback joins the same queue and keeps 1.1 s spacing',async()=>{
 const log=stub();
 const ps=[settle(handleRouteEta({origin:'street 1',destination:'Bravo'})),settle(handleRouteEta({origin:'Charlie',destination:'Delta'}))];
 await vi.advanceTimersByTimeAsync(8000);const rs=await Promise.all(ps);
 expect(rs.every(r=>r.ok)).toBe(true);expect(log.some(l=>l.kind==='street')).toBe(true);
 const t=log.map(l=>l.t);for(let i=1;i<t.length;i++)expect(t[i]-t[i-1]).toBeGreaterThanOrEqual(1100);
});
it('a source failure still stops later reads with GEOCODER_UNREACHABLE, not BUSY',async()=>{
 vi.stubGlobal('fetch',async()=>new Response('',{status:429}));
 await expect(resolveRoutePlace('Alpha')).rejects.toMatchObject({code:'GEOCODER_UNREACHABLE'});await expect(resolveRoutePlace('Bravo')).rejects.toMatchObject({code:'GEOCODER_UNREACHABLE'});
});
it('coordinates never touch the queue',async()=>{
 const log=stub();const p=settle(handleRouteEta({origin:'27.8006,-97.3961',destination:'30.2672,-97.7431'}));await vi.advanceTimersByTimeAsync(10);expect((await p).ok).toBe(true);expect(log).toHaveLength(0);
});
it('the 100 per day cap still ends in GEOCODER_UNREACHABLE and refused BUSY reads never spend a slot of it',async()=>{
 stub();let n=0;const one=async()=>{const p=settle(resolveRoutePlace('Cap'+(n++)+'ville'));await vi.advanceTimersByTimeAsync(1200);return p;};
 for(let i=0;i<90;i++)expect((await one()).ok).toBe(true);
 const burst=Array.from({length:10},()=>settle(resolveRoutePlace('Cap'+(n++)+'ville')));await vi.advanceTimersByTimeAsync(9000);
 const rs=await Promise.all(burst);expect(rs.filter(r=>r.ok).length).toBe(6);expect(rs.filter(r=>!r.ok&&(r as any).code==='GEOCODER_BUSY').length).toBe(4);
 for(let i=0;i<4;i++)expect((await one()).ok).toBe(true); // reads 97..100: would fail here if BUSY had spent slots
 const over=await one();expect(over.ok).toBe(false);expect((over as any).code).toBe('GEOCODER_UNREACHABLE');
});
it('a refused read does not advance nextStart: a read at t=6000 starts at 6600, keeping 1.1 s spacing and no extra delay',async()=>{
 const log=stub();
 const burst=Array.from({length:10},(_,i)=>settle(resolveRoutePlace('Burst'+i+'ville')));
 await vi.advanceTimersByTimeAsync(6000);const late=settle(resolveRoutePlace('Latecomer'));await vi.advanceTimersByTimeAsync(3000);
 await Promise.all(burst);expect((await late).ok).toBe(true);
 const t=log.map(l=>l.t);expect(t.slice(0,6)).toEqual([0,1100,2200,3300,4400,5500]);expect(t[6]).toBe(6600);expect(t.length).toBe(7);
});
it('the route read gets only what is left of the assumed 9 s, so the worst case stays inside it',async()=>{
 const done:number[]=[];const zero=Date.now();
 const base=stub();void base;const g=globalThis.fetch;
 vi.stubGlobal('fetch',(u:unknown,init?:any)=>String(u).includes('osrm')?new Promise((_,rej)=>{init?.signal?.addEventListener('abort',()=>rej(new Error('aborted')));}):(g as any)(u,init));
 const ps=[['Pa','Pb'],['Pc','Pd'],['Pe','Pf']].map(([o,d])=>settle(handleRouteEta({origin:o,destination:d})).then(r=>{done.push(Date.now()-zero);return r;}));
 await vi.advanceTimersByTimeAsync(20000);const rs=await Promise.all(ps);
 expect(rs.every(r=>!r.ok&&(r as any).code==='OSRM_UNREACHABLE')).toBe(true);
 expect(Math.max(...done)).toBeLessThanOrEqual(9000);expect(Math.min(...done)).toBeLessThan(9000);
});
