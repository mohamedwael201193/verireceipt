import{it,expect,vi,afterEach}from'vitest';import{readFileSync}from'node:fs';import{join}from'node:path';import{parseContextList,threatContext}from'../src/handlers/threatContext';
const raw=(n:string)=>readFileSync(join(__dirname,`fixtures/threat-context/${n}.txt`),'utf8');
afterEach(()=>vi.unstubAllGlobals());
it('parses complete actual lists and refuses truncated or corrupt bodies',()=>{expect(parseContextList(raw('tor'),100).length).toBeGreaterThan(100);expect(parseContextList(raw('cins'),1000).length).toBeGreaterThan(1000);expect(()=>parseContextList('1.1.1.1',100)).toThrow();expect(()=>parseContextList('<html>error</html>',0)).toThrow()});
it('Tor membership is explicit context, stale Feodo not passed off as fresh and no first_seen invented',async()=>{
 vi.stubGlobal('fetch',async(u:unknown)=>new Response(raw(String(u).includes('torproject')?'tor':String(u).includes('feodo')?'feodo':'cins')));
 const ip=parseContextList(raw('tor'),100)[0],out=await threatContext(ip);expect(out.tor_exit).toBe(true);expect(out.tor_context).toContain('not evidence of malicious');expect(out.first_seen).toBeNull();expect(out.context_listed_by).toContain('Tor exit list');expect((out.context_feeds as any[]).find(r=>r.name.includes('Feodo')).status).toBe('unavailable');
});
it('domain and URL context is not a false negative IPv4 lookup',async()=>{expect((await threatContext('example.com')).tor_exit).toBeNull()});
it('TEST-NET-3 is not a member and never receives a false matched line',async()=>{
 vi.stubGlobal('fetch',async(u:unknown)=>new Response(raw(String(u).includes('torproject')?'tor':String(u).includes('feodo')?'feodo':'cins')));
 const out=await threatContext('203.0.113.1');expect(out.tor_exit).toBe(false);expect(out.context_listed_by).toEqual([]);
 for(const row of out.context_feeds as any[]){expect(row.matched_entry).toBeNull();if(row.status==='answered')expect(row.listed).toBe(false);else expect(row.listed).toBeNull();expect(out.context_listed_by).not.toContain(row.name)}
});
