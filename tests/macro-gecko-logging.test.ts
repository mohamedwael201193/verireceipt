import {describe,it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {handleMacro,resetMacroCachesForTests} from '../src/handlers/macroEconomic';
import {macroFetchClass} from '../src/core/macroStageLog';
import {refusalParamClass,countryClass,yearClass} from '../src/core/refusalClass';
import {recordGeckoCall,geckoCallsLast60sBucket,resetGeckoCallCounterForTests} from '../src/core/geckoCallCounter';
import {sanitizeAnswerClass} from '../src/core/answerClass';

const obs=readFileSync('tests/fixtures/macro-series/NE.TRD.GNFS.ZS-observation.json','utf8');
const catalogRows=[{id:'DEU',iso2Code:'DE',name:'Germany',region:{value:'Europe'}}];
const catalog=JSON.stringify([{},catalogRows]);
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.restoreAllMocks();resetMacroCachesForTests();resetGeckoCallCounterForTests();});

function stages(log:any){return log.mock.calls.map((c:any)=>{try{return JSON.parse(String(c[0]));}catch{return null;}}).filter((x:any)=>x?.event==='macro_stage_failure');}

describe('macro_stage_failure',()=>{
 it.each([
  ['429',()=>new Response('x',{status:429}),'429'],
  ['404',()=>new Response('x',{status:404}),'4xx'],
  ['503',()=>new Response('x',{status:503}),'5xx'],
  ['abort',()=>{throw Object.assign(new Error('aborted'),{name:'AbortError'});},'timeout'],
  ['network',()=>{throw new TypeError('fetch failed');},'network'],
 ])('indicator fetch %s',async(_n,make,cls)=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>{});
  vi.stubGlobal('fetch',async(u:any)=>String(u).includes('/indicator/')?make():new Response(catalog));
  await expect(handleMacro({indicator:'NE.TRD.GNFS.ZS',country:'Germany',year:'2022'})).rejects.toMatchObject({code:'WORLD_BANK_UNAVAILABLE'});
  const rows=stages(log);
  expect(rows.at(-1)).toEqual({event:'macro_stage_failure',stage:'indicator_fetch',http_class:cls});
  const j=JSON.stringify(log.mock.calls);expect(j).not.toContain('Germany');expect(j).not.toContain('NY.GDP.MKTP.CD');expect(j).not.toContain('NE.TRD.GNFS.ZS');
 });
 it('indicator parse error',async()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>{});
  vi.stubGlobal('fetch',async(u:any)=>new Response(String(u).includes('/indicator/')?'not json':catalog));
  await expect(handleMacro({indicator:'NE.TRD.GNFS.ZS',country:'Germany',year:'2022'})).rejects.toMatchObject({code:'WORLD_BANK_UNAVAILABLE'});
  expect(stages(log).at(-1)).toMatchObject({stage:'indicator_parse'});
 });
 it('catalog fetch and parse failures',async()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>{});
  vi.stubGlobal('fetch',async()=>new Response('x',{status:429}));
  await expect(handleMacro({indicator:'NE.TRD.GNFS.ZS',country:'Germany'})).rejects.toBeTruthy();
  expect(stages(log).at(-1)).toEqual({event:'macro_stage_failure',stage:'catalog',http_class:'429'});
  resetMacroCachesForTests();
  vi.stubGlobal('fetch',async()=>new Response('not json'));
  await expect(handleMacro({indicator:'NE.TRD.GNFS.ZS',country:'Germany'})).rejects.toBeTruthy();
  expect(stages(log).at(-1)).toEqual({event:'macro_stage_failure',stage:'catalog',http_class:'parse'});
  expect(JSON.stringify(log.mock.calls)).not.toContain('Germany');
 });
 it('macroFetchClass uses only the closed set',()=>{
  expect(macroFetchClass({status:429})).toBe('429');expect(macroFetchClass({status:500})).toBe('5xx');expect(macroFetchClass({status:403})).toBe('4xx');
  expect(macroFetchClass(Error('macro source deadline'))).toBe('timeout');expect(macroFetchClass(Error('boom'))).toBe('network');expect(macroFetchClass(undefined)).toBe('network');
 });
});

describe('macro refusal classes',()=>{
 it('country and year classes are fixed labels',()=>{
  expect([countryClass('DE'),countryClass('deu'),countryClass('Germany'),countryClass('??')]).toEqual(['iso2','iso3','name','other']);
  expect([yearClass('2022'),yearClass('2019-2022'),yearClass('last year')]).toEqual(['yyyy','range','other']);
  const c=refusalParamClass('/v1/macro','UNSUPPORTED_INDICATOR',{indicator:'gdp',country:'Germany',year:'2022'})!;
  expect(c).toMatchObject({country_class:'name',year_class:'yyyy'});
  expect(JSON.stringify(c)).not.toContain('Germany');
 });
});

describe('gecko call counter',()=>{
 it('buckets and expiry',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const add=(n:number)=>{for(let i=0;i<n;i++)recordGeckoCall();};
  expect(geckoCallsLast60sBucket()).toBe('0-10');
  add(10);expect(geckoCallsLast60sBucket()).toBe('0-10');
  add(1);expect(geckoCallsLast60sBucket()).toBe('11-20');
  add(10);expect(geckoCallsLast60sBucket()).toBe('21-30');
  add(10);expect(geckoCallsLast60sBucket()).toBe('>30');
  vi.advanceTimersByTime(59_000);expect(geckoCallsLast60sBucket()).toBe('>30');
  vi.advanceTimersByTime(1_001);expect(geckoCallsLast60sBucket()).toBe('0-10');
 });
 it('caps stored timestamps',()=>{for(let i=0;i<500;i++)recordGeckoCall();expect(geckoCallsLast60sBucket()).toBe('>30');});
 it('answer_class accepts only closed bucket values',()=>{
  expect(sanitizeAnswerClass('TOKEN_HOLDER_COUNT_GENERAL',{upstream_http_class:'429',gecko_calls_last_60s_bucket:'21-30'})).toEqual({upstream_http_class:'429',gecko_calls_last_60s_bucket:'21-30'});
  expect(sanitizeAnswerClass('TOKEN_HOLDER_COUNT_GENERAL',{gecko_calls_last_60s_bucket:'37'})).toBeUndefined();
 });
});
describe('validator failures keep their own stage',()=>{
 it.each([
  ['row shape',JSON.stringify({a:1}),'row_shape','none'],
  ['nonnumeric',JSON.stringify([{},[{indicator:{id:'NE.TRD.GNFS.ZS'},countryiso3code:'DEU',date:'2022',value:'abc'}]]),'nonnumeric','none'],
 ])('%s',async(_n,body,stage,cls)=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>{});
  vi.stubGlobal('fetch',async(u:any)=>new Response(String(u).includes('/indicator/')?body:catalog));
  await expect(handleMacro({indicator:'NE.TRD.GNFS.ZS',country:'Germany',year:'2022'})).rejects.toMatchObject({code:'WORLD_BANK_UNAVAILABLE'});
  expect(stages(log).at(-1)).toEqual({event:'macro_stage_failure',stage,http_class:cls});
 });
});
