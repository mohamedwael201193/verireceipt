import {it,expect,beforeEach,afterEach,vi} from 'vitest';import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {handleFilings,filingBindingRow,__seedTickersCacheForTests,__clearTickersCacheForTests} from '../src/handlers/filings';
// Real recorded SEC EDGAR submissions for Apple (columns include acceptanceDateTime, items, primaryDocDescription).
const raw=readFileSync(join(__dirname,'fixtures/corporate-registry/edgar-submissions-apple.json'),'utf8');
const sec=JSON.parse(raw).filings.recent;
beforeEach(()=>{vi.stubEnv('SEC_USER_AGENT','recorded-only-no-network');__seedTickersCacheForTests({'0':{cik_str:320193,ticker:'AAPL',title:'Apple Inc.'}});});afterEach(()=>{vi.unstubAllEnvs();__clearTickersCacheForTests();});
const deps={fetchImpl:async()=>new Response(raw),saveReceiptImpl:async()=>{}};
const ASSERTION_KEYS=['accession','accession_number','form','filing_date','cik','entity','url','report_date','title'];
const secRow=(acc:string)=>{const i=sec.accessionNumber.indexOf(acc);return {form:sec.form[i],date:sec.filingDate[i],doc:sec.primaryDocument[i],accepted:sec.acceptanceDateTime[i],desc:sec.primaryDocDescription[i],items:sec.items[i]};};
it.each([['10-Q'],['8-K']])('%s filings_detail rows hold only binding identifiers and each binds to its recorded SEC row',async form=>{
 const r=await handleFilings({entity:'AAPL',period:'2026',form_type:form},deps);const rows=r.filings_detail as any[];
 expect(rows.length).toBeGreaterThan(0);
 for(const d of rows){
  expect(Object.keys(d).every(k=>ASSERTION_KEYS.includes(k))).toBe(true);expect(Object.keys(d).sort()).toEqual(['accession','filing_date','form','url']);
  const s=secRow(d.accession);expect(d.form).toBe(s.form);expect(d.filing_date).toBe(s.date);expect(d.url).toBe(`https://www.sec.gov/Archives/edgar/data/320193/${d.accession.replace(/-/g,'')}/${s.doc}`);
 }
 expect((r.urls as string[])).toEqual(rows.map(d=>d.url));
});
it('the acceptance time, description and 8-K items are still returned, in filings_disclosure keyed by accession, with real SEC values',async()=>{
 const r=await handleFilings({entity:'AAPL',period:'2026',form_type:'8-K'},deps);const rows=r.filings_detail as any[],disc=r.filings_disclosure as any[];
 expect(Array.isArray(disc)&&disc.length>0).toBe(true);
 for(const x of disc){const s=secRow(x.accession);expect(rows.some(d=>d.accession===x.accession)).toBe(true);
  if(x.accepted!==undefined)expect(x.accepted.slice(0,19)).toBe(String(s.accepted).slice(0,19));
  if(x.description!==undefined)expect(x.description).toBe(s.desc);if(x.items!==undefined)expect(x.items).toBe(s.items);
  expect(Object.keys(x).every(k=>['accession','accepted','description','items'].includes(k))).toBe(true);}
 expect(disc.some(x=>x.items!==undefined)).toBe(true);expect(disc.some(x=>x.accepted!==undefined)).toBe(true);expect(disc.some(x=>x.description!==undefined)).toBe(true);
});
it('filing_count, titles, urls and entity fields are unchanged by the row split',async()=>{
 const r=await handleFilings({entity:'AAPL',period:'2026',form_type:'10-Q'},deps);
 expect(r.filing_count).toBe(3);expect((r.filings as string[]).every(t=>/^Form 10-Q filed \d{4}-\d{2}-\d{2}$/.test(t))).toBe(true);expect(r.filings_detail).toHaveLength(3);
});
it('filingBindingRow drops every non-identifier key',()=>{
 expect(filingBindingRow({form:'8-K',accession:'0000000000-26-000001',filing_date:'2026-01-02',url:'https://www.sec.gov/Archives/edgar/data/1/000000000026000001/a.htm',accepted:'2026-01-02T00:00:00.000Z',description:'d',items:'2.02'})).toEqual({form:'8-K',accession:'0000000000-26-000001',filing_date:'2026-01-02',url:'https://www.sec.gov/Archives/edgar/data/1/000000000026000001/a.htm'});
});
