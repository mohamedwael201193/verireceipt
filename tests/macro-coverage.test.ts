import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
vi.mock('../src/core/storage',()=>({saveReceipt:vi.fn(async()=>{})}));
import {saveReceipt} from '../src/core/storage';
import {handleMacro,normalizeIndicator,resetMacroCachesForTests} from '../src/handlers/macroEconomic';
import {macroInputDiagnostic} from '../src/handlers/macroSeriesDiscovery';
import {sha256Hex} from '../src/core/receipt';
const dir='tests/fixtures/macro-coverage/';
const read=(file:string)=>readFileSync(dir+file,'utf8');
const catalog=readFileSync('tests/fixtures/macro-fuzzy/countries.json','utf8');
const series=[
 ['youth unemployment rate','SL.UEM.1524.ZS'],['female unemployment','SL.UEM.TOTL.FE.ZS'],['male unemployment','SL.UEM.TOTL.MA.ZS'],
 ['national unemployment rate','SL.UEM.TOTL.NE.ZS'],['labor force participation rate','SL.TLF.CACT.ZS'],
 ['gdp per capita growth','NY.GDP.PCAP.KD.ZG'],['exports','NE.EXP.GNFS.ZS'],['imports','NE.IMP.GNFS.ZS'],
 ['lending interest rate','FR.INR.LEND'],['deposit interest rate','FR.INR.DPST'],['central government debt','GC.DOD.TOTL.GD.ZS'],
 ['official exchange rate','PA.NUS.FCRF'],['population growth','SP.POP.GROW'],['foreign direct investment','BX.KLT.DINV.WD.GD.ZS'],['gdp deflator inflation','NY.GDP.DEFL.KD.ZG'],
];
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.clearAllMocks();resetMacroCachesForTests();});
it.each(series)('real recorded metadata and observation bind %s to %s',async(indicator,id)=>{
 const raw=read(id+'-observation.json'),meta=JSON.parse(read(id+'-metadata.json'))[1][0],row=JSON.parse(raw)[1][0];
 expect(meta.id).toBe(id);expect(meta.source.id).toBe('2');
 const fetcher=vi.fn(async(url:unknown)=>new Response(String(url).includes('/indicator/')?raw:catalog));vi.stubGlobal('fetch',fetcher);
 const out=await handleMacro({indicator,country:'US',year:'2022'});
 expect(out.indicator_id).toBe(id);expect(out.value).toBe(row.value);expect(out.answer).toContain(id);expect(out.year).toBe(2022);
 expect(out.verdict).toBe(row.value===null?'no_data':'verified');
 expect((out.receipt as any).raw_response_sha256).toBe(sha256Hex(raw));expect(vi.mocked(saveReceipt).mock.calls.at(-1)?.[1]).toBe(raw);
 expect(fetcher.mock.calls.some(([u])=>String(u).includes('/indicator/'+id+'?date=2022'))).toBe(true);
 if(id==='PA.NUS.FCRF'||row.value===null||row.value>100)expect(out.rate_pct).toBeNull();
 else expect(out.rate_pct).toBe(Math.round(row.value*1e6)/1e6);
});
it('arbitrary input diagnostic never leaks email, name, numeric secret, controls, or country',async()=>{
 const spy=vi.spyOn(console,'info').mockImplementation(()=>{});const f=vi.fn();vi.stubGlobal('fetch',f);
 const input='private.person@example.invalid 123456789 unemployment\nPRIVATEPERSON';
 await expect(handleMacro({indicator:input,country:'PRIVATECOUNTRY'})).rejects.toMatchObject({code:'UNSUPPORTED_INDICATOR'});
 const logged=spy.mock.calls.map(c=>String(c[0])).join(' ');expect(logged).not.toContain('private');expect(logged).not.toContain('123456789');expect(logged).not.toContain('PRIVATE');
 const row=JSON.parse(spy.mock.calls[0][0] as string);expect(row.indicator_terms).toEqual(['unemployment']);expect(row.indicator_sha256).toBe(sha256Hex(input));expect(f).not.toHaveBeenCalled();
 expect(macroInputDiagnostic('policy interest rate').indicator_terms).toEqual(['interest','policy','rate']);
});
function discoveryFetch(metadata=read('catalog.json'),observation?:string){const f=vi.fn(async(url:unknown)=>new Response(String(url).includes('source=2')?metadata:String(url).includes('/indicator/')?observation!:catalog));vi.stubGlobal('fetch',f);return f;}
it('unknown macro returns receipted catalog-only coverage limitation without claiming source observation',async()=>{
 const f=discoveryFetch();const out=await handleMacro({indicator:'policy interest rate',country:'US',year:'2022'});
 expect(out.verdict).toBe('no_data');expect(out.rate_pct).toBeNull();expect(out).not.toHaveProperty('indicator_id');expect(out.answer).toContain('coverage limitation');expect(out.answer).toContain('not evidence');
 expect(f.mock.calls.some(([u])=>String(u).includes('/country/US/indicator/'))).toBe(false);
 expect((out.receipt as any).raw_response_sha256).toBe(sha256Hex(read('catalog.json')));
});
it.each(['incomplete','malformed','mislabeled-source'])('catalog %s fails closed, never no-data',async mode=>{
 let raw=read('catalog.json');if(mode==='malformed')raw='bad';else{const data=JSON.parse(raw);if(mode==='incomplete')data[0].pages=2;else data[1][0].source.id='99';raw=JSON.stringify(data);}
 discoveryFetch(raw);await expect(handleMacro({indicator:'policy interest rate',country:'US'})).rejects.toMatchObject({status:502,code:'WORLD_BANK_UNAVAILABLE'});
});
it('catalog fetch failure never becomes no-data',async()=>{vi.stubGlobal('fetch',async(url:unknown)=>{if(String(url).includes('source=2'))throw Error('down');return new Response(catalog);});await expect(handleMacro({indicator:'policy interest rate',country:'US'})).rejects.toMatchObject({code:'WORLD_BANK_UNAVAILABLE'});});
it('no-data catalog receipt persistence is mandatory',async()=>{discoveryFetch();vi.mocked(saveReceipt).mockRejectedValueOnce(Error('disk'));await expect(handleMacro({indicator:'policy interest rate',country:'US'})).rejects.toMatchObject({code:'RECEIPT_PERSIST_FAILED'});});
it.each(['series','country'])('new-series mismatched %s never serves a number',async field=>{const raw=JSON.parse(read('NE.EXP.GNFS.ZS-observation.json'));if(field==='series')raw[1][0].indicator.id='NE.TRD.GNFS.ZS';else raw[1][0].countryiso3code='DEU';discoveryFetch(undefined,JSON.stringify(raw));await expect(handleMacro({indicator:'exports',country:'US',year:'2022'})).rejects.toMatchObject({code:'WORLD_BANK_UNAVAILABLE'});});
it.each(['FM.LBL.BMNY.GD.ZS','Broad money (% of GDP)'])('exact official catalog name/code %s serves only its bound measure',async indicator=>{
 const raw=read('FM.LBL.BMNY.GD.ZS-observation.json'),row=JSON.parse(raw)[1][0];discoveryFetch(undefined,raw);
 const out=await handleMacro({indicator,country:'US',year:'2022'});expect(out.indicator_id).toBe('FM.LBL.BMNY.GD.ZS');expect(out.indicator).toBe('Broad money (% of GDP)');expect(out.value).toBe(row.value);expect(out.answer).toContain('Broad money');expect(out.answer).not.toContain('Closest series');expect(out.rate_pct).toBeNull();
});
it('ambiguous normalized catalog metadata never picks the first series',async()=>{const data=JSON.parse(read('catalog.json'));const row=data[1].find((x:any)=>x.id==='FM.LBL.BMNY.GD.ZS');data[1].push({...row,id:'FM.TEST.OTHER'});data[0].total=data[1].length;discoveryFetch(JSON.stringify(data));const out=await handleMacro({indicator:'Broad money (% of GDP)',country:'US'});expect(out.verdict).toBe('no_data');expect(out).not.toHaveProperty('indicator_id');});
it('discovery cache reuse discloses the original acquisition time on its receipt',async()=>{const f=discoveryFetch();const a=await handleMacro({indicator:'policy interest rate',country:'US'});const b=await handleMacro({indicator:'policy interest rate',country:'US'});expect((b.receipt as any).fetched_at).toBe(a.as_of);expect(b.as_of).toBe(a.as_of);expect(f.mock.calls.filter(([u])=>String(u).includes('source=2'))).toHaveLength(1);});
it('rate_pct never reports an absolute exchange-rate value even inside0to100',async()=>{const raw=read('PA.NUS.FCRF-observation.json');discoveryFetch(undefined,raw);const out=await handleMacro({indicator:'official exchange rate',country:'US',year:'2022'});expect(out.value).toBe(1);expect(out.rate_pct).toBeNull();expect(out.unit).toContain('local currency units per US dollar');});

it.each(['latest exports','current annual exports','please show me exports'])('noise-qualified %s selects actual exports, never total trade',async indicator=>{
 expect(normalizeIndicator(indicator)).toBe('exports');
 const raw=read('NE.EXP.GNFS.ZS-observation.json');const f=discoveryFetch(undefined,raw);
 const out=await handleMacro({indicator,country:'US',year:'2022'});expect(out.indicator_id).toBe('NE.EXP.GNFS.ZS');expect(out.indicator_id).not.toBe('NE.TRD.GNFS.ZS');
 expect(f.mock.calls.some(([url])=>String(url).includes('/NE.EXP.GNFS.ZS?'))).toBe(true);expect(f.mock.calls.some(([url])=>String(url).includes('/NE.TRD.GNFS.ZS?'))).toBe(false);
});
