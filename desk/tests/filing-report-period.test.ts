// Synthetic transport controls only, no paid answers or gold data.
import {it,expect} from 'vitest';
import {verifyFilingSource} from '../src/filingSource.js';
const accession='0000987654-24-000001';
const url='https://www.sec.gov/Archives/edgar/data/987654/000098765424000001/q.htm';
const recent=()=>({accessionNumber:[accession],filingDate:['2024-04-24'],reportDate:['2024-03-31'],form:['10-Q'],primaryDocument:['q.htm']});
const answer=()=>({filing_count:1,entity:'Example Corp (CIK 987654)',filings:['Example Corp 10-Q for the period ending 2024-03-31'],recent:[{agency:'SEC',publication_date:'2024-04-24',title:'Example Corp 10-Q for the period ending 2024-03-31',type:'10-Q',url}]});
async function check(result:any=answer(),rows:any=recent(),files:any[]=[],history?:any){return verifyFilingSource({params:{entity:'Form 10-Q filings by Example Corp (CIK 987654)',period:'2024'},result},{now:new Date('2026-01-01'),secUserAgent:'Unit unit@example.invalid',f:async input=>Response.json(String(input).endsWith('-001.json')?history:{cik:987654,name:'Example Corp',filings:{recent:rows,files}})});}
it('accepts distinct filingDate and reportDate bound to one issuer accession',async()=>expect((await check()).status).toBe('verified'));
it.each(['issuer','cik','form','report','filing','url','extra','invisible','multiple','accession','reportAlias'])('rejects conflicting %s assertions',async mutant=>{const a=answer() as any;if(mutant==='issuer')a.entity='Other Corp (CIK 987654)';if(mutant==='cik')a.entity='Example Corp (CIK 111111)';if(mutant==='form')a.recent[0].type='10-Q/A';if(mutant==='report')a.filings[0]='Example Corp 10-Q for the period ending 2024-04-24';if(mutant==='filing')a.recent[0].publication_date='2024-03-31';if(mutant==='url')a.recent[0].url=url.replace('000001','000002');if(mutant==='extra')a.recent[0].ignored_claim='bad';if(mutant==='invisible')a.filings[0]='Example\u200b Corp 10-Q for the period ending 2024-03-31';if(mutant==='multiple')a.filings[0]+=' 2024-01-01';if(mutant==='accession')a.recent[0].accession='0000987654-24-000002';if(mutant==='reportAlias')a.recent[0].report_date='2024-01-01';expect((await check(a)).status).toBe('failed');});
it.each([undefined,[],['2024-02-30']])('rejects unavailable/malformed reportDate for period title: %j',async reportDate=>expect((await check(answer(),{...recent(),reportDate})).status).toBe('failed'));
it('does not change filing-window meaning to report period',async()=>expect((await check(answer(),{...recent(),filingDate:['2025-01-01']})).status).toBe('failed'));
it('rejects ambiguous period titles and duplicate accession report conflicts',async()=>{const r=recent();for(const key of Object.keys(r)) (r as any)[key].push((r as any)[key][0]);r.accessionNumber[1]='0000987654-24-000002';expect((await check({...answer(),filing_count:2},r)).status).toBe('failed');r.accessionNumber[1]=accession;r.reportDate[1]='2024-03-30';expect((await check(answer(),r)).status).toBe('failed');});
it('requires reportDate agreement across history duplicates',async()=>{const history={...recent(),reportDate:['2024-03-30']};expect((await check(answer(),recent(),[{name:'CIK0000987654-submissions-001.json',filingCount:1}],history)).status).toBe('failed');});
it('wallet-free assertion replay binds provider titles to stored reportDate bytes',async()=>{
 const {verifyResearchPrimary}=await import('../src/researchPrimary.js');const {replayFilingAssertionsBytes,replayPrimaryBytes}=await import('../src/researchPublicReplay.js');
 const fact={id:'filings',intent:'REGULATORY_FILING_MONITOR_GENERAL',params:{entity:'Form 10-Q filings by Example Corp (CIK 987654)',period:'2024'},field:'filing_count',unit:'filings',max_age_seconds:86400};
 const at='2026-01-01T00:00:00.000Z';const result=await verifyResearchPrimary(fact,'1',{now:()=>new Date(at),secUserAgent:'Unit unit@example.invalid',f:async()=>Response.json({cik:987654,name:'Example Corp',filings:{recent:recent(),files:[]}})});
 const observation={source:result.source,as_of:result.as_of,value:'1'} as any;expect(await replayPrimaryBytes(fact,observation,at)).toBe(true);expect(await replayFilingAssertionsBytes(fact,observation,answer(),at)).toBe(true);
 const bad=answer();bad.recent[0].publication_date='2024-03-31';expect(await replayFilingAssertionsBytes(fact,observation,bad,at)).toBe(false);
 const shifted=structuredClone(observation);shifted.source.raw_text=shifted.source.raw_text.replace('2024-03-31','2024-03-30');expect(await replayFilingAssertionsBytes(fact,shifted,answer(),at)).toBe(false);
});

it.each(['Example Corp ☃ (CIK 987654)','Example Corp® (CIK 987654)','Example Corp\t(CIK 987654)'])('does not erase unlisted issuer characters: %s',async entity=>expect((await check({...answer(),entity})).status).toBe('failed'));
it.each([null,{},['bad'],['2024-01-01']])('validates empty-row reportDate before iteration: %j',async reportDate=>expect((await check({filing_count:0},{accessionNumber:[],filingDate:[],form:[],reportDate})).status).toBe('failed'));
it('permits explicitly listed punctuation and retains exact non-ASCII letters',async()=>{expect((await check({...answer(),entity:'Example Corp. (CIK 987654)'})).status).toBe('verified');expect((await check({...answer(),entity:'Example Cörp (CIK 987654)'})).status).toBe('failed');});

it('does not let minimal shaped fields hide contradictory provider-only rows in source or replay',async()=>{
 const {verifyResearchPrimary}=await import('../src/researchPrimary.js');const {replayFilingAssertionsBytes}=await import('../src/researchPublicReplay.js');const {reconcilePrimaryAnswer}=await import('../src/sourceTypes.js');
 const fact={id:'filings',intent:'REGULATORY_FILING_MONITOR_GENERAL',params:{entity:'Form 10-Q filings by Example Corp (CIK 987654)',period:'2024'},field:'filing_count',unit:'filings',max_age_seconds:86400};
 const provider=answer();provider.recent[0].publication_date='2024-03-31';const shaped={filing_count:1,entity:provider.entity};const result=reconcilePrimaryAnswer(fact.intent,shaped,{filing_count:'ok',entity:'ok'},provider,true).result;
 const f=async()=>Response.json({cik:987654,name:'Example Corp',filings:{recent:recent(),files:[]}});const at='2026-01-01T00:00:00.000Z';
 expect((await verifyFilingSource({params:fact.params,result,providerResult:provider},{f,now:new Date(at),secUserAgent:'Unit unit@example.invalid'})).status).toBe('failed');
 const primary=await verifyResearchPrimary(fact,'1',{f,now:()=>new Date(at),secUserAgent:'Unit unit@example.invalid'});const observation={source:primary.source,as_of:primary.as_of,value:'1'} as any;
 expect(await replayFilingAssertionsBytes(fact,observation,result,at,provider)).toBe(false);
 const missing={...result,filing_count:null};expect((await verifyFilingSource({params:fact.params,result:missing,providerResult:answer()},{f,now:new Date(at),secUserAgent:'Unit unit@example.invalid'})).status).toBe('failed');
});
