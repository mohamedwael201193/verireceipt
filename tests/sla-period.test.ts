vi.mock('../src/handlers/slaSourceCache',()=>({readSlaBody:async(url:string,_host:string,ua:string)=>{const r=await fetch(url,{headers:{'User-Agent':ua}});if(!r.ok)throw new Error('source unavailable');return {url,raw:await r.text(),fetchedAt:new Date().toISOString()};}}));
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
vi.mock('../src/core/storage',async original=>({...await original<typeof import('../src/core/storage')>(),saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {sha256Hex} from '../src/core/receipt';
import {handleSlaCompliance} from '../src/handlers/slaCompliance';
import {buildServer} from '../src/server';
const summary=readFileSync(join(__dirname,'fixtures/sla-resolution/github-summary.json'),'utf8');
const incidents=readFileSync(join(__dirname,'fixtures/sla-compliance/github-incidents.json'),'utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
it.each(['2026-13','last month','nonsense','91d','0d','999999 days'])('free string %s is 200 with unknown nulls and no guessed fetch',async(period)=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const app=buildServer();
 try {
 const r=await app.inject({method:'GET',url:'/v1/sla-compliance?service=github&period='+encodeURIComponent(period)});
 expect(r.statusCode).toBe(200);const out=r.json();expect(out.status).toBe('unknown');expect(out.period).toBe(period);
 expect(out.uptime_pct).toBeNull();expect(out.sla_target_pct).toBeNull();expect(out.compliant).toBeNull();expect(out.confidence).toBe(0);expect(f).not.toHaveBeenCalled();
 const [receipt,evidence]=vi.mocked(saveReceipt).mock.calls[0];expect(receipt.raw_response_sha256).toBe(sha256Hex(evidence));expect(JSON.parse(evidence).period_days).toBeNull();
 }finally{await app.close();}
});
it.each(['30d','last 30 days','30 days','the past 30 days'])('resolved period %s uses only the captured source window',async(period)=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
 vi.stubGlobal('fetch',async(url:unknown)=>new Response(String(url).includes('summary.json')?summary:String(url).includes('&page=1')?incidents:JSON.stringify({incidents:[]})));
 const out=await handleSlaCompliance({service:'github',period});expect(out.period).toBe('30d');expect(out.status).toBe('found');expect(out.uptime_pct).toBe(99.3056);
});
it('missing period remains a required-parameter error',async()=>{await expect(handleSlaCompliance({service:'github'})).rejects.toMatchObject({code:'MISSING_PARAM'});});
it('unknown service and calendar period remain not_found without arithmetic',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);const out=await handleSlaCompliance({service:'unbound service',period:'2026-10'});expect(out.status).toBe('not_found');expect(out.uptime_pct).toBeNull();expect(f).not.toHaveBeenCalled();});
