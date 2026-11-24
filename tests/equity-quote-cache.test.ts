import {it,expect,vi,beforeEach,afterEach} from 'vitest';import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
const dir=mkdtempSync('/tmp/equity-cache-');process.env.SQLITE_PATH=join(dir,'r.sqlite');
import {cachedEquityQuote,noteYahooRateLimit,assertYahooAllowed,resetEquityCacheForTests} from '../src/handlers/equityQuoteCache';import {handleFinancialData} from '../src/handlers/financialData';import {getReceiptEvidence} from '../src/core/storage';
beforeEach(()=>{resetEquityCacheForTests();vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));vi.stubEnv('SEC_USER_AGENT','recorded-replay-only');});afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const ok=()=>{};
it('single acquisition deduplicates concurrent reads and preserves original bytes/time',async()=>{
 const load=vi.fn(async()=> 'real');const results=await Promise.all([cachedEquityQuote('AAPL',load,ok),cachedEquityQuote('AAPL',load,ok)]);expect(load).toHaveBeenCalledTimes(1);expect(results[0]).toEqual(results[1]);
});
it.each(['600',new Date('2026-11-23T12:10:00Z').toUTCString()])('respects RetryAfter %s across chart/search/ticker cooldown',async retry=>{
 noteYahooRateLimit(retry);expect(()=>assertYahooAllowed()).toThrow('cooldown');await vi.advanceTimersByTimeAsync(599999);expect(()=>assertYahooAllowed()).toThrow();await vi.advanceTimersByTimeAsync(1);expect(()=>assertYahooAllowed()).not.toThrow();
});
it('cold cache refuses during cooldown with no loader call, minimum60seconds',async()=>{
 noteYahooRateLimit('1');const load=vi.fn(async()=> 'fake');await expect(cachedEquityQuote('MSFT',load,ok)).rejects.toThrow('cooldown');expect(load).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(60000);expect(()=>assertYahooAllowed()).not.toThrow();
});
it('stale exact bytes expire at15minutes and never cross ticker identity',async()=>{
 const first=await cachedEquityQuote('AAPL',async()=> 'real',ok);await vi.advanceTimersByTimeAsync(300001);noteYahooRateLimit('900');const load=vi.fn(async()=> 'fake');const stale=await cachedEquityQuote('AAPL',load,ok);expect(stale.body).toBe(first.body);expect(stale.fetchedAt).toBe(first.fetchedAt);expect(stale.staleReason).toContain('429');expect(load).not.toHaveBeenCalled();await expect(cachedEquityQuote('MSFT',load,ok)).rejects.toThrow();await vi.advanceTimersByTimeAsync(599999);await expect(cachedEquityQuote('AAPL',load,ok)).rejects.toThrow();
});
it('invalid200 never falls back or replaces the last valid observation',async()=>{
 await cachedEquityQuote('AAPL',async()=> 'real',ok);await vi.advanceTimersByTimeAsync(300001);await expect(cachedEquityQuote('AAPL',async()=> 'invalid',body=>{if(body==='invalid')throw new Error('invalid');})).rejects.toThrow('invalid');noteYahooRateLimit(null);expect((await cachedEquityQuote('AAPL',async()=> 'fake',ok)).body).toBe('real');
});
it('handler replays real captures then discloses429 with identical quote evidence and observed age',async()=>{
 const chart=readFileSync(join(__dirname,'fixtures/financial-data/yahoo-chart-aapl.json'),'utf8'),shares=readFileSync(join(__dirname,'fixtures/financial-data/sec-aapl-shares.json'),'utf8'),tickers=readFileSync(join(__dirname,'fixtures/corporate-registry/company-tickers-excerpt.json'),'utf8');let limited=false,calls=0;
 vi.stubGlobal('fetch',async(url:unknown)=>{const u=String(url);if(u.includes('sec.gov'))return new Response(u.includes('companyconcept')?shares:tickers);calls++;return limited?new Response('',{status:429,headers:{'retry-after':'600'}}):new Response(chart);});
 const first=await handleFinancialData({asset:'AAPL'});await vi.advanceTimersByTimeAsync(300001);limited=true;const stale=await handleFinancialData({asset:'AAPL'});expect(calls).toBe(2);expect(stale.market_cap_usd).toBe(first.market_cap_usd);expect(stale.as_of).toBe(first.as_of);expect(stale.stale).toBe(true);expect(stale.verdict).toBe('stale');expect(stale.quote_age_seconds).toBe(300);expect(stale.answer).toContain('mixed-age derivation');expect(stale.answer).toContain('not current market data');const e=await getReceiptEvidence((stale.receipt as any).receipt_id);const d=JSON.parse(e.evidence!.toString());expect(d.raw_bodies.yahoo_chart).toBe(chart);expect(d.quote_fetched_at).toBe(first.quote_fetched_at);
 await handleFinancialData({asset:'AAPL'});expect(calls).toBe(2);
});
