import {afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {load} from 'js-yaml';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{}),storageBackend:()=> 'postgres'}));
import {buildServer} from '../src/server';
import {OUTPUT_MAPPING,FIELD_FORMAT,valueMatchesFormat,readPath,reconcileShaped} from '../src/core/shapedFields';
const intent='VESSEL_TELEMETRY_VERIFY_GENERAL',yaml=load(readFileSync('miner.yaml','utf8')) as any;
const raw=readFileSync('tests/fixtures/vessel-ais/barentswatch-position-20261125.json','utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it('keeps unverified runtime available without registering its intent',()=>{expect(yaml.semantics.supported_intents).not.toContain(intent);expect(yaml.intent_mapping[intent]).toBeUndefined();expect(yaml.endpoints.some((e:any)=>e.path==='/v1/vessel-telemetry')).toBe(false);});
it('real route response satisfies declared numeric/datetime mirrors without numeric raw backfill',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-25T01:45:00Z'));vi.stubGlobal('fetch',async()=>new Response('data: '+raw.replace(/\n/g,'')+'\n\n',{headers:{'content-type':'text/event-stream'}}));
 const app=buildServer();try{const response=await app.inject({method:'GET',url:'/v1/vessel-telemetry?vessel=257635500'});expect(response.statusCode).toBe(200);const out=response.json();expect(out.speed_knots).toBe(0);
 for(const[field,m]of Object.entries(OUTPUT_MAPPING[intent]))expect(valueMatchesFormat(readPath(out,m.path),FIELD_FORMAT[intent][field],field)).toBe(true);
 for(const field of['speed_knots','latitude','longitude','course_deg']){const shaped=reconcileShaped({intent,result:{},field_status:{[field]:'unavailable'}},out,{rawVerified:true});expect(shaped[field].value).toBeNull();}
 }finally{await app.close();}
});
