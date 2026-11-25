import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleNewsHeadlines,topicFeed} from '../src/handlers/newsHeadlines';
import {resetNewsCircuitForTests,parseHn,parseBbcRss} from '../src/handlers/newsSources';
import {resetHeadlineFeedsForTests} from '../src/handlers/newsHeadlineFeeds';
const raw=(file:string)=>readFileSync('tests/fixtures/news-relax/'+file,'utf8');
const hn=raw('hn-mars-7d.json');
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();resetNewsCircuitForTests();resetHeadlineFeedsForTests();});
function replay(mode:'wide'|'overlap'|'category'|'empty'|'exact'='wide'){
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-25T15:35:30Z'));
 const f=vi.fn(async(u:any)=>{const url=new URL(String(u));
  if(url.hostname==='api.gdeltproject.org')throw Error('GDELT forbidden hot path');
  if(url.hostname==='hn.algolia.com')return new Response(mode==='exact'||(mode==='wide'&&url.searchParams.has('optionalWords'))?hn:'{"hits":[]}');
  if(url.hostname==='news.google.com')return new Response('<rss><channel></channel></rss>');
  const category=url.pathname.split('/')[2];
  if(mode==='empty'||mode==='wide'||mode==='exact')return new Response('<rss><channel></channel></rss>');
  // Real BBC captures, not invented headline data. Category-only scenario uses
  // a topic whose other keywords do not overlap the captured titles.
  return new Response(raw(category+'.xml'));
 });vi.stubGlobal('fetch',f);return f;
}
it('widened HN any-keyword closest match names 7 days, lowers confidence and retains bytes',async()=>{
 const f=replay();const out=await handleNewsHeadlines({topic:'Mars rover mission',anything:'existing ignored key'});
 expect(out.top_headline).not.toBeNull();expect(parseHn(hn).some(i=>i.title===out.top_headline)).toBe(true);
 expect(out.confidence).toBeLessThan(0.8);expect(out.answer).toContain('Closest match only');expect(out.answer).toContain('no exact 24h match');expect(out.answer).toContain('widened 7 days');
 const wideCall=f.mock.calls.map(([u])=>new URL(String(u))).find(u=>u.searchParams.has('optionalWords'))!;
 expect(wideCall.searchParams.get('numericFilters')).toBe('created_at_i>'+String(Math.floor(Date.now()/1000)-7*86400));expect(JSON.parse(wideCall.searchParams.get('optionalWords')!)).toEqual(['mars','rover','mission']);
 const d=(out.headline_details as any[])[0];expect(d.url).toMatch(/^https:\/\//);expect(Date.parse(d.published)).toBeLessThanOrEqual(Date.now());
 expect(String(vi.mocked(saveReceipt).mock.calls[0][1])).toContain(JSON.stringify(hn));
 expect(f.mock.calls.some(([u])=>String(u).includes('gdelt'))).toBe(false);
});
it('BBC overlap is disclosed and attempted only after empty widened HN',async()=>{
 replay('overlap');const feed=parseBbcRss(raw('science_and_environment.xml'));const word=feed[0].title.toLowerCase().split(/[^a-z0-9]+/).find(w=>w.length>5)!;
 const out=await handleNewsHeadlines({topic:word+' zzqnovelterm'});expect(out.top_headline).not.toBeNull();expect(out.answer).toContain('BBC title keyword overlap');expect(out.answer).toContain('no exact 24h match');expect(out.confidence).toBeLessThan(0.8);
});
it('mapped category last resort is disclosed rather than exact niche match',async()=>{
 replay('category');const out=await handleNewsHeadlines({topic:'astronomy zzqnovelterm'});expect(out.top_headline).not.toBeNull();expect(out.answer).toContain('closest mapped category feed BBC science_and_environment');expect(out.answer).toContain('no exact 24h match');expect(out.confidence).toBeLessThan(0.8);
});
it('empty everywhere remains null with reason',async()=>{replay('empty');const out=await handleNewsHeadlines({topic:'Mars rover mission'});expect(out.top_headline).toBeNull();expect(out.headlines).toEqual([]);expect(out.answer).toContain('zero matches');});
it('exact headline path confidence unchanged and no false relaxed claim',async()=>{replay('exact');const title=parseHn(hn)[0].title;const out=await handleNewsHeadlines({topic:title,window_hours:'168'});expect(out.top_headline).toBe(title);expect(out.confidence).toBe(0.8);expect(out.answer).not.toContain('Closest match only');});
it('BBC feeds cached60s with original acquisition evidence, expiry refetches',async()=>{
 const f=replay('category');await handleNewsHeadlines({topic:'astronomy zzqnovelterm'});const first=JSON.parse(String(vi.mocked(saveReceipt).mock.calls[0][1])).bbc_feed_captures;
 await vi.advanceTimersByTimeAsync(59000);await handleNewsHeadlines({topic:'astronomy zzqnovelterm'});
 expect(f.mock.calls.filter(([u])=>String(u).includes('feeds.bbci')).length).toBe(5);
 expect(JSON.parse(String(vi.mocked(saveReceipt).mock.calls[1][1])).bbc_feed_captures).toEqual(first);
 await vi.advanceTimersByTimeAsync(1001);await handleNewsHeadlines({topic:'astronomy zzqnovelterm'});expect(f.mock.calls.filter(([u])=>String(u).includes('feeds.bbci')).length).toBe(10);
});
it.each(['space','science','astronomy','nasa','mars','climate','health','medicine','energy','crypto','ai'])('maps %s explicitly',topic=>expect(topicFeed(topic)).not.toBeNull());
it('stopwords dropped from widened any-keyword request',async()=>{const f=replay();await handleNewsHeadlines({topic:'the Mars rover mission and the news'});const u=f.mock.calls.map(([u])=>new URL(String(u))).find(u=>u.searchParams.has('optionalWords'))!;expect(JSON.parse(u.searchParams.get('optionalWords')!)).toEqual(['mars','rover','mission']);});
it('fallback rejects older-than7day captured news, never invents freshness',async()=>{replay('wide');vi.setSystemTime(new Date('2027-01-25T15:35:30Z'));const out=await handleNewsHeadlines({topic:'Mars rover mission'});expect(out.top_headline).toBeNull();});
it('failed or invalid BBC responses are not cached as successful empty feeds',async()=>{const f=replay('category');f.mockImplementation(async()=>new Response('<html>unavailable</html>'));await expect(handleNewsHeadlines({topic:'astronomy zzqnovelterm'})).rejects.toMatchObject({code:'NEWS_INDEXES_UNREACHABLE'});const first=f.mock.calls.filter(([u])=>String(u).includes('feeds.bbci')).length;await expect(handleNewsHeadlines({topic:'astronomy zzqnovelterm'})).rejects.toMatchObject({code:'NEWS_INDEXES_UNREACHABLE'});expect(f.mock.calls.filter(([u])=>String(u).includes('feeds.bbci')).length).toBe(first+5);});

it.each(['wide','overlap','category'] as const)('%s fallback excludes genuinely future captured headlines from answer and receipt matches',async mode=>{
 replay(mode);
 const captured=mode==='wide'?parseHn(hn):parseBbcRss(raw('science_and_environment.xml'));
 // Freeze before every actual captured publication, rather than advancing the
 // clock (which would exercise only the lower/old-news boundary).
 const allCaptured=mode==='wide'?captured:['science_and_environment','technology','world','business','health'].flatMap(c=>parseBbcRss(raw(c+'.xml')));
 const requestClock=Math.min(...allCaptured.map(i=>Date.parse(i.published)))-1000;
 expect(allCaptured.length).toBeGreaterThan(0);
 expect(allCaptured.every(i=>Date.parse(i.published)>requestClock)).toBe(true);
 vi.setSystemTime(new Date(requestClock));
 const overlapWord=captured[0].title.toLowerCase().split(/[^a-z0-9]+/).find(w=>w.length>5)!;
 const topic=mode==='wide'?'Mars rover mission':mode==='overlap'?overlapWord+' zzqnovelterm':'astronomy zzqnovelterm';
 const out=await handleNewsHeadlines({topic});
 expect(out.top_headline).toBeNull();expect(out.headlines).toEqual([]);expect(out.urls).toEqual([]);
 const evidence=JSON.parse(String(vi.mocked(saveReceipt).mock.calls[0][1]));
 expect(evidence.relaxed_match).toBeNull();
 for(const key of ['hn_matches','gnews_matches','bbc_matches','topic_feed_items'])expect(evidence[key]).toEqual([]);
 // Future bytes remain inspectable raw evidence, never accepted match rows.
 expect(mode==='wide'?evidence.wide_hn_raw:evidence.bbc_feed_captures[0].raw).toBe(mode==='wide'?hn:raw('science_and_environment.xml'));
});

it('headlines all-down error lists only requested sources, no omitted index',async()=>{
 const f=replay();f.mockImplementation(async()=>{throw Error('source unavailable');});
 const err=await handleNewsHeadlines({topic:'Mars rover mission'}).catch(e=>e);
 expect(err.code).toBe('NEWS_INDEXES_UNREACHABLE');expect(err.message).not.toContain('GDELT');
 for(const label of ['Hacker News story index (Algolia API)','Google News','BBC science_and_environment','BBC technology','BBC world','BBC business','BBC health'])expect(err.message).toContain(label);
 expect(saveReceipt).not.toHaveBeenCalled();
});
it('widened HN uses remaining shared deadline after strict HN empties at2000ms',async()=>{
 replay();let wideStarted:number|null=null;
 vi.stubGlobal('fetch',async(u:any)=>{
  const url=new URL(String(u));
  if(url.hostname==='hn.algolia.com'){
   if(url.searchParams.has('optionalWords')){wideStarted=Date.now();return new Promise<Response>(()=>{});}
   await new Promise(resolve=>setTimeout(resolve,2000));return new Response('{"hits":[]}');
  }
  return new Response('<rss><channel></channel></rss>');
 });
 const start=Date.now();let settled=false;
 const pending=handleNewsHeadlines({topic:'Mars rover mission'}).then(out=>{settled=true;return out;});
 await vi.advanceTimersByTimeAsync(2000);expect(wideStarted).toBe(start+2000);
 await vi.advanceTimersByTimeAsync(499);expect(settled).toBe(false);
 await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(true);
 const out=await pending;expect(Date.now()-start).toBe(2500);expect(out.top_headline).toBeNull();expect(saveReceipt).toHaveBeenCalledOnce();
});
