import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleMacro,normalizeIndicator,resetMacroCachesForTests} from '../src/handlers/macroEconomic';
import {sha256Hex} from '../src/core/receipt';
const read=(id:string,kind='observation')=>readFileSync(`tests/fixtures/macro-series/${id}-${kind}.json`,'utf8');
const catalog=JSON.stringify([{page:1},[{id:'USA',iso2Code:'US',name:'United States',region:{value:'North America'}},{id:'BRA',iso2Code:'BR',name:'Brazil',region:{value:'Latin America & Caribbean'}}]]);
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();resetMacroCachesForTests();});
const table:Array<[string[],string,string,string]>=[
 [['gdp','gdp current us','nominal gdp','ny.gdp.mktp.cd'],'gdp','NY.GDP.MKTP.CD','current US dollars'],
 [['real gdp','gdp constant','ny.gdp.mktp.kd'],'real gdp','NY.GDP.MKTP.KD','constant 2015 US dollars'],
 [['real interest rate','interest rate','fr.inr.rinr'],'real interest rate','FR.INR.RINR','% real interest rate'],
 [['trade % of gdp','ne.trd.gnfs.zs'],'trade','NE.TRD.GNFS.ZS','% of GDP (exports plus imports of goods and services)'],
];
it.each(table)('aliases %j select exactly %s and recorded id/unit',async(aliases,canonical,id,unit)=>{
 for(const indicator of aliases){resetMacroCachesForTests();const raw=read(id),row=JSON.parse(raw)[1][0];const f=vi.fn(async(url:any)=>new Response(String(url).includes('/indicator/')?raw:catalog));vi.stubGlobal('fetch',f);
  expect(normalizeIndicator(indicator)).toBe(canonical);const out=await handleMacro({indicator,country:id==='FR.INR.RINR'?'BR':'US',year:'2022'});
  expect(out.indicator_id).toBe(id);expect(out.answer).toContain('World Bank '+id);expect(out.answer).toContain(`${row.value} ${unit}`);expect(f.mock.calls.some(([url])=>String(url).includes('/indicator/'+id+'?'))).toBe(true);
  expect((out.receipt as any).raw_response_sha256).toBe(sha256Hex(raw));expect(vi.mocked(saveReceipt).mock.calls.at(-1)?.[1]).toBe(raw);
  expect(out.rate_pct).toBe(id==='NY.GDP.MKTP.CD'||id==='NY.GDP.MKTP.KD'?null:Math.round(row.value*1e6)/1e6);
 }
});
it('bare interest rate names the real measure and does not pretend to be a policy rate',async()=>{vi.stubGlobal('fetch',async(url:any)=>new Response(String(url).includes('/indicator/')?read('FR.INR.RINR'):catalog));const out=await handleMacro({indicator:'interest rate',country:'BR',year:'2022'});expect(out.answer).toContain('World Bank real interest rate');expect(out.answer).toContain('not a policy rate');expect(out.answer).toContain('GDP deflator');expect(out.indicator_id).toBe('FR.INR.RINR');});
it('constant GDP base2015 is grounded in recorded API metadata, not nominal dollars',()=>{const metadata=JSON.parse(read('NY.GDP.MKTP.KD','metadata'))[1][0];expect(metadata.id).toBe('NY.GDP.MKTP.KD');expect(metadata.name).toContain('constant 2015 US$');expect(metadata.sourceNote).toContain('reference year for this adjustment is 2015');});
it.each([['gdp growth','gdp growth'],['gdp growth rate','gdp growth'],['gdp growth annual','gdp growth'],['economic growth','gdp growth'],['gdp per capita','gdp per capita'],['inflation rate','inflation'],['consumer price inflation','inflation'],['cpi inflation','inflation']])('existing-series alias %s stays %s', (input,canonical)=>expect(normalizeIndicator(input)).toBe(canonical));
it('non-macro foo remains422 with no default or network call',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);await expect(handleMacro({indicator:'foo',country:'US'})).rejects.toMatchObject({status:422,code:'UNSUPPORTED_INDICATOR'});expect(f).not.toHaveBeenCalled();});
it.each(['gdp per hour','nominal interest rate','policy interest rate','inflation expectations'])('unmapped measure %s discloses catalog-only no-data',async indicator=>{vi.stubGlobal('fetch',async(u:unknown)=>new Response(String(u).includes('source=2')?readFileSync('tests/fixtures/macro-coverage/catalog.json','utf8'):catalog));const out=await handleMacro({indicator,country:'US'});expect(out.verdict).toBe('no_data');expect(out.rate_pct).toBeNull();expect(out).not.toHaveProperty('indicator_id');});
it.each([['gdp growth','NY.GDP.MKTP.KD.ZG'],['gdp per capita','NY.GDP.PCAP.CD']])('collision guard %s requests its original exact id %s',async(indicator,id)=>{const raw=readFileSync('tests/fixtures/macro-alias/deu-'+(indicator==='gdp growth'?'gdp':'gdp-per-capita')+'-2022.json','utf8');const f=vi.fn(async(url:any)=>new Response(String(url).includes('/indicator/')?raw:catalog));vi.stubGlobal('fetch',f);const out=await handleMacro({indicator,country:'US',year:'2022'});expect(out.indicator_id).toBe(id);expect(f.mock.calls.some(([u])=>String(u).includes('/indicator/'+id+'?'))).toBe(true);});
it.each([['gdp','NY.GDP.MKTP.CD','current US dollars'],['real gdp','NY.GDP.MKTP.KD','constant 2015 US dollars']])('test-only low dollar control %s never populates rate_pct even inside0to100',async(indicator,id,unit)=>{const projected=JSON.parse(read(id));projected[1][0].value=42.125;const testOnlyBody=JSON.stringify(projected);vi.stubGlobal('fetch',async(url:any)=>new Response(String(url).includes('/indicator/')?testOnlyBody:catalog));const out=await handleMacro({indicator,country:'US',year:'2022'});expect(out.indicator_id).toBe(id);expect(out.rate_pct).toBeNull();expect(out.answer).toContain('42.125 '+unit);expect(out.verdict).toBe('verified');expect(vi.mocked(saveReceipt).mock.calls.at(-1)?.[1]).toBe(testOnlyBody);});
