import {afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {load} from 'js-yaml';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{}),storageBackend:()=> 'postgres'}));
import {buildServer} from '../src/server';
import {OUTPUT_MAPPING,FIELD_FORMAT,valueMatchesFormat,readPath,reconcileShaped} from '../src/core/shapedFields';
const intent='CRYPTO_YIELD_RATE_GENERAL';
const yaml=load(readFileSync('miner.yaml','utf8')) as any;
const capture=JSON.parse(readFileSync('tests/fixtures/aave-yield/usdc-safe-20261125.json','utf8'));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it('declares the three canonical inputs and one scored numeric field in basis points',()=>{
 const mapping=yaml.intent_mapping[intent];expect(mapping.endpoint).toBe('/v1/yield');expect(mapping.input).toEqual({project:{from:'project'},symbol:{from:'symbol'},chain:{from:'chain'}});expect(mapping.output).toEqual({supply_apy:{path:'supply_apy',unit:'basis points'}});
 const endpoint=yaml.endpoints.find((e:any)=>e.path===mapping.endpoint);expect(endpoint.params.query.required.map((p:any)=>p.name)).toEqual(['project','symbol','chain']);expect(endpoint.description).toContain('Safe-head is not finalized');expect(endpoint.description).toContain('15 minutes');
});
it('real captured safe rate replays native HTTP route and canonical numeric mirror without raw backfill',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(capture.fetched_at));
 vi.stubGlobal('fetch',async(url:unknown,init?:RequestInit)=>{
  const request=JSON.parse(String(init?.body));const leg=capture.results.find((l:any)=>l.endpoint===String(url));const row=leg?.raw.find((r:any)=>r.method===request.method&&JSON.stringify(r.params)===JSON.stringify(request.params));if(!row)throw Error('uncaptured source');return new Response(row.body,{status:row.status});
 });
 const app=buildServer();try{
  const response=await app.inject({method:'GET',url:'/v1/yield?project=aave-v3&symbol=USDC&chain=ethereum'});expect(response.statusCode).toBe(200);const out=response.json();expect(out.supply_apy).toBe(269);expect(out.yield_components).toContain('not finalized');
  for(const [field,mapping] of Object.entries(OUTPUT_MAPPING[intent]))expect(valueMatchesFormat(readPath(out,mapping.path),FIELD_FORMAT[intent][field],field)).toBe(true);
  const shaped=reconcileShaped({intent,result:{},field_status:{supply_apy:'unavailable'}},out,{rawVerified:true});expect(shaped.supply_apy.value).toBeNull();
 }finally{await app.close();}
});
it('missing project or unsupported protocol is refused instead of substituting Aave',async()=>{
 const app=buildServer();try{
  expect((await app.inject({method:'GET',url:'/v1/yield?symbol=USDC&chain=ethereum'})).statusCode).toBe(400);
  expect((await app.inject({method:'GET',url:'/v1/yield?project=compound&symbol=USDC&chain=ethereum'})).statusCode).toBe(502);
 }finally{await app.close();}
});
