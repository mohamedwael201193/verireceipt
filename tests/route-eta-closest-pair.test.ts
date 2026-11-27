import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/route-eta-pair-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {handleRouteEta,chooseClosestPair} from '../src/handlers/routeEta';
import {resetRouteGeocoderForTests} from '../src/handlers/routeGeocoder';
// Geocoder bodies are the recorded raw bodies stored in the three live receipts (rcpt_PSOP4RH01UEGWV3W5L607DGX8L London,
// rcpt_29W8DKOK7NCGLQ1U10EFCFAZP3 JFK, rcpt_R8T584DWEM7MYQ58OBKEKKD49O Zocalo), fetched from their /receipts/<id>/raw on 2026-11-27.
// The OSRM body is SYNTHETIC: it echoes the requested coordinates as snapped points, so only endpoint choice is under test.
const fx=(n:string)=>JSON.parse(readFileSync(join(__dirname,'fixtures/route-eta-pair',n+'.json'),'utf8')) as {geocoders:{url:string;raw_body:string}[]};
const bodies=new Map<string,string>();for(const n of ['london','jfk','zocalo'])for(const g of fx(n).geocoders)bodies.set(g.url,g.raw_body);
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime('2026-11-27T01:00:00Z');resetRouteGeocoderForTests();});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();resetRouteGeocoderForTests();});afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
function stub(over:Record<string,string>={}){const calls:string[]=[];
 vi.stubGlobal('fetch',async(u:unknown)=>{const s=String(u);const url=new URL(s);
  if(url.hostname==='router.project-osrm.org'){calls.push('OSRM');const mm=/driving\/([^;]+);([^?]+)\?/.exec(url.pathname+'?')!;const [a,b]=[mm[1],mm[2]].map(x=>x.split(',').map(Number));
   return new Response(JSON.stringify({code:'Ok',routes:[{duration:900,distance:7000}],waypoints:[{location:a,distance:1},{location:b,distance:1}]}));}
  calls.push(url.hostname.startsWith('photon')?'PH:'+url.searchParams.get('q'):'OM:'+url.searchParams.get('name'));
  const b=over[s]??bodies.get(s);if(b===undefined)throw new Error('no recorded body for '+s);return new Response(b);});return calls;}
const run=async(q:Record<string,string>)=>{const p=handleRouteEta(q).then(v=>({ok:true as const,v}),e=>({ok:false as const,e}));await vi.advanceTimersByTimeAsync(20000);return p;};
const km=(a:number[],b:number[])=>{const r=Math.PI/180,x=Math.sin((b[0]-a[0])*r/2)**2+Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin((b[1]-a[1])*r/2)**2;return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(x<1?1-x:0));};
const coords=(v:any)=>[v.origin,v.destination].map((s:string)=>s.split(',').map(Number));
const OM_ONE=(name:string,lat:number,lon:number)=>JSON.stringify({results:[{name,latitude:lat,longitude:lon,country:'Testland',admin1:'Test',country_code:'TL',feature_code:'PPL'}]});
const ESB=[40.7484421,-73.9856589];
it('London pair: coordinates are exactly the rank-1 choices of the recorded receipt',async()=>{
 stub();const r:any=await run({origin:'Tower of London',destination:'Buckingham Palace'});expect(r.ok).toBe(true);
 expect(r.v.origin).toBe('51.50773,-0.07545');expect(r.v.destination).toBe('51.5008349,-0.1430045');
 const rec=JSON.parse(readFileSync(join(__dirname,'fixtures/route-eta-pair/london.json'),'utf8'));expect(rec.origin).toBe(r.v.origin);expect(rec.destination).toBe(r.v.destination);
 expect(String(r.v.answer)).toContain('closest pair');expect(String(r.v.answer)).toContain('not confirmed unique');
});
it('JFK pair: the airport side resolves within 25 km of the Empire State Building, not the employee parking lot',async()=>{
 stub();const r:any=await run({origin:'Empire State Building',destination:'JFK Airport'});expect(r.ok).toBe(true);
 const [o,d]=coords(r.v);expect(o).toEqual(ESB);expect(km(ESB,d)).toBeLessThan(25);
 expect(r.v.destination).not.toBe('40.6620091,-73.8220484');
 const a=String(r.v.answer);expect(a).toContain('chose the closest pair among 5 x 5 candidates');expect(a).toContain('great-circle');expect(a).toContain('not confirmed unique');
 expect(a).toContain('Empire State Building');expect(a).toContain('JFK Airport');
});
it('Zocalo and Chapultepec both resolve to Mexico City, not a Guerrero village and an Illinois supermarket',async()=>{
 stub();const r:any=await run({origin:'Zocalo',destination:'Chapultepec Park'});expect(r.ok).toBe(true);
 const MEXICO_CITY=[19.4326,-99.1332];const [o,d]=coords(r.v);expect(km(MEXICO_CITY,o)).toBeLessThan(10);expect(km(MEXICO_CITY,d)).toBeLessThan(10);
 const a=String(r.v.answer);expect(a).toContain('Mexico City');expect(a).not.toContain('Illinois');expect(a).not.toContain('Guerrero');
 expect(a).toContain('chose the closest pair among 5 x 3 candidates');
});
it('uses only candidates already fetched: no extra geocoder call beyond the two queries per side',async()=>{
 const calls=stub();await run({origin:'Zocalo',destination:'Chapultepec Park'});
 expect(calls.filter(c=>c==='OSRM')).toHaveLength(1);expect(calls.filter(c=>c.startsWith('OM:'))).toHaveLength(2);expect(calls.filter(c=>c.startsWith('PH:'))).toHaveLength(2);
});
it('NEGATIVE: a unique match on both sides is unchanged, with the original rank 1 disclosure and no pair wording',async()=>{
 const u1='https://geocoding-api.open-meteo.com/v1/search?name=Alphaville&count=10&language=en&format=json',u2='https://geocoding-api.open-meteo.com/v1/search?name=Betaville&count=10&language=en&format=json';
 stub({[u1]:OM_ONE('Alphaville',10,20),[u2]:OM_ONE('Betaville',11,21)});
 const r:any=await run({origin:'Alphaville',destination:'Betaville'});expect(r.ok).toBe(true);
 expect(r.v.origin).toBe('10,20');expect(r.v.destination).toBe('11,21');
 const a=String(r.v.answer);expect(a).toContain('of 1 matches returned by Open-Meteo (rank 1, provider order; not confirmed unique)');expect(a).not.toContain('closest pair');
});
it('one side is a coordinate: it stays fixed and the ambiguous side takes the candidate nearest to it, disclosed',async()=>{
 stub();const r:any=await run({origin:'40.7484421,-73.9856589',destination:'JFK Airport'});expect(r.ok).toBe(true);
 const [o,d]=coords(r.v);expect(o).toEqual(ESB);expect(km(ESB,d)).toBeLessThan(25);
 const a=String(r.v.answer);expect(a).toContain('coordinates given directly');expect(a).toContain('chose the closest pair among 1 x 5 candidates');
});
it('one side is a unique named match: it stays fixed, the other side picks the nearest candidate',async()=>{
 const u='https://geocoding-api.open-meteo.com/v1/search?name=Esbville&count=10&language=en&format=json';
 stub({[u]:OM_ONE('Esbville',ESB[0],ESB[1])});
 const r:any=await run({origin:'Esbville',destination:'JFK Airport'});expect(r.ok).toBe(true);
 const [o,d]=coords(r.v);expect(o).toEqual(ESB);expect(km(ESB,d)).toBeLessThan(25);
 const a=String(r.v.answer);expect(a).toContain('Origin: chose Esbville');expect(a).toContain('of 1 matches returned by Open-Meteo (rank 1, provider order; not confirmed unique)');expect(a).toContain('closest pair among 1 x 5');
});
const pt=(lat:number,lon:number,rank:number,label='x')=>({latitude:lat,longitude:lon,label,rank,provider:'Photon'});
const rp=(cands:any[],lat=0,lon=0)=>({lat,lon,label:'L',selection:'S',geocoders:[],candidates:cands,count:cands.length,provider:'Photon'});
it('tie-break: equal distance goes to the better provider rank (rank sum, then origin rank)',()=>{
 const o=rp([pt(0,0,1,'o1'),pt(0,2,2,'o2')]);const d=rp([pt(0,1,1,'d1'),pt(0,1,2,'d2')]);
 // o1-d1, o1-d2, o2-d1, o2-d2 are all 1 degree apart or the same: o1/d1 (rank sum 2) wins
 const r=chooseClosestPair(o,d);expect(r.o.lat).toBe(0);expect(r.o.lon).toBe(0);expect(r.d.lon).toBe(1);expect(r.o.selection).toContain('Photon rank 1');expect(r.d.selection).toContain('Photon rank 1');
});
it('tie-break: rank sums tie, only the origin rank decides',()=>{
 const o=rp([pt(0,0,1,'o1'),pt(0,2,2,'o2')]);const d=rp([pt(0,3,1,'d1'),pt(0,-1,2,'d2')]);
 // o1-d2 and o2-d1 are both 1 degree apart and both have rank sum 3: the pair with origin rank 1 wins
 const r=chooseClosestPair(o,d);expect(r.o.lon).toBe(0);expect(r.d.lon).toBe(-1);expect(r.o.selection).toContain('Photon rank 1');expect(r.d.selection).toContain('Photon rank 2');
});
it('two fixed sides (one candidate each) are returned untouched',()=>{
 const o=rp([pt(1,1,1)]),d=rp([pt(2,2,1)]);const r=chooseClosestPair(o,d);expect(r.o).toBe(o);expect(r.d).toBe(d);
 const c=rp([],5,5);const r2=chooseClosestPair(c,d);expect(r2.o).toBe(c);expect(r2.d).toBe(d);
});
