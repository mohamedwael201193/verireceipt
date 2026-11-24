import {it,expect,beforeEach,afterEach,vi} from 'vitest';import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {handleFilings,parseFormType,__seedTickersCacheForTests,__clearTickersCacheForTests} from '../src/handlers/filings';
const raw=readFileSync(join(__dirname,'fixtures/corporate-registry/edgar-submissions-apple.json'),'utf8');
beforeEach(()=>{vi.stubEnv('SEC_USER_AGENT','recorded-only-no-network');__seedTickersCacheForTests({'0':{cik_str:320193,ticker:'AAPL',title:'Apple Inc.'}});});afterEach(()=>{vi.unstubAllEnvs();__clearTickersCacheForTests();});
const deps={fetchImpl:async()=>new Response(raw),saveReceiptImpl:async()=>{}};
const ask=(form_type:string,extra:Record<string,string>={})=>handleFilings({entity:'AAPL',period:'2026',form_type,...extra},deps);
it.each(['10-K, 10-Q','10-K and 10-Q','10-K;10-Q','10-K|10-Q','10-K + 10-Q','10-K & 10-Q','10-K or 10-Q'])('finite list %s selects union from real recorded SEC rows',async form=>{
 const r=await ask(form);expect(r.filing_count).toBe(4);expect(r.form_counts).toEqual({'10-K':1,'10-Q':3});expect(r.requested_forms).toEqual(['10-K','10-Q']);expect(r.forms_counted).toEqual(['10-K','10-Q']);expect(r.answer).toContain('union; amendments separate');expect(r.answer).not.toContain('renamed this form');expect((r.filings_detail as any[]).every(f=>['10-K','10-Q'].includes(f.form))).toBe(true);expect(r.urls).toHaveLength(4);
});
it('deduplicates repeated filters and rows by accession, never adds amendments implicitly',async()=>{
 const r=await ask('8-K, 8-K/A, 8-K');expect(r.filing_count).toBe(9);expect(r.form_counts).toEqual({'8-K':8,'8-K/A':1});expect(r.requested_forms).toEqual(['8-K','8-K/A']);const rows=r.filings_detail as any[];expect(new Set(rows.map(f=>f.accession)).size).toBe(9);
 const noAmend=await ask('8-K, 10-K');expect(noAmend.filing_count).toBe(9);expect(noAmend.form_counts).toEqual({'8-K':8,'10-K':1});
});
it('retains cross-field set conflicts rather than silently widening',async()=>{
 await expect(ask('10-K,10-Q',{entity:'AAPL 10-K'})).rejects.toMatchObject({code:'CONFLICTING_FORM_TYPE'});
 await expect(ask('10-K,10-Q',{form:'10-K'})).rejects.toMatchObject({code:'CONFLICTING_FORM_TYPE'});
 const same=await ask('10-K,10-Q',{form:'10-Q,10-K'});expect(same.filing_count).toBe(4);
});
it.each(['annual report','10-K,BOGUS','10-K,,10-Q',',10-K','10-K,','10-K,all','10-K and','10-K,'.repeat(11)+'10-Q'])('refuses incomplete unknown or oversized list %s',form=>{expect(()=>parseFormType(form)).toThrow();});
it('supports one-letter/numeric exact forms in a list, but does not mine arbitrary suffix text',()=>{
 expect(parseFormType('10-K/A,1')).toEqual({kind:'forms',forms:['10-K/A','1']});expect(()=>parseFormType('10-K/A secret,10-Q')).toThrow();
});
it('parser itself deduplicates exact forms before returning the finite set',()=>{
 expect(parseFormType('8-K,8-K/A,8-K')).toEqual({kind:'forms',forms:['8-K','8-K/A']});
 expect(parseFormType('10-K,10-K')).toEqual({kind:'form',form:'10-K'});
});
it.each(['all','any','all forms','any form','*'])('refuses explicit all alias %s against a finite set in both directions',async all=>{
 await expect(ask('10-K,10-Q',{form:all})).rejects.toMatchObject({status:422,code:'CONFLICTING_FORM_TYPE'});
 await expect(ask(all,{form:'10-K,10-Q'})).rejects.toMatchObject({status:422,code:'CONFLICTING_FORM_TYPE'});
 await expect(ask('10-K',{form:all})).rejects.toMatchObject({status:422,code:'CONFLICTING_FORM_TYPE'});
 await expect(ask(all,{form:'10-K'})).rejects.toMatchObject({status:422,code:'CONFLICTING_FORM_TYPE'});
});
