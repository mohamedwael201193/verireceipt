import {afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/package-security-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import {parsePackageTarget,parsePackageAdvisories,handlePackageSecurity} from '../src/handlers/packageSecurity';
import {getReceiptEvidence} from '../src/core/storage';import {sha256Hex} from '../src/core/receipt';
import {buildServer} from '../src/server';
const real=readFileSync(join(__dirname,'fixtures/osv-package/semver-7.5.1.json'),'utf8');
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));afterEach(()=>vi.unstubAllGlobals());
describe('exact npm known-advisory security review',()=>{
 it.each(['lodash','semver@latest','semver@^7.5.1','https://example.com','semver@7.5.1-beta','semver@07.5.1','SEMVER@7.5.1','semver@7.5.1?x=1'])('rejects unsupported target %s',target=>expect(()=>parsePackageTarget(target)).toThrow());
 it('accepts canonical scoped/unscoped exact release versions',()=>{
  expect(parsePackageTarget('npm:semver@7.5.1')).toEqual({name:'semver',version:'7.5.1'});
  expect(parsePackageTarget('@scope/package@1.2.3')).toEqual({name:'@scope/package',version:'1.2.3'});
 });
 it('uses the real OSV query record and keeps aliases out of the count',()=>{
  const a=parsePackageAdvisories(real,'semver');expect(a).toHaveLength(1);expect(a[0].id).toBe('GHSA-c2qf-rxjj-qqgw');expect(a[0].aliases).toContain('CVE-2022-25883');
 });
 it.each(['identity','pagination','dates','shape'])('refuses %s mismatch',mode=>{
  const d=JSON.parse(real);if(mode==='identity')d.vulns[0].affected.forEach((a:any)=>a.package.name='other');
  if(mode==='pagination')d.next_page_token='more';if(mode==='dates')d.vulns[0].modified='bad';if(mode==='shape')d.vulns={};
  expect(()=>parsePackageAdvisories(JSON.stringify(d),'semver')).toThrow();
 });
 it('independently checks stable-version affected ranges against fuzzy query responses',()=>{
  expect(parsePackageAdvisories(real,'semver','7.5.1')).toHaveLength(1);
  expect(()=>parsePackageAdvisories(real,'semver','7.5.2')).toThrow();
  expect(()=>parsePackageAdvisories(real,'semver','1.0.0')).toThrow();
 });
 it('deduplicates IDs and excludes withdrawn entries',()=>{
  const d=JSON.parse(real);d.vulns.push(d.vulns[0]);expect(parsePackageAdvisories(JSON.stringify(d),'semver')).toHaveLength(1);
  d.vulns[0].withdrawn='2026-11-01';expect(parsePackageAdvisories(JSON.stringify(d),'semver')).toHaveLength(0);
 });
 it('sorts published severity categories before unknown, not by arbitrary source order',()=>{
  const d=JSON.parse(real);const low=structuredClone(d.vulns[0]);low.id='GHSA-test-low';low.database_specific.severity='LOW';d.vulns.unshift(low);
  expect(parsePackageAdvisories(JSON.stringify(d),'semver').map(a=>a.id)).toEqual(['GHSA-c2qf-rxjj-qqgw','GHSA-test-low']);
 });
 it('refuses empty coverage, never calling it secure',async()=>{
  vi.stubGlobal('fetch',async()=>new Response('{}'));await expect(handlePackageSecurity({target:'semver@7.7.3'})).rejects.toMatchObject({status:422,code:'NO_ADVISORY_COVERAGE'});
 });
 it('refuses source failure and never substitutes a heuristic',async()=>{
  vi.stubGlobal('fetch',async()=>new Response('rate limited',{status:429}));await expect(handlePackageSecurity({target:'other-package@1.0.0'})).rejects.toMatchObject({status:502,code:'OSV_UNAVAILABLE'});
 });
 it('serves the advisory count with persisted raw evidence and no answer links',async()=>{
  const fetch=vi.fn(async (_u:unknown,o:any)=>{expect(JSON.parse(o.body)).toEqual({package:{name:'semver',ecosystem:'npm'},version:'7.5.1'});expect(o.redirect).toBe('error');return new Response(real);});vi.stubGlobal('fetch',fetch);
  const r:any=await handlePackageSecurity({target:'semver@7.5.1'});expect(r.verdict).toBe('Needs changes');expect(r.vulnerability_count).toBe(1);expect(r.issues[0]).toContain('CVE-2022-25883');expect(r.answer).not.toContain('https://');expect(r.answer).toContain('not a source-code audit');
  const e=await getReceiptEvidence(r.receipt.receipt_id);expect(sha256Hex(e.evidence!.toString())).toBe(r.receipt.raw_response_sha256);expect(JSON.parse(e.evidence!.toString()).source_raw_body).toBe(real);
  const cached:any=await handlePackageSecurity({target:'npm:semver@7.5.1'});expect(cached.observed_at).toBe(r.observed_at);expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('rejects duplicate/unknown query keys before lookup',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const app=buildServer();try{for(const url of ['/v1/security-review?target=semver@7.5.1&target=other@1.2.3','/v1/security-review?target=semver@7.5.1&extra=1'])expect((await app.inject({method:'GET',url})).statusCode).toBe(400);expect(fetch).not.toHaveBeenCalled();}finally{await app.close();}
 });
});
