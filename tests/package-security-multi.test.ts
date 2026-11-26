import {afterAll,afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/package-security-multi-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {parseSecurityTarget,parsePackageAdvisories,parseVulnRecord,handlePackageSecurity,targetShapeOf,resetPackageSecurityForTests} from '../src/handlers/packageSecurity';
import {getReceiptEvidence} from '../src/core/storage';
import {buildServer} from '../src/server';
const fx=(n:string)=>readFileSync(join(__dirname,'fixtures/osv-package',n),'utf8');
const py=fx('requests-2.19.0.json'),cve=fx('CVE-2022-25883.json'),ghsa=fx('GHSA-c2qf-rxjj-qqgw.json'),semver=fx('semver-7.5.1.json');
const NF='{"code":5,"message":"Vulnerability not found"}';
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));afterEach(()=>vi.unstubAllGlobals());beforeEach(()=>resetPackageSecurityForTests());
describe('target classification',()=>{
 it.each([
  ['npm:semver@7.5.1','package','npm'],['pip:requests@2.19.0','package','pypi'],['PyPI:Requests@2.19.0rc1','package','pypi'],['pypi:requests@2.19.0.post1','package','pypi'],
  ['semver@7.5.1','package','other'],['CVE-2022-25883','id','cve'],['cve-2022-25883','id','cve'],['GHSA-c2qf-rxjj-qqgw','id','ghsa'],['ghsa-C2QF-rxjj-qqgw','id','ghsa'],
  ['https://github.com/a/b','unsupported','url'],['cargo:serde@1.0.0','unsupported','other'],['maven:org.x:y@1.0','unsupported','other'],
 ])('%s',(t,kind,shape)=>{const r:any=parseSecurityTarget(t);expect(r.kind).toBe(kind);expect(r.shape).toBe(shape);});
 it('normalises ids and orders bare ecosystems npm first',()=>{
  expect(parseSecurityTarget('cve-2022-25883')).toMatchObject({id:'CVE-2022-25883'});expect(parseSecurityTarget('GHSA-C2QF-RXJJ-QQGW')).toMatchObject({id:'GHSA-c2qf-rxjj-qqgw'});
  expect(parseSecurityTarget('semver@7.5.1')).toMatchObject({ecosystems:['npm','PyPI']});expect(parseSecurityTarget('Django@3.0.0')).toMatchObject({ecosystems:['PyPI']});
 });
 it.each(['','lodash','npm:semver@^7.5.1','pip:requests@>=2','pip:requests@2.*','pip:requests@1!2.0','pip:requests@2.0+local','semver@1.2','CVE-22-1','GHSA-zzzz-zzzz-zzzz',' semver@7.5.1','x'.repeat(257),undefined])('keeps %j a 400 INVALID_TARGET with no lookup',async t=>{
  expect(()=>parseSecurityTarget(t as any)).toThrow(expect.objectContaining({status:400,code:'INVALID_TARGET'}));
  const f=vi.fn();vi.stubGlobal('fetch',f);await expect(handlePackageSecurity({target:t as any})).rejects.toMatchObject({status:400,code:'INVALID_TARGET'});expect(f).not.toHaveBeenCalled();
 });
 it('shape labels never contain the value',()=>{for(const t of ['npm:semver@7.5.1','pip:a@1.0','CVE-2022-25883','GHSA-c2qf-rxjj-qqgw','https://secret.example/x','cargo:secretname@1.0.0','zzz',undefined])expect(['npm','pypi','cve','ghsa','url','other']).toContain(targetShapeOf(t));});
});
describe('PyPI',()=>{
 it('parses the real PyPI record and confirms ranges locally, PEP 503 names',()=>{
  const a=parsePackageAdvisories(py,'requests','2.19.0','PyPI');expect(a.length).toBeGreaterThan(3);expect(a.some(x=>x.versionEvidence==='locally confirmed version range')).toBe(true);
  expect(parsePackageAdvisories(py,'Requests','2.19.0','PyPI')).toHaveLength(a.length);
  expect(()=>parsePackageAdvisories(py,'requests','2.19.0','npm')).toThrow();
 });
 it('rejects a PyPI record whose release is outside every range',()=>expect(()=>parsePackageAdvisories(py,'requests','2.99.0','PyPI')).toThrow());
 it('queries OSV with ecosystem PyPI and persists raw evidence',async()=>{
  const f=vi.fn(async(_u:unknown,o:any)=>{expect(JSON.parse(o.body)).toEqual({package:{name:'requests',ecosystem:'PyPI'},version:'2.19.0'});expect(o.redirect).toBe('error');return new Response(py);});vi.stubGlobal('fetch',f);
  const r:any=await handlePackageSecurity({target:'pip:requests@2.19.0'});expect(r.ecosystem).toBe('PyPI');expect(r.vulnerability_count).toBeGreaterThan(3);expect(r.verdict).toBe('Needs changes');expect(r.answer).toContain('PyPI requests@2.19.0');expect(r.answer).not.toContain('https://');
  expect(JSON.parse((await getReceiptEvidence(r.receipt.receipt_id)).evidence!.toString()).source_raw_body).toBe(py);
 });
 it('pypi and npm results for one name never share a cache entry',async()=>{
  const f=vi.fn(async(_u:unknown,o:any)=>new Response(JSON.parse(o.body).package.ecosystem==='npm'?semver:py));vi.stubGlobal('fetch',f);
  await handlePackageSecurity({target:'npm:semver@7.5.1'});await handlePackageSecurity({target:'pypi:semver@7.5.1'}).catch(()=>{});
  expect(f.mock.calls.map((c:any)=>JSON.parse(c[1].body).package.ecosystem)).toEqual(['npm','PyPI']);
 });
});
describe('bare name@x.y.z',()=>{
 it('tries npm then PyPI and reports the ecosystem that answered',async()=>{
  const f=vi.fn(async(_u:unknown,o:any)=>new Response(JSON.parse(o.body).package.ecosystem==='npm'?'{}':py));vi.stubGlobal('fetch',f);
  const r:any=await handlePackageSecurity({target:'requests@2.19.0'});expect(f.mock.calls.map((c:any)=>JSON.parse(c[1].body).package.ecosystem)).toEqual(['npm','PyPI']);expect(r.ecosystem).toBe('PyPI');
  expect(JSON.parse((await getReceiptEvidence(r.receipt.receipt_id)).evidence!.toString()).ecosystems_tried).toEqual(['npm','PyPI']);
 });
 it('stops at npm when npm answers',async()=>{const f=vi.fn(async()=>new Response(semver));vi.stubGlobal('fetch',f);const r:any=await handlePackageSecurity({target:'semver@7.5.1'});expect(r.ecosystem).toBe('npm');expect(f).toHaveBeenCalledTimes(1);});
 it('both empty is the existing 422, never Secure',async()=>{vi.stubGlobal('fetch',async()=>new Response('{}'));await expect(handlePackageSecurity({target:'nothing-here-zz@9.9.9'})).rejects.toMatchObject({status:422,code:'NO_ADVISORY_COVERAGE'});});
 it('npm source failure is not masked by trying PyPI',async()=>{const f=vi.fn(async()=>new Response('x',{status:503}));vi.stubGlobal('fetch',f);await expect(handlePackageSecurity({target:'broken-zz@1.0.0'})).rejects.toMatchObject({status:502,code:'OSV_UNAVAILABLE'});expect(f).toHaveBeenCalledTimes(1);});
});
describe('CVE and GHSA ids',()=>{
 it('parses the real records',()=>{
  const r=parseVulnRecord(cve,'CVE-2022-25883');expect(r.id).toBe('CVE-2022-25883');expect(r.aliases).toContain('GHSA-c2qf-rxjj-qqgw');expect(r.cvss[0]).toContain('CVSS_V3');expect(r.packages).toEqual([]);expect(parseVulnRecord(ghsa,'GHSA-c2qf-rxjj-qqgw').packages).toContain('npm:semver');expect(r.references.length).toBeGreaterThan(0);
  expect(parseVulnRecord(ghsa,'CVE-2022-25883').id).toBe('GHSA-c2qf-rxjj-qqgw');
 });
 it('refuses a record for a different id',()=>expect(()=>parseVulnRecord(ghsa,'CVE-2000-0001')).toThrow());
 it('looks up by id, GET with no redirect, and returns the record fields',async()=>{
  const f=vi.fn(async(u:any,o:any)=>{expect(String(u)).toBe('https://api.osv.dev/v1/vulns/CVE-2022-25883');expect(o.method).toBe('GET');expect(o.redirect).toBe('error');return new Response(cve);});vi.stubGlobal('fetch',f);
  const r:any=await handlePackageSecurity({target:'cve-2022-25883'});expect(r.vulnerability_count).toBe(1);expect(r.target).toBe('CVE-2022-25883');expect(r.target_shape).toBe('cve');expect(r.aliases).toContain('GHSA-c2qf-rxjj-qqgw');expect(r.affected_packages).toEqual([]);expect(r.answer).toContain('OSV lists no package as affected');expect(r.severity_scores[0]).toContain('CVSS');expect(r.references.length).toBeGreaterThan(0);expect(r.verdict).toBe('Needs changes');expect(['Secure','Needs changes','Insecure']).toContain(r.verdict);expect(typeof r.vulnerability_count).toBe('number');expect(r.answer).toContain('does not say whether your dependency');expect(r.answer).not.toContain('Needs changes');expect(r.answer).not.toContain('https://');
  expect(JSON.parse((await getReceiptEvidence(r.receipt.receipt_id)).evidence!.toString()).source_raw_body).toBe(cve);
 });
 it('GHSA id lookup uses the GHSA url',async()=>{const f=vi.fn(async(u:any)=>{expect(String(u)).toBe('https://api.osv.dev/v1/vulns/GHSA-c2qf-rxjj-qqgw');return new Response(ghsa);});vi.stubGlobal('fetch',f);const r:any=await handlePackageSecurity({target:'GHSA-c2qf-rxjj-qqgw'});expect(r.aliases).toContain('CVE-2022-25883');expect(r.affected_packages).toContain('npm:semver');});
 it('a real OSV 404 is a 422 refusal, never zero or Secure, with no id echoed',async()=>{
  vi.stubGlobal('fetch',async()=>new Response(NF,{status:404}));await expect(handlePackageSecurity({target:'CVE-2099-0001'})).rejects.toMatchObject({status:422,code:'NO_ADVISORY_COVERAGE'});
 });
 it('a withdrawn record is a 422 refusal, not an active advisory',async()=>{const d=JSON.parse(cve);d.withdrawn='2026-01-01T00:00:00Z';vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(d)));await expect(handlePackageSecurity({target:'CVE-2022-25883'})).rejects.toMatchObject({status:422,code:'NO_ADVISORY_COVERAGE'});});
 it('a mismatched, malformed or failed source is 502',async()=>{
  for(const res of [()=>new Response(ghsa.replace('GHSA-c2qf-rxjj-qqgw','GHSA-aaaa-bbbb-cccc')),()=>new Response('{"vulns":[]}'),()=>new Response('boom',{status:500}),()=>new Response('{"code":9}',{status:404})]){
   vi.stubGlobal('fetch',async()=>res());await expect(handlePackageSecurity({target:'CVE-2022-25999'})).rejects.toMatchObject({status:502,code:'OSV_UNAVAILABLE'});}
 });
});
describe('unknown ecosystems',()=>{
 it.each(['cargo:serde@1.0.0','https://github.com/a/b','maven:org.x:y@1.0','zzsecretlabel:pkg@1.0.0'])('%s is a 422 ECOSYSTEM_NOT_COVERED refusal with no lookup and no value echoed',async t=>{
  const f=vi.fn();vi.stubGlobal('fetch',f);const e:any=await handlePackageSecurity({target:t}).then(()=>null,x=>x);
  expect(f).not.toHaveBeenCalled();expect(e).toMatchObject({status:422,code:'ECOSYSTEM_NOT_COVERED'});
  const body=JSON.stringify({m:e.message,b:e.responseBody??null}).toLowerCase();for(const bit of ['serde','github','secret','zzsecretlabel','cargo','maven'])expect(body).not.toContain(bit);
 });
});
describe('server logging',()=>{
 it('logs target_shape only, never the value',async()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>{}),app=buildServer();vi.stubGlobal('fetch',async()=>new Response(cve));
  try{const seen:string[]=[];
   for(const [t,shape,status] of [['CVE-2022-25883','cve',200],['cargo:secretpkg@1.0.0','other',422],['https://secret.example/path','url',422],['npm:secretpkg@x','other',400]] as const){
    log.mockClear();const res=await app.inject({method:'GET',url:'/v1/security-review?target='+encodeURIComponent(t)});expect(res.statusCode).toBe(status);
    const rows=log.mock.calls.map(c=>{try{return JSON.parse(String(c[0]));}catch{return null;}}).filter(r=>r?.event==='request_start'||r?.event==='request_complete');
    expect(rows).toHaveLength(2);for(const r of rows)expect(r.target_shape).toBe(shape);const text=JSON.stringify(rows);expect(text).not.toContain('secret');seen.push(shape);}
   expect(seen).toEqual(['cve','other','url','other']);
  }finally{log.mockRestore();await app.close();}
 });
});

describe('review fixes',()=>{
 it('cancels and drains the body of a non-OK OSV response',async()=>{
  const cancel=vi.fn(async()=>{});vi.stubGlobal('fetch',async()=>({ok:false,status:503,body:{cancel,getReader:()=>{throw new Error('must not read');}}}));
  await expect(handlePackageSecurity({target:'pip:requests@2.19.0'})).rejects.toMatchObject({status:502,code:'OSV_UNAVAILABLE'});expect(cancel).toHaveBeenCalledTimes(1);
 });
 it.each(['2.19.0rc1','2.19.0.post1','2.19.0.dev1'])('PyPI %s that OSV matched is a disclosed 200 with local range unavailable, not a 502',async v=>{
  const d=JSON.parse(py);d.vulns=d.vulns.slice(0,1);vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(d)));
  const r:any=await handlePackageSecurity({target:`pip:requests@${v}`});expect(r.vulnerability_count).toBe(1);expect(r.issues[0]).toContain('local range interpretation unavailable');expect(r.answer).toContain('local range interpretation is unavailable');
 });
});
