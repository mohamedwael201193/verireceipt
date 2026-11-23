import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {sha256Hex} from '../src/core/receipt';
import {handleSlaCompliance} from '../src/handlers/slaCompliance';
const summary=readFileSync(join(__dirname,'fixtures/sla-resolution/github-summary.json'),'utf8');
const incidents=readFileSync(join(__dirname,'fixtures/sla-compliance/github-incidents.json'),'utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it.each(['unrecognized service','localhost','127.0.0.1','http://localhost','example.com'])('unknown service is null not_found without guessed network destination: %s',async(service)=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const out=await handleSlaCompliance({service,period:'30d'});
 expect(out.status).toBe('not_found');expect(out.uptime_pct).toBeNull();expect(out.compliant).toBeNull();expect(out.confidence).toBe(0);expect(f).not.toHaveBeenCalled();
 const[r,e]=vi.mocked(saveReceipt).mock.calls[0];expect(r.raw_response_sha256).toBe(sha256Hex(e));
});
it('verified hostname and alias resolve same provider and preserve summary bytes',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
 try {
  const f=vi.fn(async(url:unknown)=>new Response(String(url).includes('summary.json')?summary:String(url).includes('&page=1')?incidents:JSON.stringify({incidents:[]})));vi.stubGlobal('fetch',f);
  for(const service of ['Git Hub','www.githubstatus.com']) {
   const out=await handleSlaCompliance({service,period:'90d'});expect(out.status).toBe('found');expect(Array.isArray(out.components)).toBe(true);expect(String(out.uptime_semantics)).toContain('not measured');
  }
  const e=JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1]);expect(e.summary_raw_body).toBe(summary);expect(f.mock.calls.every(c=>String(c[0]).startsWith('https://www.githubstatus.com/'))).toBe(true);
 }finally{vi.useRealTimers();}
});
it('mismatched summary page identity fails closed',async()=>{
 const j=JSON.parse(summary);j.page.url='https://unrelated.example';vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(j)));
 await expect(handleSlaCompliance({service:'github',period:'30d'})).rejects.toMatchObject({code:'STATUSPAGE_MALFORMED'});expect(saveReceipt).not.toHaveBeenCalled();
});
it('verified Atlassian and DigitalOcean snapshots have correct source identities',()=>{
 for(const[name,host]of [['atlassian','status.atlassian.com'],['digitalocean','status.digitalocean.com']]) {
  const j=JSON.parse(readFileSync(join(__dirname,'fixtures/sla-resolution',name+'-summary.json'),'utf8'));expect(new URL(j.page.url).hostname).toBe(host);expect(Array.isArray(j.components)).toBe(true);
 }
});
it('non-array components refuse before any receipt is persisted',async()=>{
 const j=JSON.parse(summary);j.components={};
 vi.stubGlobal('fetch',async(url:unknown)=>new Response(String(url).includes('summary.json')?JSON.stringify(j):JSON.stringify({incidents:[]})));
 await expect(handleSlaCompliance({service:'github',period:'30d'})).rejects.toMatchObject({code:'STATUSPAGE_MALFORMED'});expect(saveReceipt).not.toHaveBeenCalled();
});

it('DigitalOcean HTTP metadata normalizes on the same bound host through the real handler',async()=>{
 const text=readFileSync(join(__dirname,'fixtures/sla-resolution/digitalocean-summary.json'),'utf8');
 expect(new URL(JSON.parse(text).page.url).protocol).toBe('http:');
 const f=vi.fn(async(url:unknown)=>new Response(String(url).includes('summary.json')?text:JSON.stringify({incidents:[]})));vi.stubGlobal('fetch',f);
 const out=await handleSlaCompliance({service:'digitalocean',period:'90d'});
 expect(out.status).toBe('found');expect(out.uptime_pct).toBe(100);
 expect(f.mock.calls.every(c=>String(c[0]).startsWith('https://status.digitalocean.com/'))).toBe(true);
 const evidence=JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1]);expect(evidence.summary_raw_body).toBe(text);
});
it('Atlassian empty component list stays empty rather than inventing component history',async()=>{
 const text=readFileSync(join(__dirname,'fixtures/sla-resolution/atlassian-summary.json'),'utf8');expect(JSON.parse(text).components).toEqual([]);
 vi.stubGlobal('fetch',async(url:unknown)=>new Response(String(url).includes('summary.json')?text:JSON.stringify({incidents:[]})));
 expect((await handleSlaCompliance({service:'atlassian',period:'90d'})).components).toEqual([]);
});
