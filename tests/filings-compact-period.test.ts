import {it,expect,vi,afterEach} from 'vitest';
import {parsePeriod,handleFilings,__seedTickersCacheForTests,__clearTickersCacheForTests} from '../src/handlers/filings';
import {readFileSync} from 'node:fs';import {join} from 'node:path';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();__clearTickersCacheForTests();});
const freeze=()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-24T04:00:00Z'));};
it.each(['12 months','last12months','last_12_months','last-12-months','12months','past12months','trailing12months','last1year','past_1_year','trailing-1-year','LAST12MONTHS'])('normalizes %s to identical inclusive12month dates',text=>{
 freeze();expect(parsePeriod(text)).toEqual({...parsePeriod('last 12 months'),label:text});
});
it.each(['ytd','Y_T_D','y-t-d','year_to_date','year-to-date','yeartodate'])('normalizes YTD %s without date invention',text=>{
 freeze();expect(parsePeriod(text)).toMatchObject({start:'2026-01-01',end:'2026-11-24',label:`${text} (2026-01-01..2026-11-24)`});
});
it.each(['Q32026','q3_2026','q3-2026','calendar_q3_2026'])('accepts compact calendar quarter %s',text=>{
 freeze();expect(parsePeriod(text)).toMatchObject({start:'2026-07-01',end:'2026-09-30'});
});
it.each(['CY2026','calendar_year_2026','calendar-2026'])('accepts bounded calendar year %s',text=>{
 freeze();expect(parsePeriod(text)).toMatchObject({start:'2026-01-01',end:'2026-12-31'});
});
it.each(['q3-20-26','calendar20_26','cy20 26','-12months','-1year','last1-2months','last1_2months','last1 2months','past+12months','last-1.2months','last12.5months','last1+2months','--12months','12months-1','last -1 months','last0months','last1201months','last101years','last9999999999999999999years','trailing-12-months-secret','12months or 6months','fiscal2026','FY2026','2026-02-30..2026-03-31','q52026'])('refuses invalid or fiscal period %s',text=>{
 freeze();expect(()=>parsePeriod(text)).toThrow();
});
it('preserves ISO ranges and ordinary years exactly',()=>{freeze();expect(parsePeriod('2026-01-01..2026-03-31')).toEqual({start:'2026-01-01',end:'2026-03-31',label:'2026-01-01..2026-03-31'});expect(parsePeriod('2026')).toEqual({start:'2026-01-01',end:'2026-12-31',label:'2026'});});
it('compact period survives full form extraction and matches recorded-source count',async()=>{
 freeze();vi.stubEnv('SEC_USER_AGENT','recorded-body-replay-no-network');__seedTickersCacheForTests({'0':{cik_str:320193,ticker:'AAPL',title:'Apple Inc.'}});
 const raw=readFileSync(join(__dirname,'fixtures/corporate-registry/edgar-submissions-apple.json'),'utf8');
 const deps={fetchImpl:vi.fn(async()=>new Response(raw)),saveReceiptImpl:vi.fn(async()=>{})};
 const spaced=await handleFilings({entity:'AAPL',period:'last 12 months',form_type:'10-K'},deps);
 const compact=await handleFilings({entity:'AAPL',period:'last12months',form_type:'10-K'},deps);
 expect(compact.filing_count).toBe(spaced.filing_count);expect(compact.filing_count).toBe(1);expect(compact.form_type).toBe('10-K');expect(compact.answer).toContain('last12months');
});
