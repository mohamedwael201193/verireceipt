import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const dir=mkdtempSync('/tmp/dns-metadata-');process.env.SQLITE_PATH=join(dir,'r.sqlite');
afterAll(()=>rmSync(dir,{recursive:true,force:true}));afterEach(()=>vi.unstubAllGlobals());
import {handleDns,parseDohVerdict} from '../src/handlers/dnsLookup';
import {getReceiptEvidence} from '../src/core/storage';
import {sha256Hex} from '../src/core/receipt';
const raw=readFileSync(join(__dirname,'fixtures/dns-google-example-a-20261125.json'),'utf8');
const parse=(body=raw,type=1,name='example.com')=>parseDohVerdict('test','https://dns.google/resolve',body,type,name);
it('replays actual source TTL and resolver AD assertion, preserving exact receipt bytes',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(raw));const r=await handleDns({name:'EXAMPLE.com.',record_type:'a'});
 expect(r.ttl).toBe(207);expect(r.record_values_agree).toBe(true);expect(r.cname_chain).toEqual([]);
 expect(r.resolvers).toHaveLength(3);for(const v of r.resolvers as any[]){expect(v.ttl).toBe(207);expect(v.dnssec_validated).toBe(true);expect(v.records).toEqual(['104.20.23.154','172.66.147.243']);}
 expect(r.dnssec_scope).toContain('no independent');const receipt=r.receipt as any;const stored=await getReceiptEvidence(receipt.receipt_id);
 expect(sha256Hex(stored.evidence!)).toBe(receipt.raw_response_sha256);const e=JSON.parse(stored.evidence!.toString());expect(e.record_values_agree).toBe(true);expect(e.resolvers[0].raw_body).toBe(raw);expect(e.resolvers[0].ttl).toBe(207);expect(e.resolvers[0].dnssec_validated).toBe(true);
});
it.each(['missing','negative','fraction','overflow','string'])('does not invent TTL for %s metadata',kind=>{
 const b=JSON.parse(raw);if(kind==='missing')delete b.Answer[0].TTL;else b.Answer[0].TTL=({negative:-1,fraction:1.5,overflow:2147483648,string:'300'} as any)[kind];
 expect(parse(JSON.stringify(b)).ttl).toBeNull();
});
it('minimum TTL is not first record TTL; zero is valid',()=>{const b=JSON.parse(raw);b.Answer[0].TTL=300;b.Answer[1].TTL=0;expect(parse(JSON.stringify(b)).ttl).toBe(0);});
it.each([false,undefined,'true',1])('AD is a boolean resolver assertion or unknown (%s)',ad=>{const b=JSON.parse(raw);b.AD=ad;expect(parse(JSON.stringify(b)).dnssecValidated).toBe(typeof ad==='boolean'?ad:null);});
it('empty matching set has unknown TTL even when a CNAME has TTL',()=>{const b=JSON.parse(raw);b.Answer=b.Answer.slice(0,1);b.Answer[0].type=5;b.Answer[0].data='alias.example.com.';const r=parse(JSON.stringify(b));expect(r.hasRecord).toBe(false);expect(r.ttl).toBeNull();expect(r.cnameChain).toEqual(['alias.example.com']);});
it('only follows exact case-insensitive owner alias chain, including out-of-order records',()=>{
 const b=JSON.parse(raw);b.Answer=[{name:'final.example.net.',type:1,TTL:80,data:'192.0.2.1'},{name:'alias.example.com.',type:5,TTL:1,data:'FINAL.example.NET.'},{name:'EXAMPLE.COM.',type:5,TTL:2,data:'alias.example.com.'}];
 const r=parse(JSON.stringify(b));expect(r.records).toEqual(['192.0.2.1']);expect(r.ttl).toBe(80);expect(r.cnameChain).toEqual(['alias.example.com','final.example.net']);
 expect(parse(JSON.stringify(b),5).records).toEqual(['alias.example.com.']);
});
it.each(['unrelated','suffix','missing-owner','cycle','fork'])('refuses %s owner evidence',kind=>{
 const b=JSON.parse(raw);if(kind==='unrelated')b.Answer[0].name='other.example.net.';
 if(kind==='suffix')b.Answer[0].name='badexample.com.';
 if(kind==='missing-owner')delete b.Answer[0].name;
 if(kind==='cycle')b.Answer=[{name:'example.com.',type:5,TTL:1,data:'alias.example.com.'},{name:'alias.example.com.',type:5,TTL:1,data:'example.com.'}];
 if(kind==='fork')b.Answer=[{name:'example.com.',type:5,TTL:1,data:'one.example.com.'},{name:'example.com.',type:5,TTL:1,data:'two.example.com.'}];
 expect(()=>parse(JSON.stringify(b))).toThrow();
});
it('data-set equality ignores order and duplicates, not missing resolvers or different values',async()=>{
 const different=JSON.parse(raw);different.Answer[0].data='192.0.2.1';
 const reverse=JSON.parse(raw);reverse.Answer.reverse();reverse.Answer.push(reverse.Answer[0]);
 vi.stubGlobal('fetch',async(url:unknown)=>new Response(String(url).includes('cloudflare')?JSON.stringify(reverse):raw));
 expect((await handleDns({name:'example.com',record_type:'A'})).record_values_agree).toBe(true);
 vi.stubGlobal('fetch',async(url:unknown)=>new Response(String(url).includes('cloudflare')?JSON.stringify(different):raw));
 const r=await handleDns({name:'example.com',record_type:'A'});expect(r.record_values_agree).toBe(false);expect(r.has_record).toBe(true);expect((r.resolvers as any[])[1].records).toContain('192.0.2.1');
 vi.stubGlobal('fetch',async(url:unknown)=>{if(!String(url).includes('dns.google'))throw Error('outage');return new Response(raw);});
 const single=await handleDns({name:'example.com',record_type:'A'});expect(single.record_values_agree).toBeNull();expect(single.confidence).toBe(.9);
});
it('all resolver responses with unrelated matching answers refuse instead of scoring existence',async()=>{
 const b=JSON.parse(raw);b.Answer[0].name='unrelated.example.net.';vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(b)));
 await expect(handleDns({name:'example.com',record_type:'A'})).rejects.toMatchObject({code:'DNS_RESOLVERS_DOWN'});
});
