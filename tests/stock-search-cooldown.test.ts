vi.mock('../src/handlers/yahooTransport',()=>({resetYahooTransportForTests:()=>{},fetchYahooBody:async(url:string,allowed:()=>void,limited:(s:string|null)=>void)=>{allowed();const r=await fetch(url);if(r.status===429)limited(r.headers.get('retry-after'));if(!r.ok)throw Object.assign(Error('HTTP'),{status:r.status});return r.text();}}));
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {readFileSync,mkdtempSync} from 'node:fs';import {join} from 'node:path';
process.env.SQLITE_PATH=join(mkdtempSync('/tmp/stock-search-cache-'),'r.sqlite');
import {handleStockPrice} from '../src/handlers/stockPrice';import {handleFinancialData} from '../src/handlers/financialData';
import {resetEquityCacheForTests,cachedYahooSearch} from '../src/handlers/equityQuoteCache';
import {getReceiptEvidence} from '../src/core/storage';import {buildServer} from '../src/server';
const fixture=(path:string)=>readFileSync(join(__dirname,'fixtures',path),'utf8');
const chart=fixture('financial-data/yahoo-chart-aapl.json'),shares=fixture('financial-data/sec-aapl-shares.json'),tickers=fixture('corporate-registry/company-tickers-excerpt.json');
// Synthetic name alias exercises fallback, not a claimed live Yahoo capture.
const search=JSON.stringify({quotes:[{symbol:'AAPL',quoteType:'EQUITY',shortname:'Synthetic Apple Alias'}]});
let status:number,searchStatus:number,yahoo:string[],body:string,searchBody:string;
beforeEach(()=>{resetEquityCacheForTests();vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));vi.stubEnv('SEC_USER_AGENT','offline-replay');status=200;searchStatus=200;yahoo=[];body=chart;searchBody=search;
 vi.stubGlobal('fetch',async(url:unknown)=>{const u=String(url);if(u.includes('sec.gov'))return new Response(u.includes('companyconcept')?shares:tickers);yahoo.push(u);const isSearch=u.includes('/search?');return new Response(isSearch?searchBody:body,{status:isSearch?searchStatus:status,headers:{'retry-after':'600'}});});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const stock=()=>handleStockPrice({ticker:'aapl'});const finance=(asset='AAPL')=>handleFinancialData({asset});
it('stock stale200 preserves original timestamp/exchange/price, exact bytes and reduced confidence',async()=>{
 const first=await stock();await vi.advanceTimersByTimeAsync(55001);status=429;const app=buildServer();const res=await app.inject({method:'GET',url:'/v1/stock-price?ticker=AAPL'});expect(res.statusCode).toBe(200);const stale=res.json();expect(stale.answer).toMatch(/^STALE CACHED QUOTE, not current market data\./);expect(stale.verdict).toBe('stale');expect(stale.confidence).toBe(0.5);expect(stale.stale).toBe(true);expect(stale.price_usd).toBe(first.price_usd);expect(stale.market_time).toBe(first.market_time);expect(stale.as_of).toBe(first.as_of);expect(stale.fetched_at).toBe(first.fetched_at);expect(stale.receipt.fetched_at).toBe(first.fetched_at);expect(stale.quote_age_seconds).toBe(55);
 const d=JSON.parse((await getReceiptEvidence(stale.receipt.receipt_id)).evidence!.toString());expect(d.raw_body).toBe(chart);expect(d.fetched_at).toBe(first.fetched_at);expect(d.stale).toBe(true);await stock();expect(yahoo.length).toBe(2);await vi.advanceTimersByTimeAsync(599999);await expect(stock()).rejects.toMatchObject({status:502});await app.close();
});
it('cold429 is502 and suppresses requests throughout RetryAfter',async()=>{status=429;await expect(stock()).rejects.toMatchObject({status:502});await vi.advanceTimersByTimeAsync(60001);await expect(stock()).rejects.toMatchObject({status:502});expect(yahoo.length).toBe(1);});
it.each(['financial-first','stock-first'])('shared cooldown across handlers %s',async direction=>{
 status=429;await expect(direction==='financial-first'?finance():stock()).rejects.toMatchObject({status:502});await expect(direction==='financial-first'?stock():finance()).rejects.toMatchObject({status:502});expect(yahoo.length).toBe(1);
});
it('same canonical chart URL/cache deduplicates both handlers and fresh reuse',async()=>{const [a,b]=await Promise.all([stock(),finance()]);expect(yahoo).toEqual(['https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d']);expect(a.price_usd).toBe(342.56);expect(b.stale).toBe(false);await stock();await finance();expect(yahoo.length).toBe(1);});
it.each(['missing','symbol','currency'])('invalid200 %s never replaces or stale-passes the stock cache',async mode=>{
 const first=await stock();await vi.advanceTimersByTimeAsync(55001);const d=JSON.parse(chart);if(mode==='missing')delete d.chart.result[0].meta;else if(mode==='symbol')d.chart.result[0].meta.symbol='MSFT';else d.chart.result[0].meta.currency='EUR';body=JSON.stringify(d);await expect(stock()).rejects.toBeDefined();status=429;const stale=await stock();expect(stale.price_usd).toBe(first.price_usd);expect(stale.fetched_at).toBe(first.fetched_at);expect(stale.stale).toBe(true);
});
it('search429 with prior resolves identically, original resolution age/body disclosed',async()=>{
 const first=await finance('Synthetic Apple Alias');await vi.advanceTimersByTimeAsync(300001);searchStatus=429;const stale=await finance('  SYNTHETIC  APPLE ALIAS ');expect(stale.asset).toBe(first.asset);expect(stale.stale).toBe(true);expect(stale.verdict).toBe('stale');expect(stale.confidence).toBe(0.5);expect(stale.answer).toContain('STALE CACHED NAME-TO-TICKER RESOLUTION');expect(stale.resolution_observation).toMatchObject({stale:true,fetched_at:'2026-11-23T12:00:00.000Z',age_seconds:300});
 const d=JSON.parse((await getReceiptEvidence((stale.receipt as any).receipt_id)).evidence!.toString());expect(d.raw_bodies.yahoo_search).toBe(search);expect(d.resolution.observation).toEqual(stale.resolution_observation);expect(yahoo.length).toBe(3);await finance('Synthetic Apple Alias');expect(yahoo.length).toBe(3);
});
it('search cold429 keeps502 and blocks uncached stock without request',async()=>{searchStatus=429;await expect(finance('Synthetic Apple Alias')).rejects.toMatchObject({status:502,code:'ASSET_SEARCH_UNAVAILABLE'});await expect(stock()).rejects.toMatchObject({status:502});expect(yahoo.length).toBe(1);});
it('search invalid200 never poisons prior mapping or falls back',async()=>{await finance('Synthetic Apple Alias');await vi.advanceTimersByTimeAsync(300001);searchBody='{}';await expect(finance('Synthetic Apple Alias')).rejects.toMatchObject({code:'ASSET_SEARCH_UNAVAILABLE'});searchStatus=429;expect((await finance('Synthetic Apple Alias')).asset).toBe('AAPL');});
it('search max age and key separation are enforced',async()=>{await finance('Synthetic Apple Alias');await vi.advanceTimersByTimeAsync(900000);searchStatus=429;await expect(finance('Synthetic Apple Alias')).rejects.toMatchObject({status:502});await expect(finance('Other Alias')).rejects.toMatchObject({status:502});expect(yahoo.length).toBe(3);});
it('search and quote namespaces cannot collide',async()=>{await stock();searchStatus=429;await expect(finance('Synthetic Apple Alias')).rejects.toMatchObject({status:502});});
it('pending shared cache revalidates body for every caller',async()=>{const load=vi.fn(async()=>search);const first=cachedYahooSearch('alias',load,()=>{});const second=cachedYahooSearch('alias',load,()=>{throw new Error('reject current mapping');});await first;await expect(second).rejects.toThrow('reject current mapping');expect(load).toHaveBeenCalledTimes(1);});

it.each([500,503])('search/stock stale fallback for HTTP%s without a429 cooldown',async code=>{await finance('Synthetic Apple Alias');await vi.advanceTimersByTimeAsync(300001);searchStatus=code;status=code;const result=await finance('Synthetic Apple Alias');expect(result.stale).toBe(true);expect(result.resolution_observation).toMatchObject({stale:true,stale_reason:'Yahoo server failure'});await expect(stock()).rejects.toMatchObject({status:502});});
it('stale search alone lowers confidence and is distinct from a fresh quote',async()=>{await finance('Synthetic Apple Alias');await vi.advanceTimersByTimeAsync(300001);await stock();searchStatus=429;const result=await finance('Synthetic Apple Alias');expect(result.quote_stale).toBe(false);expect(result.stale).toBe(true);expect(result.verdict).toBe('stale');expect(result.confidence).toBe(0.5);expect(result.stale_reason).toContain('resolution');expect(result.answer).toContain('not a fresh search');expect(result.quote_age_seconds).toBe(0);});
it.each(['financial-first','stock-first'])('canonical URL stays exact and reusable with %s acquisition',async direction=>{
 const first=direction==='financial-first'?await finance():await stock();
 expect(yahoo).toEqual(['https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d']);
 const second=direction==='financial-first'?await stock():await finance();
 expect(yahoo).toEqual(['https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d']);
 expect(first.stale).toBe(false);expect(second.stale).toBe(false);
});
it('identical raw key text cannot collide between chart and search namespaces',async()=>{
 const {cachedEquityQuote}=await import('../src/handlers/equityQuoteCache');
 const quoteLoad=vi.fn(async()=>chart),searchLoad=vi.fn(async()=>search);
 expect((await cachedEquityQuote('AAPL',quoteLoad,()=>{})).body).toBe(chart);
 expect((await cachedYahooSearch('AAPL',searchLoad,()=>{})).body).toBe(search);
 expect(quoteLoad).toHaveBeenCalledTimes(1);expect(searchLoad).toHaveBeenCalledTimes(1);
});
