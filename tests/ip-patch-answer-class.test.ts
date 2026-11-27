import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
process.env.SQLITE_PATH=join(mkdtempSync('/tmp/ip-patch-class-'),'r.sqlite');
import {ipClass,handleIpGeolocation} from '../src/handlers/ipGeolocation';
import {patchInputClass,handleCodePatchVerify,resetCodePatchCacheForTests} from '../src/handlers/codePatchVerify';
import {sanitizeAnswerClass,answerDiagnostics} from '../src/core/answerClass';
import {buildServer} from '../src/server';
let lines:string[];
beforeEach(()=>{lines=[];vi.spyOn(console,'info').mockImplementation((m:unknown)=>{lines.push(String(m));});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();resetCodePatchCacheForTests();});
const parsed=()=>lines.filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));
const completions=()=>parsed().filter(o=>o.event==='request_complete');

it.each([
 ['10.7.8.9','v4_private_10'],
 ['127.0.0.1','v4_loopback'],
 ['169.254.3.4','v4_link_local'],
 ['172.16.5.6','v4_private_172'],
 ['172.31.255.254','v4_private_172'],
 ['192.168.0.1','v4_private_192_168'],
 ['100.64.0.1','v4_cgnat'],
 ['100.127.255.254','v4_cgnat'],
 ['192.0.0.1','v4_192_0'],
 ['192.0.2.1','v4_192_0'], // the 192.0.2.0/24 documentation range still logs v4_192_0; narrowing is a later change
 ['198.18.0.1','v4_198_18'],
 ['198.19.255.1','v4_198_18'],
 ['198.51.100.7','v4_doc'],
 ['203.0.113.9','v4_doc'],
 ['0.0.0.0','v4_multicast_reserved'],
 ['224.0.0.1','v4_multicast_reserved'],
 ['255.255.255.255','v4_multicast_reserved'],
 ['2001:db8::1','v6_doc'],
 ['::1','v6_local'],
 ['::','v6_local'],
 ['fd00::1','v6_local'],
 ['fc00::1','v6_local'],
 ['fe80::1','v6_local'],
 ['::ffff:10.0.0.1','v6_mapped'], // mapped addresses log v6_mapped, never the embedded v4 family
 ['8.8.8.8','other'],
 ['172.15.0.1','other'],
 ['ff02::1','other'], // v6 multicast has no fixed label of its own
 ['not-an-ip','other'],
])('ipClass %s -> %s',(ip,exp)=>{expect(ipClass(ip)).toBe(exp);});

it.each([
 ['','empty_like'],
 ['   ','empty_like'],
 ['-','empty_like'],
 ['#@/','empty_like'],
 ['https://github.com/a/b/commit/notasha','github_url_commit'],
 ['https://github.com/a/b/pull/xyz','github_url_pull'],
 ['https://github.com/a/b/actions/runs/abc','github_url_run'],
 ['https://github.com/a/b/tree/main','github_url_other'],
 ['https://gitlab.example/a/b/commit/1234567','other_host_url'],
 ['abcdef1','sha_only'],
 ['0123456789abcdef0123456789abcdef01234567','sha_only'],
 ['a/b/c@d','owner_repo_at'],
 ['owner/repo@','owner_repo_at'],
 ['owner/repo#x','owner_repo_hash'],
 ['owner/repo!','owner_repo_only'],
 ['nonsense','bare_word'],
 ['some.patch','bare_word'],
 ['NotAReal-Patch-Zq31337','bare_word'],
 ['not a patch','other'],
 ['a/b/c','other'],
])('patchInputClass %j -> %s',(raw,exp)=>{expect(patchInputClass(raw).patch_input_class).toBe(exp);});

it.each([[16,'<=16'],[17,'17-40'],[40,'17-40'],[41,'41-100'],[100,'41-100'],[101,'>100']])('length %i falls in bucket %s',(n,b)=>{
 expect(patchInputClass('z'.repeat(n)).length_bucket).toBe(b);
});

it('every fixed ip_class, patch_input_class and length_bucket label passes the sanitizer',()=>{
 for(const ip_class of ['v4_private_10','v4_loopback','v4_link_local','v4_private_172','v4_private_192_168','v4_cgnat','v4_192_0','v4_198_18','v4_doc','v4_multicast_reserved','v6_doc','v6_local','v6_mapped','other','invalid','too_long'])expect(sanitizeAnswerClass('IP_GEOLOCATION_GENERAL',{ip_class})).toEqual({ip_class});
 for(const patch_input_class of ['github_url_commit','github_url_pull','github_url_run','github_url_other','other_host_url','owner_repo_at','owner_repo_hash','owner_repo_only','sha_only','bare_word','empty_like','other'])expect(sanitizeAnswerClass('CODE_PATCH_VERIFY_GENERAL',{patch_input_class})).toEqual({patch_input_class});
 for(const length_bucket of ['<=16','17-40','41-100','>100'])expect(sanitizeAnswerClass('CODE_PATCH_VERIFY_GENERAL',{length_bucket})).toEqual({length_bucket});
});

it('ip_class and patch classes are closed enums: arbitrary labels, unknown keys and getters drop out',()=>{
 expect(sanitizeAnswerClass('IP_GEOLOCATION_GENERAL',{ip_class:'PRIVATE'})).toBeUndefined();
 expect(sanitizeAnswerClass('IP_GEOLOCATION_GENERAL',{ip_class:'v4_private_10',ip:'PRIVATE'})).toEqual({ip_class:'v4_private_10'});
 expect(sanitizeAnswerClass('IP_GEOLOCATION_GENERAL',Object.defineProperty({},'ip_class',{get(){throw Error('PRIVATE');}}))).toBeUndefined();
 expect(sanitizeAnswerClass('CODE_PATCH_VERIFY_GENERAL',{patch_input_class:'PRIVATE',length_bucket:'huge'})).toBeUndefined();
 expect(sanitizeAnswerClass('CODE_PATCH_VERIFY_GENERAL',{patch_input_class:'bare_word',length_bucket:'<=16',patch:'PRIVATE'})).toEqual({patch_input_class:'bare_word',length_bucket:'<=16'});
 expect(sanitizeAnswerClass('CODE_PATCH_VERIFY_GENERAL',Object.defineProperty({},'patch_input_class',{get(){throw Error('PRIVATE');}}))).toBeUndefined();
});

it('PRIVATE_IP return is tagged with the range family; INVALID_IP and the over-long case tag invalid and too_long',async()=>{
 const r=await handleIpGeolocation({ip:'10.6.6.6'});
 expect(r.verdict).toBe('no_data');
 expect(answerDiagnostics('IP_GEOLOCATION_GENERAL',r).answerClass).toEqual({ip_class:'v4_private_10'});
 try{await handleIpGeolocation({ip:'999.1.2.3'});expect.unreachable();}catch(e){expect(answerDiagnostics('IP_GEOLOCATION_GENERAL',e).answerClass).toEqual({ip_class:'invalid'});}
 try{await handleIpGeolocation({ip:'9'.repeat(46)});expect.unreachable();}catch(e){expect(answerDiagnostics('IP_GEOLOCATION_GENERAL',e).answerClass).toEqual({ip_class:'too_long'});}
});

it('unparseable patch return is tagged with the fixed input class and length bucket',async()=>{
 const r=await handleCodePatchVerify({patch:'https://gitlab.example/a/b/commit/1234567'});
 expect(r.passed).toBe(false);
 expect(answerDiagnostics('CODE_PATCH_VERIFY_GENERAL',r).answerClass).toEqual({patch_input_class:'other_host_url',length_bucket:'41-100'});
});

it('a PRIVATE_IP answer logs the fixed ip_class, never the address',async()=>{
 const app=buildServer();
 const res=await app.inject({method:'GET',url:'/v1/ip-geolocation?ip=10.99.88.77'});
 expect(res.statusCode).toBe(200);
 expect(completions().at(-1)).toMatchObject({intent:'IP_GEOLOCATION_GENERAL',status:'200',answer_class:{ip_class:'v4_private_10'}});
 expect(JSON.stringify(lines)).not.toContain('10.99.88.77');
 await app.close();
});

it('an INVALID_IP refusal logs ip_class invalid, never the input',async()=>{
 const app=buildServer();
 const res=await app.inject({method:'GET',url:'/v1/ip-geolocation?ip=zz9.8.7.6'});
 expect(res.statusCode).toBe(400);
 expect(completions().at(-1)).toMatchObject({intent:'IP_GEOLOCATION_GENERAL',status:'400',answer_class:{ip_class:'invalid'}});
 expect(JSON.stringify(lines)).not.toContain('zz9.8.7.6');
 await app.close();
});

it('the over-long case logs ip_class too_long, never the input',async()=>{
 const app=buildServer();
 const long='9'.repeat(46);
 const res=await app.inject({method:'GET',url:'/v1/ip-geolocation?ip='+long});
 expect(res.statusCode).toBe(400);
 expect(completions().at(-1)).toMatchObject({intent:'IP_GEOLOCATION_GENERAL',status:'400',answer_class:{ip_class:'too_long'}});
 expect(JSON.stringify(lines)).not.toContain(long);
 await app.close();
});

it('an unparseable patch logs the fixed class and bucket, never the input text',async()=>{
 const app=buildServer();
 const secret='NotAReal-Patch-Zq31337';
 const res=await app.inject({method:'GET',url:'/v1/code-patch?patch='+encodeURIComponent(secret)});
 expect(res.statusCode).toBe(200);
 expect(completions().at(-1)).toMatchObject({intent:'CODE_PATCH_VERIFY_GENERAL',status:'200',answer_class:{patch_input_class:'bare_word',length_bucket:'17-40'}});
 const all=JSON.stringify(lines);for(const bad of ['NotAReal','Zq31337','31337'])expect(all).not.toContain(bad);
 await app.close();
});

it.each([
 ['https://github.com/a/b/pull/xyz',{patch_input_class:'github_url_pull',length_bucket:'17-40'}],
 ['a/b/c@d',{patch_input_class:'owner_repo_at',length_bucket:'<=16'}],
 ['abcdef1',{patch_input_class:'sha_only',length_bucket:'<=16'}],
])('unparseable patch %s logs %j',async(patch,exp)=>{
 const app=buildServer();
 const res=await app.inject({method:'GET',url:'/v1/code-patch?patch='+encodeURIComponent(patch)});
 expect(res.statusCode).toBe(200);
 expect(completions().at(-1)).toMatchObject({intent:'CODE_PATCH_VERIFY_GENERAL',answer_class:exp});
 expect(JSON.stringify(lines)).not.toContain(patch);
 await app.close();
});

it('a parseable patch refusal carries no patch input class',async()=>{
 vi.stubGlobal('fetch',async()=>new Response('not found',{status:404}));
 const app=buildServer();
 const res=await app.inject({method:'GET',url:'/v1/code-patch?patch=owner/repo@0123456789abcdef0123456789abcdef01234567'});
 expect(res.statusCode).toBe(422);
 expect(completions().at(-1)).toMatchObject({intent:'CODE_PATCH_VERIFY_GENERAL',status:'422'});
 expect(completions().at(-1)!.answer_class).toBeUndefined();
 await app.close();
});
