import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const scratch = mkdtempSync('/tmp/fx-wide-anchor-');
process.env.SQLITE_PATH = join(scratch, 'receipts.sqlite');
import { handleFx, handleFxNow, selectAnchorServing } from '../src/handlers/currencyConvert';
import { getReceiptEvidence } from '../src/core/storage';
import { sha256Hex } from '../src/core/receipt';
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
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
 expect(evidence.sources).toHaveLength(5);
 expect(evidence.cluster_detail).toContain('excluded');
 expect(evidence.degraded_reasons[0]).toContain('same-date pool exceeds 0.5%');
 for (const source of evidence.sources) expect(Object.values(originals)).toContain(source.raw_body);
}
describe('same-date wide FX pool, captured 2026-11-23 upstream bodies', () => {
 it.each([['EUR',0.91087802],['SEK',10.272877]] as const)('%s serves the reviewed scoped selection, preserving SEK',async (currency,rate) => {
  stub(); const r = await handleFxNow({currency});
  expect(r.rate).toBe(rate); expect(r.confidence).toBe(0.9);
  expect(String(r.answer)).toContain('full source pool did NOT agree within 0.5%');
  expect(String(r.answer)).toContain('Frankfurter'); expect(String(r.answer)).toContain('vatcomply');
  for (const name of ['open.er-api.com','floatrates','fawaz currency-api']) expect(String(r.answer)).toContain(name);
  expect(String(r.answer)).toMatch(/-\d+(\.\d+)?bps/);
  expect(String(r.source)).toContain('publication timing is not independently verified');
  await receiptCheck(r);
 });
 it('conversion applies the identical EUR selection and discloses exclusions',async()=>{
  stub(); const r=await handleFx({from_currency:'USD',to_currency:'EUR',amount:'100'});
  expect(r.rate).toBe(0.91087802); expect(r.converted_amount).toBe(91.087802); expect(r.confidence).toBe(0.9);
  expect(String(r.answer)).toContain('full source pool did NOT agree'); await receiptCheck(r);
 });
 it('CAD uses the independent-window even median at confidence 1',async()=>{
  stub(); const r=await handleFxNow({currency:'CAD'}); expect(r.rate).toBe(1.433138805); expect(r.confidence).toBe(1);
  expect(String(r.answer)).not.toContain('full source pool did NOT agree');
 });
 it.each(['now','convert'])('%s refuses a pool with no agreeing pair',async kind=>{
  const b: Record<string,string>={};
  for(const [i,n] of names.entries()){
   const d=JSON.parse(originals[n]); const rate=0.8+i*0.02;
   if(n==='fawaz') d.usd.eur=rate; else if(n==='floatrates') d.eur.rate=String(rate); else d.rates.EUR=rate;
   b[n]=JSON.stringify(d);
  }
  stub(b); await expect(kind==='now'?handleFxNow({currency:'EUR'}):handleFx({from_currency:'USD',to_currency:'EUR'})).rejects.toMatchObject({status:502,code:'FX_SOURCES_DISAGREE'});
 });
 it('helper exposes the selected pair independently of exact-median ties',()=>{
  const quotes=[0.8,0.9,0.90001].map((rate,i)=>({rate,source:['drift','Frankfurter (ECB reference rates)','vatcomply'][i],url:'https://example.com',rawBody:'{}',rateDate:'2026-11-23'}));
  const s=selectAnchorServing(quotes); expect(s.anchor).toHaveLength(2); expect(s.serving).toHaveLength(1); expect(s.serving[0].rate).toBe(0.9);
 });
});
