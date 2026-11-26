import {resetFxObservationsForTests} from '../src/handlers/fxObservations';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const scratch = mkdtempSync('/tmp/fx-wide-anchor-');
process.env.SQLITE_PATH = join(scratch, 'receipts.sqlite');
import { handleFx, handleFxNow, selectAnchorServing } from '../src/handlers/currencyConvert';
import { getReceiptEvidence } from '../src/core/storage';
import { sha256Hex } from '../src/core/receipt';
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {resetFxObservationsForTests();vi.unstubAllGlobals();});
const names = ['frankfurter','openEr','fawaz','vatcomply','floatrates'] as const;
const originals = Object.fromEntries(names.map(n => [n, readFileSync(join(__dirname,'fixtures/fx-same-day',n+'.txt'),'utf8')]));
function stub(bodies: Record<string,string> = originals) {
 vi.stubGlobal('fetch', async (url: unknown) => {
  const u = String(url);
  const n = u.includes('frankfurter') ? 'frankfurter' : u.includes('open.er-api') ? 'openEr' : u.includes('jsdelivr') ? 'fawaz' : u.includes('vatcomply') ? 'vatcomply' : 'floatrates';
  return new Response(bodies[n]);
 });
}
async function receiptCheck(r: Record<string,any>) {
 const stored = await getReceiptEvidence(r.receipt.receipt_id);
 expect(stored.evidence).toBeTruthy();
 expect(sha256Hex(stored.evidence!.toString())).toBe(r.receipt.raw_response_sha256);
 const evidence = JSON.parse(stored.evidence!.toString());
 expect(evidence.sources).toHaveLength(4);
 expect(evidence.cross_checks).toHaveLength(3);expect(evidence.value_basis).toBe('ecb_primary');
 for (const source of evidence.sources) expect(Object.values(originals)).toContain(source.raw_body);
}
describe('same-date wide FX pool, captured 2026-11-23 upstream bodies', () => {
 it.each([['EUR',0.91416],['SEK',10.2729]] as const)('%s serves the ECB reference rate, preserving SEK',async (currency,rate) => {
  stub(); const r = await handleFxNow({currency});
  expect(r.rate).toBe(rate); expect(r.confidence).toBe(1);
  expect(String(r.answer)).toContain('ECB reference rate');expect(String(r.answer)).not.toContain('Dropped');
  expect(String(r.answer)).toContain('not a five-minute market-freshness claim');
  await receiptCheck(r);
 });
 it('conversion applies the identical ECB rate and discloses the cross-check',async()=>{
  stub(); const r=await handleFx({from_currency:'USD',to_currency:'EUR',amount:'100'});
  expect(r.rate).toBe(0.91416); expect(r.converted_amount).toBe(91.416); expect(r.confidence).toBe(1);
  expect(String(r.answer)).toContain('Cross-check against other observations'); await receiptCheck(r);
 });
 it('CAD serves the ECB reference rate at confidence 1',async()=>{
  stub(); const r=await handleFxNow({currency:'CAD'}); expect(r.rate).toBe(1.4362); expect(r.confidence).toBe(1);
  expect(String(r.answer)).not.toContain('Dropped');
 });
 it.each(['now','convert'])('%s still serves the ECB rate and flags a pool with no agreeing pair',async kind=>{
  const b: Record<string,string>={};
  for(const [i,n] of names.entries()){
   const d=JSON.parse(originals[n]); const rate=0.8+i*0.02;
   if(n==='fawaz') d.usd.eur=rate; else if(n==='floatrates') d.eur.rate=String(rate); else d.rates.EUR=rate;
   b[n]=JSON.stringify(d);
  }
  stub(b); const r:any=await(kind==='now'?handleFxNow({currency:'EUR'}):handleFx({from_currency:'USD',to_currency:'EUR'}));expect(r.rate).toBe(0.8);expect(String(r.answer)).toContain('FLAGGED');
 });
 it('helper exposes the selected pair independently of exact-median ties',()=>{
  const quotes=[0.8,0.9,0.90001].map((rate,i)=>({rate,source:['drift','Frankfurter (ECB reference rates)','vatcomply'][i],url:'https://example.com',rawBody:'{}',rateDate:'2026-11-23'}));
  const s=selectAnchorServing(quotes); expect(s.anchor).toHaveLength(2); expect(s.serving).toHaveLength(1); expect(s.serving[0].rate).toBe(0.9);
 });
});
