import {readFileSync,rmSync} from 'node:fs';
import {afterAll,afterEach,it,expect,vi} from 'vitest';
const fixture=vi.hoisted(()=>{process.env.SQLITE_PATH='/tmp/vr-buoy-route-'+process.pid+'.sqlite';delete process.env.DATABASE_URL;return{path:process.env.SQLITE_PATH};});
vi.mock('../src/core/storage',async original=>({...await original<typeof import('../src/core/storage')>(),saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt,closeStorage} from '../src/core/storage';
import {buildServer} from '../src/server';
import {BUOY_SOURCE_APPROVAL} from '../src/handlers/buoyWired';
const raw=readFileSync('tests/fixtures/ndbc/44013-20261125.txt','utf8'),meta=readFileSync('tests/fixtures/ndbc/44013-metadata.html','utf8');
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
afterAll(async()=>{await closeStorage();for(const s of['','-wal','-shm'])rmSync(fixture.path+s,{force:true});});
it('buoy terms are recorded without fabricated licence permission',()=>expect(BUOY_SOURCE_APPROVAL).toMatchObject({commercialUse:false,redistribution:false,ownerRiskAcceptance:{scope:'testnet-hackathon',sourceReference:'owner-risk-acceptance-2026-11-23'}}));
it('unsupported/missing input400before network',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);const app=buildServer();try{for(const tail of['','?sensor=NDBC:44013','?sensor=other&metric=water_temperature','?sensor=NDBC:44013&metric=temperature','?sensor=https%3A%2F%2Finvalid.test&metric=water_temperature'])expect((await app.inject({method:'GET',url:'/v1/sensor-telemetry'+tail})).statusCode).toBe(400);expect(f).not.toHaveBeenCalled();expect(saveReceipt).not.toHaveBeenCalled();}finally{await app.close();}});
it('all server builds and metrics share one source instance, preserve evidence and fail closed on stale/outage',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-25T01:55:00Z'));const f=vi.fn(async(url:string)=>new Response(url.includes('station_page')?meta:raw));vi.stubGlobal('fetch',f);const app=buildServer(),other=buildServer();
 try{
  const url='/v1/sensor-telemetry?sensor=NDBC:44013&metric=';
  const[a,b]=await Promise.all([app.inject({method:'GET',url:url+'water_temperature'}),other.inject({method:'GET',url:url+'air_temperature'})]);expect(a.statusCode).toBe(200);expect(b.statusCode).toBe(200);expect(a.json()).toMatchObject({sensor:'NDBC:44013',metric:'water_temperature',value:11.4,unit:'degC',observed_at:'2026-11-25T01:00:00.000Z'});expect(b.json().value).toBe(5.5);expect(a.json().answer).toContain('automated gross-error checks only');expect(saveReceipt).toHaveBeenCalledTimes(2);expect(f).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date('2026-11-25T02:10:00Z'));expect((await other.inject({method:'GET',url:url+'water_temperature'})).statusCode).toBe(200);expect(f).toHaveBeenCalledTimes(2);const e=JSON.parse(vi.mocked(saveReceipt).mock.calls[2][1]);expect(e.fetched_at).toBe('2026-11-25T01:55:00.000Z');
  vi.setSystemTime(new Date('2026-11-25T02:30:00.001Z'));expect((await app.inject({method:'GET',url:url+'water_temperature'})).statusCode).toBe(502);expect(f).toHaveBeenCalledTimes(2);expect(saveReceipt).toHaveBeenCalledTimes(3);
  vi.setSystemTime(new Date('2026-11-25T02:55:00Z'));f.mockImplementation(async()=>new Response('unavailable',{status:503}));expect((await app.inject({method:'GET',url:url+'water_temperature'})).statusCode).toBe(502);expect((await other.inject({method:'GET',url:url+'air_temperature'})).statusCode).toBe(502);expect(f).toHaveBeenCalledTimes(4);expect(saveReceipt).toHaveBeenCalledTimes(3);
 }finally{await app.close();await other.close();}
});
