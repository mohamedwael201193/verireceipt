import {resetFxObservationsForTests} from '../src/handlers/fxObservations';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const scratch=mkdtempSync('/tmp/fx-ecb-');process.env.SQLITE_PATH=join(scratch,'r.sqlite');
import {handleFx,handleFxNow} from '../src/handlers/currencyConvert';
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
afterEach(()=>{resetFxObservationsForTests();vi.unstubAllGlobals();});
type Rates={ecb?:number;ecb2?:number;broad?:number;agg?:number};
function stub(ccy:string,r:Rates){const low=ccy.toLowerCase();vi.stubGlobal('fetch',async(u:any)=>{const s=String(u);
 const pick=(v:number|undefined,body:()=>unknown)=>{if(v===undefined)throw Error('down');return new Response(JSON.stringify(body()));};
 if(s.includes('frankfurter'))return pick(r.ecb,()=>({amount:1,base:'USD',date:'2026-11-25',rates:{[ccy]:r.ecb}}));
 if(s.includes('vatcomply'))return pick(r.ecb2,()=>({date:'2026-11-25',base:'USD',rates:{[ccy]:r.ecb2}}));
 if(s.includes('open.er'))return pick(r.broad,()=>({result:'success',base_code:'USD',time_last_update_utc:'Wed, 26 Nov 2026 00:02:32 +0000',rates:{[ccy]:r.broad}}));
 if(s.includes('jsdelivr'))return pick(r.agg,()=>({date:'2026-11-25',usd:{[low]:r.agg}}));
 throw Error('down');});}
describe('the ECB reference rate is the served value',()=>{
 it('CAD: the ECB value wins over a median of the others',async()=>{stub('CAD',{ecb:1.4258,ecb2:1.4258,broad:1.428673,agg:1.4287});
  const r:any=await handleFxNow({currency:'CAD'});expect(r.rate).toBe(1.4258);expect(r.sources_used).toEqual(['Frankfurter (ECB reference rates)']);expect(r.value_basis).toBe('ecb_primary');});
 it('EUR: the ECB value wins',async()=>{stub('EUR',{ecb:0.91449,ecb2:0.91449,broad:0.9138,agg:0.9138});expect(((await handleFxNow({currency:'EUR'})) as any).rate).toBe(0.91449);});
 it('conversion computes from the same ECB rate',async()=>{stub('CAD',{ecb:1.4258,ecb2:1.4258,broad:1.428673,agg:1.4287});
  const r:any=await handleFx({from_currency:'USD',to_currency:'CAD',amount:'250'});expect(r.rate).toBe(1.4258);expect(r.converted_amount).toBe(356.45);expect(r.sources_used).toEqual(['Frankfurter (ECB reference rates)']);});
 it('keeps the rate date disclosure',async()=>{stub('EUR',{ecb:0.91449,ecb2:0.91449,broad:0.9138});const r:any=await handleFxNow({currency:'EUR'});expect(String(r.answer)).toContain('rate date 2026-11-25');expect(r.rate_date).toBe('2026-11-25');});
});
describe('fallback order',()=>{
 it('with Frankfurter down the other ECB-based source serves before any other',async()=>{stub('EUR',{ecb2:0.9123,broad:0.9099,agg:0.9101});
  const r:any=await handleFxNow({currency:'EUR'});expect(r.rate).toBe(0.9123);expect(r.sources_used).toEqual(['vatcomply']);expect(r.value_basis).toBe('ecb_fallback');expect(r.confidence).toBe(0.9);});
 it('with both ECB-based sources down the others serve by their agreeing median',async()=>{stub('EUR',{broad:0.9100,agg:0.9102});
  const r:any=await handleFxNow({currency:'EUR'});expect(r.rate).toBe(0.9101);expect(r.value_basis).toBe('median_no_ecb');});
 it('Frankfurter is preferred over the other ECB-based source when both answer',async()=>{stub('EUR',{ecb:0.9144,ecb2:0.9150});expect(((await handleFxNow({currency:'EUR'})) as any).rate).toBe(0.9144);});
});
describe('cross-check disclosure',()=>{
 it('a difference of more than 1% is flagged by source and never changes the value',async()=>{stub('EUR',{ecb:0.9,ecb2:0.9,broad:0.92,agg:0.9005});
  const r:any=await handleFxNow({currency:'EUR'});expect(r.rate).toBe(0.9);const a=String(r.answer);expect(a).toContain('FLAGGED: open.er-api.com');expect(a).not.toContain('FLAGGED: open.er-api.com, fawaz');
  expect(r.cross_checks.filter((c:any)=>c.flagged).map((c:any)=>c.source)).toEqual(['open.er-api.com']);});
 it('differences up to 1% are listed and not flagged',async()=>{stub('EUR',{ecb:1,broad:1.0099,agg:0.9901});
  const r:any=await handleFxNow({currency:'EUR'});expect(String(r.answer)).not.toContain('FLAGGED');expect(String(r.answer)).toContain('All within 1%');expect(r.cross_checks).toHaveLength(2);});
 it('the first flagged value above 1% is exact: 1.0101 flags',async()=>{stub('EUR',{ecb:1,broad:1.0101});expect(String(((await handleFxNow({currency:'EUR'})) as any).answer)).toContain('FLAGGED');});
});
