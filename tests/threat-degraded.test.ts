import {afterAll,afterEach,beforeEach,it,expect,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/threat-degraded-');process.env.SQLITE_PATH=join(scratch,'r.sqlite');
import {handleThreatIndicator,resetThreatIntelCacheForTests,loadFeedView,requireBoundedThreatView} from '../src/handlers/threatIntel';
import {handleUrlSafe} from '../src/handlers/urlSafe';import {handleUrlScan} from '../src/handlers/urlScan';import {getReceiptEvidence} from '../src/core/storage';import {sha256Hex} from '../src/core/receipt';
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});beforeEach(()=>resetThreatIntelCacheForTests({}));
const fx=join(__dirname,'fixtures/threat-indicator');
const bodies:Record<string,string>=Object.fromEntries(Object.entries({'spamhaus.org':'spamhaus-drop.txt','emergingthreats.net':'et-compromised.txt','blocklist.de':'blocklistde.txt','stamparm':'ipsum.txt','Phishing.Database':'phishing-db.txt','hagezi':'hagezi-tif.txt','openphish':'openphish.txt'}).map(([k,f])=>[k,readFileSync(join(fx,f),'utf8')]));
function stub(down=['blocklist.de'],empty=false){let calls=0;vi.stubGlobal('fetch',async(url:unknown)=>{calls++;const key=Object.keys(bodies).find(k=>String(url).includes(k));if(!key)throw new Error('not a feed');if(down.includes(key)){if(empty)return new Response('',{status:200});throw new Error('synthetic outage');}return new Response(bodies[key],{status:200});});return()=>calls;}
it('positive IP survives one outage with exact raw match and missing feed evidence',async()=>{
 stub();const r=await handleThreatIndicator({indicator:'185.220.101.4'});expect(r.malicious).toBe(true);expect(r.screening_complete).toBe(false);expect(r.feeds_checked).toBe(6);expect(r.answer).toContain('INCOMPLETE SCREENING');expect(r.answer).toContain('blocklist.de');
 const e=await getReceiptEvidence((r.receipt as any).receipt_id);const d=JSON.parse(e.evidence!.toString());expect(sha256Hex(e.evidence!)).toBe((r.receipt as any).raw_response_sha256);expect(d.unavailable_feeds[0]).toContain('blocklist.de');expect(d.matches.some((m:any)=>m.feed==='stamparm ipsum'&&m.matched_entry==='185.220.101.4')).toBe(true);expect(d.feeds).toHaveLength(6);
});
it('positive URL returns malicious and not safe, never contacts listed target',async()=>{
 const calls=stub();const raw=bodies.openphish.split(/\r?\n/).find(s=>s.startsWith('http'))!;
 const scan=await handleUrlScan({url:raw});expect(scan.safe).toBe(false);expect(scan.answer).toContain('INCOMPLETE SCREENING');
 const safe=await handleUrlSafe({url:raw});expect(safe.url_check).toEqual({verdict:'Malicious'});expect(safe.detections).toBeGreaterThan(0);expect(safe.detections_scope).toContain('incomplete');expect(calls()).toBe(7);
});
it('no-hit booleans refuse, URL_SAFE uses Unknown with zero observed detections',async()=>{
 stub();await expect(handleThreatIndicator({indicator:'8.8.8.8'})).rejects.toMatchObject({code:'THREAT_FEED_DEGRADED'});await expect(handleUrlScan({url:'https://example.com/'})).rejects.toMatchObject({code:'THREAT_FEED_DEGRADED'});
 const r=await handleUrlSafe({url:'https://example.com/'});expect(r.url_check).toEqual({verdict:'Unknown'});expect(r.detections).toBe(0);expect(r.answer).toContain('safety cannot be determined');expect(r.answer).not.toContain('Safe (blocklist sense)');expect(r.unavailable_feeds).toHaveLength(1);
});
it('truncated empty feed is unavailable, not a zero-entry clean source',async()=>{
 resetThreatIntelCacheForTests({'blocklist.de all-attacks':1});stub(['blocklist.de'],true);const r=await handleThreatIndicator({indicator:'185.220.101.4'});expect(r.unavailable_feeds).toEqual([expect.stringContaining('parsed to only 0')]);
});
it('two failed feeds refuse even a positive listing or Unknown-capable URL',async()=>{
 stub(['blocklist.de','emergingthreats.net']);await expect(loadFeedView()).rejects.toMatchObject({code:'THREAT_FEED_DEGRADED'});await expect(handleThreatIndicator({indicator:'185.220.101.4'})).rejects.toMatchObject({code:'THREAT_FEED_DEGRADED'});await expect(handleUrlSafe({url:'https://example.com/'})).rejects.toMatchObject({code:'THREAT_FEED_DEGRADED'});
});
it('minimum applicable feed floor applies even with a positive match',async()=>{
 stub();const view=await loadFeedView();const limited={...view,states:view.states.filter(s=>s.feed.kind==='url')};expect(()=>requireBoundedThreatView(limited,'https://example.com/',true,true)).toThrow();
});
it('partial view cache is bounded to60seconds, no stale missing-feed substitution',async()=>{
 vi.useFakeTimers();const calls=stub();await loadFeedView();expect(calls()).toBe(7);await vi.advanceTimersByTimeAsync(59999);await loadFeedView();expect(calls()).toBe(7);await vi.advanceTimersByTimeAsync(1);await loadFeedView();expect(calls()).toBe(14);
});
