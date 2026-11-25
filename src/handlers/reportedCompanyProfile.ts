// Implementation-only reported profile. Not routed, declared or registered.
// A dated annual-report figure is not current payroll or universal B2B coverage.
export interface ReportedCompanyProfile {
 company:string; domain:string; employee_count:number; industry:string;
 employee_as_of:string; employee_basis:'approximate full-time employees';
 industry_basis:'SEC SIC description'; report_date:string; filing_date:string;
 accession:string; business_address:string; scope:string;
}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function refuse():never{throw new Error('reported company profile is unsupported or source identity changed');}
function date(value:unknown):string{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)refuse();return value;
}
/** Microsoft-only reviewed report and identity. Receives source bytes, never fetches user URLs. */
export function parseMicrosoftReportedProfile(submissionsRaw:string,reportHtml:string,nowMs:number):ReportedCompanyProfile{
 if(Buffer.byteLength(submissionsRaw)>1000000||Buffer.byteLength(reportHtml)>2000000||!Number.isFinite(nowMs))refuse();
 const data:unknown=JSON.parse(submissionsRaw);if(!record(data)||String(data.cik)!=='0000789019'||data.name!=='MICROSOFT CORP'||data.sic!=='7372'||data.sicDescription!=='Services-Prepackaged Software')refuse();
 if(!record(data.filings)||!record(data.filings.recent))refuse();const recent=data.filings.recent;
 const names=['form','reportDate','filingDate','accessionNumber','primaryDocument'] as const;
 if(names.some(n=>!Array.isArray(recent[n])))refuse();const forms=recent.form as unknown[];
 if(names.some(n=>(recent[n] as unknown[]).length!==forms.length))refuse();
 const annual=forms.map((form,index)=>({form,index})).filter(row=>row.form==='10-K');if(!annual.length)refuse();
 const latest=annual.map(({index})=>({report:date((recent.reportDate as unknown[])[index]),filed:date((recent.filingDate as unknown[])[index]),accession:(recent.accessionNumber as unknown[])[index],document:(recent.primaryDocument as unknown[])[index]})).sort((a,b)=>b.filed.localeCompare(a.filed));
 const row=latest[0];if(forms.some((form,index)=>form==='10-K/A'&&date((recent.filingDate as unknown[])[index])>=row.filed))refuse();if(latest.length>1&&latest[1].filed===row.filed)refuse();
 if(row.report!=='2026-06-30'||row.document!=='msft-20260630.htm'||row.accession!=='0001193125-26-323660'||Date.parse(row.filed)>nowMs||Date.parse(row.report)>nowMs||nowMs-Date.parse(row.report)>400*86400000)refuse();
 if(!/<title>Microsoft 2026 Annual Report<\/title>/i.test(reportHtml))refuse();
 const text=reportHtml.replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/\s+/g,' ');
 const section=text.match(/HUMAN CAPITAL RESOURCES\s+As of June 30, 2026, we employed approximately ([0-9]{1,3}(?:,[0-9]{3})*) people on a full-time basis,/g);
 if(!section||section.length!==1)refuse();const count=Number(section[0].match(/approximately ([0-9,]+) people/)![1].replace(/,/g,''));if(!Number.isSafeInteger(count)||count<=0||count>100000000)refuse();
 if(!record(data.addresses)||!record(data.addresses.business))refuse();const address=data.addresses.business;
 const parts=['street1','city','stateOrCountry','zipCode'].map(key=>address[key]);if(parts.some(v=>typeof v!=='string'||!v))refuse();
 return {company:'Microsoft Corporation',domain:'microsoft.com',employee_count:count,industry:data.sicDescription,employee_as_of:row.report,employee_basis:'approximate full-time employees',industry_basis:'SEC SIC description',report_date:row.report,filing_date:row.filed,accession:row.accession,business_address:parts.join(', '),scope:'Latest supported annual-report figure as of its report date, not current payroll; business address is not asserted to be headquarters. Microsoft-only reviewed source identity.'};
}
