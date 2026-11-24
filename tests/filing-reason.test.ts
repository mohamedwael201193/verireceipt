import{it,expect}from'vitest';import{readFileSync}from'node:fs';import{join}from'node:path';import{filingReason,buildFilingsFromSubmissions}from'../src/handlers/filings';
const j=JSON.parse(readFileSync(join(__dirname,'fixtures/corporate-registry/edgar-submissions-apple.json'),'utf8'));
it('derives exact count, form breakdown and latest date from captured EDGAR rows',()=>{
 const filings=buildFilingsFromSubmissions(j);expect(filings.length).toBeGreaterThan(0);const r=filingReason(filings,'Apple','captured window');
 expect(Object.values(r.by_type).reduce((a,b)=>a+b,0)).toBe(filings.length);for(const f of new Set(filings.map(f=>f.form)))expect(r.by_type[f]).toBe(filings.filter(x=>x.form===f).length);
 const date=filings.map(f=>f.filing_date).sort().at(-1);expect(r.latest?.filing_date).toBe(date);expect(r.sentence).toContain('In captured window');expect(r.sentence).toContain(`has ${filings.length}`);expect(r.sentence).toContain(`filed ${date}`);
});
it('zero count gives no latest filing and no invented date',()=>{expect(filingReason([],'Apple','window')).toMatchObject({by_type:{},latest:null});expect(filingReason([],'Apple','window').sentence).toContain('no latest matching filing')});
