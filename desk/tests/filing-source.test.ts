// Synthetic SEC transport fixtures for verifier unit tests only. No live calls
// and no frozen benchmark expected values are used by these tests or verifier.
import { describe, expect, it, vi } from 'vitest';
import { verifyFilingSource } from '../src/filingSource';
const cik = 987654;
const accession = (n: number) => `0000987654-19-${String(n).padStart(6, '0')}`;
const rows = (forms = ['8-K', '10-Q', '8-K/A'], dates = ['2019-02-03', '2019-05-01', '2019-06-01']) => ({ accessionNumber: forms.map((_,i) => accession(i+1)), filingDate: dates, form: forms });
function fixture(over: { root?: any; history?: any; status?: number } = {}) {
 const root = over.root ?? { cik, name: 'Example Corp', filings: { recent: rows(), files: [] } };
 return vi.fn(async (url: string) => {
  if (over.status) return new Response('unavailable', {status:over.status});
  if (url.endsWith(`CIK${String(cik).padStart(10,'0')}.json`)) return Response.json(root);
  if (url.endsWith('-submissions-001.json')) return Response.json(over.history);
  return new Response('unplanned request', {status:404});
 });
}
const input = (over: Record<string, unknown> = {}) => ({ params: { entity: 'Form 8-K filings by Example Corp (CIK 987654)', period: 'calendar 2019' }, result: { filing_count: 1 }, ...over });
const opts = (f: any) => ({ f, now: new Date('2026-01-15T12:00:00Z'), secUserAgent:'VerifierUnitTest test@example.invalid' });
describe('filing primary-source semantics', () => {
 it('recounts exact form/date/issuer on SEC, excluding amendments', async () => {
  const f=fixture();const r=await verifyFilingSource(input(),opts(f));
  expect(r.status).toBe('verified');expect(r.details.primary_count).toBe(1);
  expect(r.sources[0].sha256).toMatch(/^[a-f0-9]{64}$/);expect(f).toHaveBeenCalledTimes(1);
 });
 it('rejects a wrong numeric count even when response fields say ok', async () => {
  const r=await verifyFilingSource(input({result:{filing_count:7}}),opts(fixture()));
  expect(r.status).toBe('failed');expect(r.checks.some(x=>!x.ok)).toBe(true);
 });
 it.each([
  {filing_count:1,filings:['SEC Form 8-K (2020-01-01) - Example Corp']},
  {filing_count:1,filings:['SEC Form 10-Q (2019-01-01) - Example Corp']},
  {filing_count:1,form_type:'10-K'},
  {filing_count:1,urls:['https://www.federalregister.gov/documents/example']},
 ])('rejects right count with contradictory returned source assertions: %j',async(result)=>{
  const r=await verifyFilingSource(input({result}),opts(fixture()));expect(r.status).toBe('failed');
 });
 it('rejects issuer mismatch, not just matching count',async()=>{
  const f=fixture({root:{cik:123,name:'Other Corp',filings:{recent:rows(),files:[]}}});
  expect((await verifyFilingSource(input(),opts(f))).status).toBe('failed');
 });
 it('includes every listed history page before claiming completeness',async()=>{
  const page={accessionNumber:[accession(4)],filingDate:['2019-08-01'],form:['8-K']};
  const root={cik,name:'Example Corp',filings:{recent:rows(),files:[{name:'CIK0000987654-submissions-001.json',filingCount:1,filingFrom:'2019-08-01',filingTo:'2019-08-01'}]}};
  const f=fixture({root,history:page});
  const good=await verifyFilingSource(input({result:{filing_count:2}}),opts(f));expect(good.status).toBe('verified');expect(good.sources).toHaveLength(2);
  expect((await verifyFilingSource(input(),opts(fixture({root,history:page})))).status).toBe('failed');
  expect((await verifyFilingSource(input({result:{filing_count:2}}),opts(fixture({root,history:{}})))).status).toBe('failed');
 });
 it('deduplicates matching accession rows, but rejects conflicting duplicates',async()=>{
  const recent={accessionNumber:[accession(1),accession(1)],filingDate:['2019-02-03','2019-02-03'],form:['8-K','8-K']};
  const root={cik,name:'Example Corp',filings:{recent,files:[]}};
  expect((await verifyFilingSource(input(),opts(fixture({root})))).status).toBe('verified');
  recent.form[1]='10-K';expect((await verifyFilingSource(input(),opts(fixture({root})))).status).toBe('failed');
 });
 it('will not accept zero without a complete primary response',async()=>{
  expect((await verifyFilingSource(input({result:{filing_count:0}}),opts(fixture({root:{}})))).status).toBe('failed');
 });
 it.each([403,429,500])('fails closed on SEC HTTP %i, without retry',async(status)=>{
  const f=fixture({status});expect((await verifyFilingSource(input(),opts(f))).status).toBe('failed');expect(f).toHaveBeenCalledTimes(1);
 });
 it('rejects unsafe history filenames rather than fetching an outside origin',async()=>{
  const root={cik,name:'Example Corp',filings:{recent:rows(),files:[{name:'https://example.invalid/steal',filingCount:1}]}};
  const f=fixture({root});expect((await verifyFilingSource(input(),opts(f))).status).toBe('failed');expect(f).toHaveBeenCalledTimes(1);
 });
 it('requires a SEC contact header, supported period and unambiguous form',async()=>{
  const f=fixture();expect((await verifyFilingSource(input(),{...opts(f),secUserAgent:''})).status).toBe('failed');
  expect((await verifyFilingSource(input({params:{...input().params,period:'some time'}}),opts(f))).status).toBe('failed');
  expect((await verifyFilingSource(input({params:{...input().params,form_type:'10-K'}}),opts(f))).status).toBe('failed');
  expect(f).not.toHaveBeenCalled();
 });
 it('rejects malformed unequal arrays, impossible dates and incomplete history counts',async()=>{
  for(const recent of [ {...rows(),form:['8-K']}, {...rows(),filingDate:['2019-02-30','2019-05-01','2019-06-01']} ]){
   expect((await verifyFilingSource(input(),opts(fixture({root:{cik,name:'Example Corp',filings:{recent,files:[]}}})))).status).toBe('failed');
  }
 });
});
