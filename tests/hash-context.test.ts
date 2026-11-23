import{it,expect,vi,afterEach}from'vitest';import{readFileSync}from'node:fs';import{join}from'node:path';import{hashContext,parseMhr,mhrContext}from'../src/handlers/hashContext';
const raw=readFileSync(join(__dirname,'fixtures/malware-context/cymru-eicar-dns.json'),'utf8');const name=JSON.parse(raw).Question[0].name.replace(/\.$/,'');const circl=readFileSync(join(__dirname,'fixtures/malware-hash/eicar-sha256.json'),'utf8');
afterEach(()=>vi.unstubAllGlobals());
it('parses actual detection percentage and EICAR source context without changing verdict',()=>{
 expect(parseMhr(raw,name)).toMatchObject({detection_pct:100});const c=hashContext(circl);expect(c.is_known_test_sample).toBe(true);expect(c.test_sample_context).toContain('not evidence of a real infection');expect(c.package_context).toEqual(JSON.parse(circl).ProductCode);expect(c.circl_attribution).toContain('circl.lu/services/hashlookup');
});
it('rejects wrong DNS question/answer identity and out-of-range AV percentages',()=>{
 expect(()=>parseMhr(raw,'wrong.hash.cymru.com')).toThrow('identity');const j=JSON.parse(raw);j.Answer[0].data='1795463070 101';expect(()=>parseMhr(JSON.stringify(j),name)).toThrow('rate');j.Answer[0].name='wrong.';expect(()=>parseMhr(JSON.stringify(j),name)).toThrow();
});
it('splits SHA256 DNS label correctly, preserves exact response and treats outage as optional unknown',async()=>{
 const f=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',f);const h=JSON.parse(circl)['SHA-256'];const out=await mhrContext(h);expect(String(f.mock.calls[0][0])).toContain(name);expect(out.detection_pct).toBe(100);expect(out.raw_body).toBe(raw);
 vi.stubGlobal('fetch',async()=>{throw new Error('down')});expect(await mhrContext(h)).toMatchObject({status:'unavailable',detection_pct:null});
});
