import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleFraudDetection} from '../src/handlers/fraudDetection';
import {resetThreatIntelCacheForTests} from '../src/handlers/threatIntel';
import {extractSdnCryptoAddresses} from '../src/handlers/transactionRisk';
import {sha256Hex} from '../src/core/receipt';
const sdn=readFileSync(join(__dirname,'fixtures/fraud/sdn.csv'),'utf8');
const listed=extractSdnCryptoAddresses(sdn)[0];
const fixtures:Record<string,string>={'spamhaus.org':'spamhaus-drop','emergingthreats.net':'et-compromised','blocklist.de':'blocklistde','stamparm':'ipsum','Phishing.Database':'phishing-db','hagezi':'hagezi-tif','openphish':'openphish'};
beforeEach(()=>resetThreatIntelCacheForTests({}));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();resetThreatIntelCacheForTests();});
it('actual captured OFAC address is suspicious exposure, not proven fraud; exact body/digest retained',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(sdn));const out=await handleFraudDetection({subject:listed.toUpperCase()});
 expect(out.verdict).toBe('SUSPICIOUS');expect(out.risk_score).toBe(1);expect(out.assessment_status).toBe('unverified');
 expect(String(out.answer)).toContain('not a probability of fraud');
 const[r,e]=vi.mocked(saveReceipt).mock.calls[0];expect(r.raw_response_sha256).toBe(sha256Hex(e));expect(JSON.parse(e).raw_body).toBe(sdn);
});
it('absence does not become legitimate or measured zero risk',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(sdn));const out=await handleFraudDetection({subject:'0x'+'0'.repeat(40)});
 expect(out.verdict).toBe('INCONCLUSIVE');expect(out.risk_score).toBeNull();expect(String(out.answer)).toContain('not checked');
});
it.each(['A person claims this address is sanctioned','Transaction reverted','some unfamiliar business'])('free text stays inconclusive with no invented score or source: %s',async(subject)=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const out=await handleFraudDetection({subject});expect(out.verdict).toBe('INCONCLUSIVE');expect(out.risk_score).toBeNull();expect(f).not.toHaveBeenCalled();
});
function feeds(down=false){vi.stubGlobal('fetch',async(url:unknown)=>{for(const[k,v]of Object.entries(fixtures))if(String(url).includes(k)){if(down&&k==='openphish')throw new Error('outage');return new Response(readFileSync(join(__dirname,'fixtures/threat-indicator',v+'.txt'),'utf8'));}throw new Error('unexpected');});}
it('real excerpt blocklist match is suspicious, without fabricated fraud probability',async()=>{
 feeds();const out=await handleFraudDetection({subject:'185.220.101.4'});expect(out.verdict).toBe('SUSPICIOUS');expect(out.risk_score).toBeNull();expect(String(out.answer)).toContain('stamparm ipsum');
});
it('negative IP is inconclusive, never legitimate',async()=>{
 feeds();const out=await handleFraudDetection({subject:'8.8.8.8'});expect(out.verdict).toBe('INCONCLUSIVE');expect(out.risk_score).toBeNull();
});
it('degraded feeds and incomplete OFAC fail closed',async()=>{
 feeds(true);await expect(handleFraudDetection({subject:'8.8.8.8'})).rejects.toMatchObject({code:'THREAT_FEED_DEGRADED'});
 vi.stubGlobal('fetch',async()=>new Response('truncated'));await expect(handleFraudDetection({subject:listed})).rejects.toMatchObject({code:'SANCTIONS_UNAVAILABLE'});expect(saveReceipt).not.toHaveBeenCalled();
});
it('storage failure cannot return screening answer',async()=>{
 vi.mocked(saveReceipt).mockRejectedValueOnce(new Error('storage'));await expect(handleFraudDetection({subject:'Unknown subject'})).rejects.toMatchObject({code:'RECEIPT_PERSIST_FAILED'});
});
