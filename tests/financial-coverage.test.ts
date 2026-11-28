import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{}),storageBackend:()=> 'postgres'}));
import {saveReceipt} from '../src/core/storage';
import {handleFinancialData} from '../src/handlers/financialData';
import {FINANCIAL_COINS} from '../src/handlers/financialCoins';
import {resetSecFinancialCacheForTests} from '../src/handlers/secFinancialCache';
import {resetMarketCacheForTests} from '../src/handlers/marketSourceCache';
import {resetEquityCacheForTests} from '../src/handlers/equityQuoteCache';
import {sha256Hex} from '../src/core/receipt';
import {answerDiagnostics,sanitizeAnswerClass} from '../src/core/answerClass';
import {buildServer} from '../src/server';
const raw=(n:string)=>readFileSync('tests/fixtures/financial-coverage/'+n+'.json','utf8');
const index=readFileSync('tests/fixtures/corporate-registry/company-tickers-excerpt.json','utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();resetSecFinancialCacheForTests();resetMarketCacheForTests();resetEquityCacheForTests();});
function replay(empty=false){
 process.env.SEC_USER_AGENT='VeriReceipt test contact@example.com';vi.useFakeTimers({shouldAdvanceTime:true});vi.setSystemTime(new Date('2026-11-25T16:42:00Z'));
 const f=vi.fn(async(input:unknown)=>{const u=String(input);
  if(u.includes('coinpaprika'))return new Response(raw(u.split('/').at(-1)!));
  if(u.includes('company_tickers'))return new Response(index);
  if(u.includes('finance/search'))return new Response(raw(empty?'search-empty':'search-vod'));
  if(u.includes('finance/chart'))return new Response(raw('chart-vod'));
  if(u.includes('fundamentals-timeseries'))return new Response(raw('shares-vod'));
  if(u.includes('frankfurter'))return new Response(raw('fx-gbp'));
  throw Error('unexpected source');
 });vi.stubGlobal('fetch',f);return f;
}
it.each(FINANCIAL_COINS.filter(c=>!['ETH','SOL'].includes(c[1])))('real major crypto %s resolves by symbol and name with exact aggregation',async(id,symbol,name)=>{
 const f=replay();const body=raw(id),d=JSON.parse(body);
 for(const asset of [symbol,name]){const out=await handleFinancialData({asset});expect(out.symbol).toBe(symbol);expect(out.market_cap_usd).toBe(d.quotes.USD.market_cap);expect(out.volume_24h_usd).toBe(d.quotes.USD.volume_24h);expect(out.answer).toContain('aggregated');expect(answerDiagnostics('FINANCIAL_DATA_GENERAL',out).answerClass).toEqual({asset_resolution:'resolved',asset_shape:/^[A-Z0-9.^-]{1,10}$/.test(asset)?'ticker':'name'});}
 expect(f).toHaveBeenCalledOnce();const [receipt,evidence]=vi.mocked(saveReceipt).mock.calls[0];expect(JSON.parse(evidence).raw_bodies.coinpaprika).toBe(body);expect(receipt.raw_response_sha256).toBe(sha256Hex(evidence));
});
it('non-SEC exact equity uses real shares, minor-unit scale and actual USD reference FX',async()=>{
 replay();const out=await handleFinancialData({asset:'VOD.L'});const meta=JSON.parse(raw('chart-vod')).chart.result[0].meta,shares=23087114293,fx=JSON.parse(raw('fx-gbp')).rates.USD;
 expect(out.market_cap_usd).toBe(Math.round(meta.regularMarketPrice*.01*shares*fx));expect(out.volume_24h_usd).toBeNull();expect(out.answer).toContain('outside SEC index');expect(out.answer).toContain('minor-unit scale 0.01');expect(out.answer).toContain('not an official market cap');
 const [r,e]=vi.mocked(saveReceipt).mock.calls[0],ev=JSON.parse(e);expect(ev.raw_bodies.shares).toBe(raw('shares-vod'));expect(ev.raw_bodies.chart).toBe(raw('chart-vod'));expect(ev.raw_bodies.fx).toBe(raw('fx-gbp'));expect(ev.raw_bodies.search).toBe(raw('search-vod'));expect(r.raw_response_sha256).toBe(sha256Hex(e));
});
it('genuine real empty search returns receipted no_data, not zero or422',async()=>{
 const f=replay(true);const out=await handleFinancialData({asset:'zzqnonexistentasset98765'});expect(out.market_cap_usd).toBeNull();expect(out.verdict).toBe('no_data');expect(out.confidence).toBe(0);expect(out.reason_code).toBe('unsupported_asset');expect(f).toHaveBeenCalledTimes(2);expect(answerDiagnostics('FINANCIAL_DATA_GENERAL',out).answerClass).toEqual({asset_resolution:'unsupported_asset',asset_shape:'name',asset_len_bucket:'13-24'});expect(JSON.parse(vi.mocked(saveReceipt).mock.calls[0][1]).raw_bodies.search).toBe(raw('search-empty'));
});
it.each(['identity','future','currency','conflicting-shares','wrong-shares','bad-fx'])('non-SEC refuses %s rather than inventing market cap',async kind=>{
 replay();const f=vi.mocked(fetch),original=f.getMockImplementation()!;
 f.mockImplementation(async(u:any)=>{const text=String(u);
  if(text.includes('finance/chart')&&['identity','future','currency'].includes(kind)){const d=JSON.parse(raw('chart-vod'));const m=d.chart.result[0].meta;if(kind==='identity')m.symbol='OTHER';if(kind==='future')m.regularMarketTime=Date.now()/1000+1000;if(kind==='currency')m.currency='UNKNOWN';return new Response(JSON.stringify(d));}
  if(text.includes('fundamentals-timeseries')&&['wrong-shares','conflicting-shares'].includes(kind)){const d=JSON.parse(raw('shares-vod'));if(kind==='wrong-shares')d.timeseries.result[0].meta.symbol=['OTHER'];else d.timeseries.result[0].annualOrdinarySharesNumber.at(-1).reportedValue.raw=1;return new Response(JSON.stringify(d));}
  if(text.includes('frankfurter')&&kind==='bad-fx'){const d=JSON.parse(raw('fx-gbp'));d.base='EUR';return new Response(JSON.stringify(d));}
  return original(u);
 });await expect(handleFinancialData({asset:'VOD.L'})).rejects.toMatchObject({status:502});expect(saveReceipt).not.toHaveBeenCalled();
});
it('empty search storage failure stays fail closed',async()=>{replay(true);vi.mocked(saveReceipt).mockRejectedValueOnce(Error('storage'));await expect(handleFinancialData({asset:'zzqnonexistentasset98765'})).rejects.toMatchObject({code:'RECEIPT_PERSIST_FAILED'});});
it('closed asset telemetry only with real HTTP no-data, never raw asset',async()=>{
 replay(true);const log=vi.spyOn(console,'info').mockImplementation(()=>{}),app=buildServer();try{const res=await app.inject({method:'GET',url:'/v1/financial-data?asset=PRIVATE_ASSET'});expect(res.statusCode).toBe(200);expect(JSON.parse(String(log.mock.calls.at(-1)![0])).answer_class).toEqual({asset_resolution:'unsupported_asset',asset_shape:'other',asset_len_bucket:'13-24'});expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_ASSET');}finally{await app.close();}
 expect(sanitizeAnswerClass('FINANCIAL_DATA_GENERAL',{asset_resolution:'PRIVATE',asset:'PRIVATE'})).toBeUndefined();
});

it('ambiguous exact equity candidates remain unchosen with closed telemetry',async()=>{
 replay();const d=JSON.parse(raw('search-vod'));d.quotes.push({...d.quotes[0],symbol:'VOD.X'});vi.stubGlobal('fetch',async(u:unknown)=>new Response(String(u).includes('company_tickers')?index:JSON.stringify(d)));
 const err=await handleFinancialData({asset:'Vodafone Group Public Limited Company'}).catch(e=>e);expect(err.code).toBe('AMBIGUOUS_ASSET');expect(answerDiagnostics('FINANCIAL_DATA_GENERAL',err).answerClass).toEqual({asset_resolution:'ambiguous_asset',asset_shape:'name'});expect(saveReceipt).not.toHaveBeenCalled();
});
it.each(['wrong-id','future','stale','cap','volume'])('expanded crypto refuses %s control',async kind=>{
 replay();const d=JSON.parse(raw('doge-dogecoin'));if(kind==='wrong-id')d.id='eth-ethereum';if(kind==='future')d.last_updated='2099-01-01T00:00:00Z';if(kind==='stale')d.last_updated='2020-01-01T00:00:00Z';if(kind==='cap')d.quotes.USD.market_cap=1e15+1;if(kind==='volume')d.quotes.USD.volume_24h=-1;vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(d)));await expect(handleFinancialData({asset:'DOGE'})).rejects.toMatchObject({code:'BAD_MARKET_DATA'});expect(saveReceipt).not.toHaveBeenCalled();
});
it('non-SEC receipt persistence failure withholds answer',async()=>{replay();vi.mocked(saveReceipt).mockRejectedValueOnce(Error('storage'));await expect(handleFinancialData({asset:'VOD.L'})).rejects.toMatchObject({code:'RECEIPT_PERSIST_FAILED'});});

it.each(['stale-quote','stale-shares','future-shares','stale-fx','future-fx','cap-range'])('non-SEC handler freshness/range refuses %s with no receipt',async kind=>{
 replay();const f=vi.mocked(fetch),original=f.getMockImplementation()!;
 f.mockImplementation(async(u:any)=>{const text=String(u);
  if(text.includes('finance/chart')&&kind==='stale-quote'){const d=JSON.parse(raw('chart-vod'));d.chart.result[0].meta.regularMarketTime=Math.floor(Date.now()/1000)-8*86400;return new Response(JSON.stringify(d));}
  if(text.includes('fundamentals-timeseries')&&['stale-shares','future-shares','cap-range'].includes(kind)){
   const d=JSON.parse(raw('shares-vod'));for(const r of d.timeseries.result)for(const x of r[r.meta.type[0]]){if(kind==='stale-shares'){x.asOfDate='2020-01-01';x.reportedValue.raw=23087114293;}if(kind==='future-shares'){x.asOfDate='2099-01-01';x.reportedValue.raw=23087114293;}if(kind==='cap-range')x.reportedValue.raw=1e15;}return new Response(JSON.stringify(d));
  }
  if(text.includes('frankfurter')&&['stale-fx','future-fx'].includes(kind)){const d=JSON.parse(raw('fx-gbp'));d.date=kind==='stale-fx'?'2020-01-01':'2099-01-01';return new Response(JSON.stringify(d));}
  return original(u);
 });await expect(handleFinancialData({asset:'VOD.L'})).rejects.toMatchObject({status:502});expect(saveReceipt).not.toHaveBeenCalled();
});
