import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {parseMicrosoftReportedProfile} from '../src/handlers/reportedCompanyProfile';
const submissions=readFileSync('tests/fixtures/b2b-sec/microsoft-submissions.json','utf8');
const report=readFileSync('tests/fixtures/b2b-sec/microsoft-ar26.html','utf8');
const now=Date.parse('2026-11-25T01:40:00Z');
function changed(edit:(data:any)=>void){const data=JSON.parse(submissions);edit(data);return JSON.stringify(data);}
it('extracts latest supported dated full-time count and SEC industry from actual source bytes',()=>{
 const out=parseMicrosoftReportedProfile(submissions,report,now);
 expect(out.employee_count).toBe(223000);expect(out.employee_as_of).toBe('2026-06-30');expect(out.employee_basis).toBe('approximate full-time employees');expect(out.industry).toBe('Services-Prepackaged Software');expect(out.industry_basis).toBe('SEC SIC description');expect(out.domain).toBe('microsoft.com');expect(out.scope).toContain('not current payroll');expect(out.scope).toContain('not asserted to be headquarters');expect(out.business_address).toBe('ONE MICROSOFT WAY, REDMOND, WA, 98052-6399');
});
it.each(['cik','name','sic','sicDescription'])('refuses changed source identity %s',key=>{
 expect(()=>parseMicrosoftReportedProfile(changed(d=>d[key]='changed'),report,now)).toThrow();
});
it('refuses a new latest10-K instead of silently carrying the reviewed old count',()=>{
 const raw=changed(d=>{for(const key of Object.keys(d.filings.recent)){const values=d.filings.recent[key];values.unshift(key==='form'?'10-K':key==='reportDate'?'2027-06-30':key==='filingDate'?'2027-07-29':key==='accessionNumber'?'0001193125-27-000001':key==='primaryDocument'?'msft-20270630.htm':values[0]);}});
 expect(()=>parseMicrosoftReportedProfile(raw,report,Date.parse('2027-08-01T00:00:00Z'))).toThrow();
});
it('future and overly old report observations refuse',()=>{
 expect(()=>parseMicrosoftReportedProfile(submissions,report,Date.parse('2026-07-01T00:00:00Z'))).toThrow();
 expect(()=>parseMicrosoftReportedProfile(submissions,report,Date.parse('2028-01-01T00:00:00Z'))).toThrow();
});
it('rejects absent or conflicting human-capital section rather than guessing regional counts',()=>{
 expect(()=>parseMicrosoftReportedProfile(submissions,report.replace('we employed approximately','we previously employed approximately'),now)).toThrow();
 expect(()=>parseMicrosoftReportedProfile(submissions,report+' HUMAN CAPITAL RESOURCES As of June 30, 2026, we employed approximately 223,000 people on a full-time basis,',now)).toThrow();
});
it('source wording defines basis; full-time-equivalent is not silently treated as full-time people',()=>{
 expect(()=>parseMicrosoftReportedProfile(submissions,report.replace('people on a full-time basis','full-time equivalent employees'),now)).toThrow();
});
it('mismatched report year, misaligned arrays, missing address and malformed input refuse',()=>{
 expect(()=>parseMicrosoftReportedProfile(submissions,report.replace('<title>Microsoft 2026 Annual Report','<title>Microsoft 2025 Annual Report'),now)).toThrow();
 expect(()=>parseMicrosoftReportedProfile(changed(d=>d.filings.recent.form.pop()),report,now)).toThrow();
 expect(()=>parseMicrosoftReportedProfile(changed(d=>delete d.addresses.business.city),report,now)).toThrow();
 expect(()=>parseMicrosoftReportedProfile('null',report,now)).toThrow();
 expect(()=>parseMicrosoftReportedProfile(submissions,report,NaN)).toThrow();
});

it('a same-or-newer annual amendment is not silently ignored',()=>{
 const raw=changed(d=>{const i=d.filings.recent.form.findIndex((f:string)=>f==='10-K');d.filings.recent.form[0]='10-K/A';d.filings.recent.filingDate[0]=d.filings.recent.filingDate[i];});
 expect(()=>parseMicrosoftReportedProfile(raw,report,now)).toThrow();
});
it('only the explicit total human-capital sentence is extracted, not scripts or regional figures',()=>{
 expect(parseMicrosoftReportedProfile(submissions,report+'<script>HUMAN CAPITAL RESOURCES As of June 30, 2026, we employed approximately 999,999 people on a full-time basis,</script>',now).employee_count).toBe(223000);
 expect(()=>parseMicrosoftReportedProfile(submissions,report.replace('223,000 people on a full-time basis','223000 people on a full-time basis'),now)).toThrow();
});

it('report-date binding cannot drift independently of its reviewed document',()=>{
 const raw=changed(d=>{const i=d.filings.recent.form.findIndex((f:string)=>f==='10-K');d.filings.recent.reportDate[i]='2026-06-29';});
 expect(()=>parseMicrosoftReportedProfile(raw,report,now)).toThrow();
});
it('exact reviewed accession cannot drift independently of its report and document',()=>{
 const raw=changed(d=>{const i=d.filings.recent.form.findIndex((f:string)=>f==='10-K');d.filings.recent.accessionNumber[i]='0001193125-26-323661';});
 expect(()=>parseMicrosoftReportedProfile(raw,report,now)).toThrow();
});
it('a syntactically valid count above canonical range is refused',()=>{
 expect(()=>parseMicrosoftReportedProfile(submissions,report.replace('223,000 people on a full-time basis','100,000,001 people on a full-time basis'),now)).toThrow();
});
it('the reported numeric count is extracted rather than hardcoded',()=>{
 expect(parseMicrosoftReportedProfile(submissions,report.replace('223,000 people on a full-time basis','223,001 people on a full-time basis'),now).employee_count).toBe(223001);
});
