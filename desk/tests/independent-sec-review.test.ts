// Synthetic transport controls only, no paid answers or gold data.
import {it,expect} from 'vitest';
import {verifyFilingSource} from '../src/filingSource.js';
const accession='0000987654-24-000001';
const url='https://www.sec.gov/Archives/edgar/data/987654/000098765424000001/q.htm';
const recent=()=>({accessionNumber:[accession],filingDate:['2024-04-24'],reportDate:['2024-03-31'],form:['10-Q'],primaryDocument:['q.htm']});
const answer=()=>({filing_count:1,entity:'Example Corp (CIK 987654)',filings:['Example Corp 10-Q for the period ending 2024-03-31'],recent:[{agency:'SEC',publication_date:'2024-04-24',title:'Example Corp 10-Q for the period ending 2024-03-31',type:'10-Q',url}]});
async function check(result:any=answer(),rows:any=recent(),files:any[]=[],history?:any){return verifyFilingSource({params:{entity:'Form 10-Q filings by Example Corp (CIK 987654)',period:'2024'},result},{now:new Date('2026-01-01'),secUserAgent:'Unit unit@example.invalid',f:async input=>Response.json(String(input).endsWith('-001.json')?history:{cik:987654,name:'Example Corp',filings:{recent:rows,files}})});}

it('independent detail alias contradictions must not be ignored',async()=>{const a=answer() as any;a.filings_detail=[{accession,form:'10-Q',filing_date:'2024-04-24',report_date:'2024-03-31',reportDate:'2024-01-01'}];expect((await check(a)).status).toBe('failed')});
it('independent Unicode issuer text cannot normalize away extra assertions',async()=>{const a=answer() as any;a.entity='Example Corp ☃ (CIK 987654)';expect((await check(a)).status).toBe('failed')});
it('independent empty SEC rows still validate reportDate coverage',async()=>{const rows={accessionNumber:[],filingDate:[],form:[],reportDate:['2024-03-31']};expect((await check({filing_count:0},rows)).status).toBe('failed')});

// Reviewer seam control adapted to the explicit providerResult API. Reconciliation
// remains unchanged; raw assertion checks are separate from numeric selection.
it('independent provider-only contradiction is checked separately from reconciliation',async()=>{const {reconcilePrimaryAnswer}=await import('../src/sourceTypes');const a=answer() as any;const provider={...a,recent:[{...a.recent[0],publication_date:'2024-03-31'}]};const shaped={filing_count:1,entity:a.entity};const result=reconcilePrimaryAnswer('REGULATORY_FILING_MONITOR_GENERAL',shaped,{filing_count:'ok',entity:'ok'},provider,true).result;expect(result).not.toHaveProperty('recent');const r=await verifyFilingSource({params:{entity:'Form 10-Q filings by Example Corp (CIK 987654)',period:'2024'},result,providerResult:provider},{now:new Date('2026-01-01'),secUserAgent:'Unit unit@example.invalid',f:async()=>Response.json({cik:987654,name:'Example Corp',filings:{recent:recent(),files:[]}})});expect(r.status).toBe('failed');});
