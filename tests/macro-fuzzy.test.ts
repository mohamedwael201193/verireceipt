import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{}),storageBackend:()=> 'postgres'}));
import {handleMacro,normalizeIndicator,resetMacroCachesForTests} from '../src/handlers/macroEconomic';
import {answerDiagnostics,sanitizeAnswerClass} from '../src/core/answerClass';
import {buildServer} from '../src/server';
const catalog=readFileSync('tests/fixtures/macro-fuzzy/countries.json','utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();resetMacroCachesForTests();});
it.each([
 ['latest annual inflation rate','inflation'],['current cpi','inflation'],['please show me unemployment rate','unemployment rate'],['growth gdp','gdp growth'],['latest population data','population'],['exports','exports'],
])('bounded word matching %s selects %s', (input,expected)=>expect(normalizeIndicator(input)).toBe(expected));
it.each(['policy interest rate','inflation expectations','GDP per hour','unemployment inflation','not unemployment','exports volume'])('qualified %s uses exact catalog discovery without measure substitution',async indicator=>{
 const f=vi.fn(async(u:unknown)=>new Response(String(u).includes('source=2')?readFileSync('tests/fixtures/macro-coverage/catalog.json','utf8'):catalog));vi.stubGlobal('fetch',f);
 const out=await handleMacro({indicator,country:'US'});expect(out.verdict).toBe('no_data');expect(out.rate_pct).toBeNull();expect(out).not.toHaveProperty('indicator_id');
});
it('exports now uses actual exports rather than total trade',async()=>{
 const raw=readFileSync('tests/fixtures/macro-coverage/NE.EXP.GNFS.ZS-observation.json','utf8');vi.stubGlobal('fetch',async(u:unknown)=>new Response(String(u).includes('/indicator/')?raw:catalog));
 const out=await handleMacro({indicator:'exports',country:'US',year:'2022'});expect(out.indicator_id).toBe('NE.EXP.GNFS.ZS');expect(out.answer).toContain('exports of goods and services');expect(out.answer).not.toContain('Closest series');
});
it('unsupported HTTP diagnostics retain closed rejection only, no raw indicator or unknown keys',async()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});const f=vi.fn();vi.stubGlobal('fetch',f);const app=buildServer();
 try{const res=await app.inject({method:'GET',url:'/v1/macro?indicator=PRIVATE_INDICATOR&country=US&PRIVATE_KEY=PRIVATE_VALUE'});expect(res.statusCode).toBe(422);expect(f).not.toHaveBeenCalled();const rows=log.mock.calls.map(c=>String(c[0]));const row=JSON.parse(rows.at(-1)!);expect(row.answer_class).toEqual({alias_known:false,indicator_selection:'rejected',indicator_rejection:'unsupported_or_qualified'});expect(rows.join(' ')).not.toContain('PRIVATE');}finally{await app.close();}
});
it('macro telemetry sanitizer rejects arbitrary values and getters',()=>{
 expect(sanitizeAnswerClass('MACRO_ECONOMIC_INDICATOR_GENERAL',{alias_known:true,matched_series:'PRIVATE',indicator_selection:'PRIVATE',indicator_rejection:'PRIVATE',indicator:'PRIVATE'})).toEqual({alias_known:true});
 const obj=Object.defineProperty({},'matched_series',{get(){throw Error('PRIVATE');}});expect(sanitizeAnswerClass('MACRO_ECONOMIC_INDICATOR_GENERAL',obj)).toBeUndefined();
});

it.each([['latest annual inflation rate','FP.CPI.TOTL.ZG','cpi'],['growth gdp','NY.GDP.MKTP.KD.ZG','gdp'],['latest population data','SP.POP.TOTL','population']])('closest handler %s binds real published series %s',async(indicator,id,file)=>{
 const raw=readFileSync('tests/fixtures/macro-alias/deu-'+file+'-2022.json','utf8');const f=vi.fn(async(u:unknown)=>new Response(String(u).includes('/indicator/')?raw:catalog));vi.stubGlobal('fetch',f);
 const out=await handleMacro({indicator,country:'DE',year:'2022'});expect(out.indicator_id).toBe(id);expect(out.answer).toContain('Closest series used');expect(out.answer).toContain('World Bank '+id);expect(f.mock.calls.some(([u])=>String(u).includes('/indicator/'+id+'?'))).toBe(true);
 expect(answerDiagnostics('MACRO_ECONOMIC_INDICATOR_GENERAL',out).answerClass).toEqual({alias_known:true,matched_series:id,indicator_selection:'closest'});
});
