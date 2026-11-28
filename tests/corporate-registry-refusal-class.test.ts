// CORPORATE_REGISTRY_LOOKUP_GENERAL refusal-label logging. Replays the real
// GLEIF captures in tests/fixtures/corporate-gleif (provenance: docs/corporate-gleif.md);
// the only synthetic inputs are secret sentinels that must never reach a log.
import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/corp-refusal-test-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {recordRequestCompletion,diagnosticErrorCode} from '../src/core/requestMetrics';
import {refusalParamClass,jurisdictionClass,companyLengthBucket,companyShape,REFUSAL_INTENTS} from '../src/core/refusalClass';
import {parseGleif,resetGleifForTests} from '../src/handlers/gleifRegistry';
let lines:string[];
beforeEach(()=>{lines=[];vi.spyOn(console,'info').mockImplementation((m:unknown)=>{lines.push(String(m));});resetGleifForTests();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();resetGleifForTests();});
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
const parsed=()=>lines.map(l=>JSON.parse(l));
const refusal=()=>parsed().filter(o=>o.event==='refusal_param_class');
const run=(status:number,errorCode:string,query:Record<string,unknown>,errorLabel?:string)=>recordRequestCompletion('/v1/corporate-registry',status,5,{query,errorCode,errorLabel});
const raw=(key:string)=>readFileSync(join(__dirname,'fixtures/corporate-gleif',key+'.json'),'utf8');

it('the route is registered for the refusal class line',()=>{
 expect(REFUSAL_INTENTS['/v1/corporate-registry']).toBe('CORPORATE_REGISTRY_LOOKUP_GENERAL');
});
it('the route error codes are diagnostic codes, no longer OTHER_ERROR',()=>{
 for(const code of ['AMBIGUOUS_COMPANY','INVALID_JURISDICTION','GLEIF_UNAVAILABLE','SEC_UNAVAILABLE','EDGAR_BAD_BODY','COMPANY_TOO_LONG'])expect(diagnosticErrorCode(code)).toBe(code);
 expect(diagnosticErrorCode('GLEIF_DOWN')).toBe('OTHER_ERROR');
});
it.each([
 ['US','us_alias'],['usa','us_alias'],['United States','us_alias'],['U.S.','us_alias'],['america','us_alias'],
 ['GB','iso2'],['de','iso2'],['UK','iso2'],
 ['US-CA','iso_with_subdivision'],['de-11','iso_with_subdivision'],
 ['Germany','english_name'],['United Kingdom','english_name'],
 ['123','other'],['','other'],[undefined,'other'],
])('jurisdiction class of %s is %s',(v,t)=>expect(jurisdictionClass(v as string|undefined)).toBe(t));
it.each([
 [0,'<=20'],[20,'<=20'],[21,'21-60'],[60,'21-60'],[61,'61-120'],[120,'61-120'],[121,'>120'],[500,'>120'],
])('a company of length %i falls in bucket %s',(n,b)=>expect(companyLengthBucket('x'.repeat(n))).toBe(b));
it.each([
 ['0000320193','cik_digits'],['320193','cik_digits'],
 ['AAPL','ticker_like'],['BRK.B','ticker_like'],
 ['Apple Inc','has_legal_suffix'],['Société Générale SA','has_legal_suffix'],
 ['Société Générale','has_non_ascii'],
 ['Acme Holdings','other'],['Tesco','other'],['','other'],[undefined,'other'],
])('company shape of %s is %s',(v,t)=>expect(companyShape(v as string|undefined)).toBe(t));
it('refusalParamClass returns only closed labels, ambiguity_reason only from the fixed label',()=>{
 const q={company:'Secret Name Zq9 Holdings',jurisdiction:'Atlantis'};
 expect(refusalParamClass('/v1/corporate-registry','AMBIGUOUS_COMPANY',q)).toEqual({jurisdiction_class:'english_name',company_length_bucket:'21-60',company_shape:'other'});
 expect(refusalParamClass('/v1/corporate-registry','AMBIGUOUS_COMPANY',q,'multi_exact')).toMatchObject({ambiguity_reason:'multi_exact'});
 expect(refusalParamClass('/v1/corporate-registry','AMBIGUOUS_COMPANY',q,'page_incomplete')).toMatchObject({ambiguity_reason:'page_incomplete'});
 expect(refusalParamClass('/v1/corporate-registry','AMBIGUOUS_COMPANY',q,'raw branch text 198.51.100.9')).toEqual({jurisdiction_class:'english_name',company_length_bucket:'21-60',company_shape:'other'});
 expect(refusalParamClass('/v1/corporate-registry','GLEIF_UNAVAILABLE',{company:'AAPL',jurisdiction:'US'})).toEqual({jurisdiction_class:'us_alias',company_length_bucket:'<=20',company_shape:'ticker_like'});
 expect(refusalParamClass('/v1/corporate-registry','X',undefined)).toEqual({jurisdiction_class:'other',company_length_bucket:'<=20',company_shape:'other'});
});
it('a logged 422 carries the fixed labels and never the company or jurisdiction text',()=>{
 run(422,'AMBIGUOUS_COMPANY',{company:'Secret Name Zq9 Holdings',jurisdiction:'Atlantis'},'multi_exact');
 const r=refusal();expect(r).toHaveLength(1);
 expect(r[0]).toMatchObject({intent:'CORPORATE_REGISTRY_LOOKUP_GENERAL',error_code:'AMBIGUOUS_COMPANY',status:'422',jurisdiction_class:'english_name',company_length_bucket:'21-60',company_shape:'other',ambiguity_reason:'multi_exact'});
 const all=lines.join('\n');for(const bad of ['Secret','Zq9','Holdings','Atlantis'])expect(all).not.toContain(bad);
 expect(parsed().some(o=>o.event==='request_complete'&&o.error_code==='AMBIGUOUS_COMPANY')).toBe(true);
});
it('a 200 answer and a missing label log no class line and no reason',()=>{
 run(200,'',{company:'AAPL',jurisdiction:'US'});
 run(502,'GLEIF_UNAVAILABLE',{company:'AAPL',jurisdiction:'US'});
 const r=refusal();expect(r).toHaveLength(1);
 expect(r[0]).toMatchObject({error_code:'GLEIF_UNAVAILABLE',jurisdiction_class:'us_alias',company_shape:'ticker_like'});
 expect(r[0]).not.toHaveProperty('ambiguity_reason');
});
it('a throwing sink cannot break the request path',()=>{
 vi.restoreAllMocks();vi.spyOn(console,'info').mockImplementation(()=>{throw new Error('sink down');});
 expect(()=>run(422,'AMBIGUOUS_COMPANY',{company:'x',jurisdiction:'GB'},'multi_exact')).not.toThrow();
});
it('parseGleif tags both ambiguity branches with the fixed internal label',()=>{
 const j=JSON.parse(raw('tesco'));j.data.push(j.data[0]);j.meta.pagination.total++;
 try{parseGleif(JSON.stringify(j),'TESCO PLC','GB');expect.unreachable();}catch(e){expect(e).toMatchObject({code:'AMBIGUOUS_COMPANY',logLabel:'multi_exact'});}
 const partial=JSON.parse(raw('tesco'));partial.meta.pagination.total=200;
 try{parseGleif(JSON.stringify(partial),'TESCO PLC','GB');expect.unreachable();}catch(e){expect(e).toMatchObject({code:'AMBIGUOUS_COMPANY',logLabel:'page_incomplete'});}
});
it('end to end through the server: both ambiguity branches log their reason; the client error is unchanged',async()=>{
 const {buildServer}=await import('../src/server');
 const dup=JSON.parse(raw('tesco'));dup.data.push(dup.data[0]);dup.meta.pagination.total++;
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(dup)));
 const app=buildServer();
 let a;try{a=await app.inject('/v1/corporate-registry?company=TESCO%20PLC&jurisdiction=GB');}finally{await app.close();}
 expect(a.statusCode).toBe(422);
 const body=a.json();expect(body.code).toBe('AMBIGUOUS_COMPANY');expect(body).not.toHaveProperty('logLabel');
 let r=refusal();expect(r).toHaveLength(1);
 expect(r[0]).toMatchObject({intent:'CORPORATE_REGISTRY_LOOKUP_GENERAL',error_code:'AMBIGUOUS_COMPANY',status:'422',jurisdiction_class:'iso2',company_shape:'has_legal_suffix',ambiguity_reason:'multi_exact'});
 resetGleifForTests();lines.length=0;
 const partial=JSON.parse(raw('tesco'));partial.meta.pagination.total=200;
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(partial)));
 const app2=buildServer();
 let b;try{b=await app2.inject('/v1/corporate-registry?company=TESCO%20PLC&jurisdiction=GB');}finally{await app2.close();}
 expect(b.statusCode).toBe(422);expect(b.json().code).toBe('AMBIGUOUS_COMPANY');
 r=refusal();expect(r).toHaveLength(1);
 expect(r[0]).toMatchObject({error_code:'AMBIGUOUS_COMPANY',ambiguity_reason:'page_incomplete'});
 expect(lines.join('\n')).not.toContain('TESCO');
});
