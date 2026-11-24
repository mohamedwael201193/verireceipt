import {afterEach,it,expect,vi} from 'vitest';
import {probeUrlHeaders} from '../src/handlers/urlProbe';
import {guardPublicHttpUrl,__setLookupForTests,__clearRateLimitsForTests} from '../src/handlers/ssrfGuard';
afterEach(()=>{__setLookupForTests(null);__clearRateLimitsForTests();vi.useRealTimers();});
const target=(url:string)=>({url,hostname:new URL(url).hostname,port:443,addresses:['93.184.215.14']});
const result=(status=200,location?:string)=>({status,location,latency_ms:2,tls_verified:true,raw_headers:['server','negative-control']});
it('each redirect target is independently guarded before a pinned measurement',async()=>{
 const guard=vi.fn(async(url:string)=>target(url)),measure=vi.fn(async(t:any)=>result(t.hostname==='one.example'?302:200,t.hostname==='one.example'?'https://two.example/':undefined));
 const out=await probeUrlHeaders('https://one.example/',{guard,measure});expect(out.complete).toBe(true);expect(out.hops).toHaveLength(2);expect(guard.mock.calls.map(c=>c[0])).toEqual(['https://one.example/','https://two.example/']);expect(out.hops[0].tls_verified).toBe(true);
});
it.each(['http://127.0.0.1/','http://169.254.169.254/','http://[::1]/','http://localhost/'])('private redirect %s never reaches a second socket',async(location)=>{
 __setLookupForTests((async()=>[{address:'93.184.215.14',family:4}]) as any);const measure=vi.fn(async()=>result(302,location));
 const out=await probeUrlHeaders('https://public.example/',{measure});expect(out.stop).toBe('PRIVATE_HOST');expect(measure).toHaveBeenCalledTimes(1);
});
it('mixed public/private DNS blocks the initial request before socket creation',async()=>{
 __setLookupForTests((async()=>[{address:'93.184.215.14',family:4},{address:'10.0.0.1',family:4}]) as any);const measure=vi.fn();
 const out=await probeUrlHeaders('https://mixed.example/',{measure});expect(out.stop).toBe('PRIVATE_HOST');expect(measure).not.toHaveBeenCalled();
});
it.each(['https://user:password@public.example/','https://public.example:8443/'])('credentials or disallowed port never reach socket: %s',async(url)=>{
 const measure=vi.fn();await probeUrlHeaders(url,{measure});expect(measure).not.toHaveBeenCalled();
});
it('same-host redirect keeps the existing one-target/minute pacing',async()=>{
 __setLookupForTests((async()=>[{address:'93.184.215.14',family:4}]) as any);const measure=vi.fn(async()=>result(302,'/next'));
 const out=await probeUrlHeaders('https://public.example/',{measure});expect(out.stop).toBe('RATE_LIMITED');expect(measure).toHaveBeenCalledTimes(1);
});
it.each([403,429])('HTTP %s is a hard stop, no retry or redirect follow',async(status)=>{
 const guard=vi.fn(async(url:string)=>target(url)),measure=vi.fn(async()=>result(status,'https://other.example/'));
 const out=await probeUrlHeaders('https://public.example/',{guard,measure});expect(out.stop).toBe('source-refused');expect(measure).toHaveBeenCalledTimes(1);
});
it('TLS rejection remains unavailable evidence, never bypassed',async()=>{
 const guard=vi.fn(async(url:string)=>target(url)),measure=vi.fn(async()=>{throw Object.assign(new Error('certificate invalid'),{code:'CERT_HAS_EXPIRED'});});
 const out=await probeUrlHeaders('https://public.example/',{guard,measure});expect(out.stop).toBe('probe-unavailable');expect(out.complete).toBe(false);expect(out.hops).toEqual([]);expect(measure).toHaveBeenCalledTimes(1);
});
it('redirect chain is capped at three header reads',async()=>{
 let n=0;const guard=vi.fn(async(url:string)=>target(url)),measure=vi.fn(async()=>result(302,'https://hop'+(++n)+'.example/'));
 const out=await probeUrlHeaders('https://public.example/',{guard,measure});expect(out.stop).toBe('redirect-limit');expect(measure).toHaveBeenCalledTimes(3);
});

it('real captured public header observations replay without cookies',async()=>{
 const {readFileSync}=await import('node:fs');const {join}=await import('node:path');const capture=JSON.parse(readFileSync(join(__dirname,'fixtures/url-probe/public-headers-20261124.json'),'utf8'));
 for(const observation of capture.observations){
  const row=observation.hops[0];const out=await probeUrlHeaders(observation.url,{guard:async()=>({url:row.url,hostname:new URL(row.url).hostname,port:443,addresses:row.resolved_addresses}),measure:async()=>row});
  expect(out.hops[0].status).toBe(200);expect(out.hops[0].tls_verified).toBe(true);expect(out.hops[0].raw_headers).toEqual(row.raw_headers);expect(out.hops[0].raw_headers.map(x=>x.toLowerCase())).not.toContain('set-cookie');
 }
});
