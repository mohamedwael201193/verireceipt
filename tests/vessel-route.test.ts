import {readFileSync,rmSync} from 'node:fs';
import {afterAll,afterEach,it,expect,vi} from 'vitest';
const fixture=vi.hoisted(()=>{process.env.SQLITE_PATH='/tmp/vr-vessel-route-'+process.pid+'.sqlite';delete process.env.DATABASE_URL;return{path:process.env.SQLITE_PATH};});
vi.mock('../src/core/storage',async original=>({...await original<typeof import('../src/core/storage')>(),saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt,closeStorage} from '../src/core/storage';
import {buildServer} from '../src/server';
import {VESSEL_SOURCE_APPROVAL} from '../src/handlers/vesselWired';
const raw=readFileSync(new URL('./fixtures/vessel-ais/barentswatch-position-20261125.json',import.meta.url),'utf8');
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
afterAll(async()=>{await closeStorage();for(const s of['','-wal','-shm'])rmSync(fixture.path+s,{force:true});});
it('enabled vessel source records risk acceptance without licence permission',()=>{expect(VESSEL_SOURCE_APPROVAL).toMatchObject({commercialUse:false,redistribution:false,ownerRiskAcceptance:{sourceReference:'owner-risk-acceptance-2026-11-23',scope:'testnet-hackathon'}});});
it('route rejects missing/name/IMO and URL inputs before network',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);const app=buildServer();try{for(const tail of['','?vessel=ROSE','?vessel=9710414','?vessel=https%3A%2F%2Finvalid.test']){const r=await app.inject({method:'GET',url:'/v1/vessel-telemetry'+tail});expect(r.statusCode).toBe(400);}expect(f).not.toHaveBeenCalled();expect(saveReceipt).not.toHaveBeenCalled();}finally{await app.close();}});
it('route replays actual decoded event with canonical numeric fields and persistence',async()=>{
 const f=vi.fn(async()=>new Response('data: '+raw.replace(/\n/g,'')+'\n\n',{headers:{'content-type':'text/event-stream'}}));vi.stubGlobal('fetch',f);const app=buildServer();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-25T01:45:00Z'));
 try{const r=await app.inject({method:'GET',url:'/v1/vessel-telemetry?vessel=257635500'});expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({vessel:'257635500',speed_knots:0,latitude:59.590720000000005,longitude:5.154825,course_deg:203.8,observed_at:'2026-11-25T01:44:57.8644366Z',synthesized:true});expect(r.json().answer).toContain('Data delivered by BarentsWatch.');expect(saveReceipt).toHaveBeenCalledTimes(1);expect(f.mock.calls[0][0]).toBe('https://ais.openwaters.io/v1/stream?mmsi=257635500&snapshot=1');}finally{vi.restoreAllMocks();await app.close();}
});
it('source failure gives refusal, never fabricated zero speed or receipt',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('unavailable',{status:503})));const app=buildServer();try{const r=await app.inject({method:'GET',url:'/v1/vessel-telemetry?vessel=257635500'});expect(r.statusCode).toBe(502);expect(r.json().code).toBe('APPROVED_SOURCES_UNAVAILABLE');expect(saveReceipt).not.toHaveBeenCalled();}finally{await app.close();}});
