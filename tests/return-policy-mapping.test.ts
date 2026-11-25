import{afterEach,expect,it,vi}from'vitest';import{readFileSync}from'node:fs';import{load}from'js-yaml';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{}),storageBackend:()=> 'postgres'}));
import{buildServer}from'../src/server';import{FIELD_FORMAT,OUTPUT_MAPPING,readPath,valueMatchesFormat,reconcileShaped}from'../src/core/shapedFields';
const intent='RETURN_POLICY_VERIFY_GENERAL';const yaml=load(readFileSync('miner.yaml','utf8'))as any;const raw=readFileSync('tests/fixtures/return-policy/apple.html','utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('maps only canonical retailer input and all official fields, preserving narrow scope',()=>{
 const m=yaml.intent_mapping[intent];expect(m.endpoint).toBe('/v1/return-policy');expect(m.input).toEqual({retailer:{from:'retailer'}});expect(Object.keys(m.output)).toEqual(['retailer','return_window_days','conditions','verified','sources']);expect(m.output.return_window_days).toEqual({path:'return_window_days',unit:'days'});
 const e=yaml.endpoints.find((e:any)=>e.path===m.endpoint);expect(e.params.query.required.map((p:any)=>p.name)).toEqual(['retailer']);expect(e.description).toContain('Not item or order eligibility');expect(e.description).toContain('standard return policy only');expect(e.description).toContain('Apple US or Walmart US');
});
it('native real-page response serves all mapped fields but does not backfill scored number from raw',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-11-24T17:00:00Z'));vi.stubGlobal('fetch',async()=>new Response(raw));const app=await buildServer();
 try{const r=await app.inject({method:'GET',url:'/v1/return-policy?retailer=Apple%20US'});expect(r.statusCode).toBe(200);const out=r.json();expect(out.scope).toContain('not a decision about a particular item');expect(out.answer).toContain('January 8, 2027');
 for(const[field,mapping]of Object.entries(OUTPUT_MAPPING[intent]))expect(valueMatchesFormat(readPath(out,mapping.path),FIELD_FORMAT[intent][field],field),field).toBe(true);
 const shaped=reconcileShaped({intent,result:{},field_status:{return_window_days:'unavailable',verified:'unavailable'}},out,{rawVerified:true});expect(shaped.return_window_days.value).toBeNull();expect(shaped.verified.value).toBe(true);
 }finally{await app.close();}
});
it('unsupported retailer remains refusal and never uses another retailer policy',async()=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const app=await buildServer();try{const r=await app.inject({method:'GET',url:'/v1/return-policy?retailer=Apple%20UK'});expect(r.statusCode).toBe(200);expect(r.json().verified).toBe(false);expect(r.json().sources).toEqual([]);expect(f).not.toHaveBeenCalled();}finally{await app.close();}
});
