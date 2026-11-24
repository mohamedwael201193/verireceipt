import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const scratch=mkdtempSync('/tmp/fx-base-identity-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import { handleFx, handleFxNow, quoteExchangeRateApi } from '../src/handlers/currencyConvert';
import { getReceiptEvidence } from '../src/core/storage';
import { sha256Hex } from '../src/core/receipt';
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));afterEach(()=>vi.unstubAllGlobals());
const originals=Object.fromEntries(['frankfurter','openEr','fawaz','vatcomply','floatrates'].map(n=>[n,readFileSync(join(__dirname,'fixtures/fx-same-day',n+'.txt'),'utf8')]));
function stub(name:string,body:string){vi.stubGlobal('fetch',async(input:unknown)=>{
 const u=String(input);const n=u.includes('frankfurter')?'frankfurter':u.includes('open.er-api')?'openEr':u.includes('jsdelivr')?'fawaz':u.includes('vatcomply')?'vatcomply':'floatrates';
 if(n!==name)throw new Error('synthetic source outage');return new Response(body);
});}
describe('FX response base identity, accepted actual source bodies',()=>{
 for(const [name,field] of [['frankfurter','base'],['openEr','base_code'],['vatcomply','base']] as const){
  it(name+' preserves valid actual quote and exact raw receipt body',async()=>{
   stub(name,originals[name]);const r=await handleFx({from_currency:'USD',to_currency:'EUR'});const stored=await getReceiptEvidence((r.receipt as any).receipt_id);const ev=JSON.parse(stored.evidence!.toString());expect(ev.sources).toHaveLength(1);expect(ev.sources[0].raw_body).toBe(originals[name]);expect(sha256Hex(stored.evidence!)).toBe((r.receipt as any).raw_response_sha256);
  });
  it.each(['GBP',null,undefined,1])(`${name} refuses wrong/missing/malformed base %s on both routes`,async base=>{
   const j=JSON.parse(originals[name]);j[field]=base;stub(name,JSON.stringify(j));
   await expect(handleFx({from_currency:'USD',to_currency:'EUR'})).rejects.toMatchObject({status:502,code:'FX_SOURCES_DOWN'});
   await expect(handleFxNow({currency:'EUR'})).rejects.toMatchObject({status:502,code:'FX_SOURCES_DOWN'});
  });
 }
 it.each(['GBP',null,undefined,1])('keyed leg rejects base %s rather than silently serving it',async base=>{
  const j=JSON.parse(originals.openEr);j.base_code=base;vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(j)));
  await expect(quoteExchangeRateApi('USD','EUR','synthetic-key')).rejects.toThrow('FX base identity mismatch');
 });
 it('keyed leg accepts correctly identified body and keeps direction',async()=>{
  vi.stubGlobal('fetch',async()=>new Response(originals.openEr));const q=await quoteExchangeRateApi('USD','EUR','synthetic-key');expect(q?.rate).toBe(JSON.parse(originals.openEr).rates.EUR);
 });
});

describe('Frankfurter per-unit boundary',()=>{
 it.each([100,0,-1,1.1,'1',null,undefined])('refuses non-unit/missing amount %s on both shared routes',async amount=>{
  const j=JSON.parse(originals.frankfurter);j.amount=amount;stub('frankfurter',JSON.stringify(j));await expect(handleFx({from_currency:'USD',to_currency:'EUR'})).rejects.toMatchObject({status:502,code:'FX_SOURCES_DOWN'});await expect(handleFxNow({currency:'EUR'})).rejects.toMatchObject({status:502,code:'FX_SOURCES_DOWN'});
 });
});

describe('Floatrates target identity',()=>{
 it('accepted actual target entry retains exact body and receipt hash',async()=>{
  stub('floatrates',originals.floatrates);const out=await handleFx({from_currency:'USD',to_currency:'EUR'});expect(out.rate).toBe(JSON.parse(originals.floatrates).eur.rate*1);const r=out.receipt as any,stored=await getReceiptEvidence(r.receipt_id);expect(sha256Hex(stored.evidence!)).toBe(r.raw_response_sha256);expect(JSON.parse(stored.evidence!.toString()).sources[0].raw_body).toBe(originals.floatrates);
 });
 it.each(['GBP',null,undefined,1,'eur'])('refuses wrong/missing entry code %s on both routes',async code=>{
  const j=JSON.parse(originals.floatrates);j.eur.code=code;stub('floatrates',JSON.stringify(j));await expect(handleFx({from_currency:'USD',to_currency:'EUR'})).rejects.toMatchObject({code:'FX_SOURCES_DOWN'});await expect(handleFxNow({currency:'EUR'})).rejects.toMatchObject({code:'FX_SOURCES_DOWN'});
 });
 it.each(['GBP',null,1])('refuses conflicting/malformed declared alphaCode %s',async alpha=>{
  const j=JSON.parse(originals.floatrates);j.eur.alphaCode=alpha;stub('floatrates',JSON.stringify(j));await expect(handleFx({from_currency:'USD',to_currency:'EUR'})).rejects.toMatchObject({code:'FX_SOURCES_DOWN'});
 });
 it('absent optional alphaCode does not discard a matching explicit code',async()=>{const j=JSON.parse(originals.floatrates);delete j.eur.alphaCode;stub('floatrates',JSON.stringify(j));expect((await handleFx({from_currency:'USD',to_currency:'EUR'})).rate).toBe(Number(j.eur.rate));});
});

describe('ISO publication calendar boundary without age policy change',()=>{
 it.each(['2026-02-30','2026-02-29','2026-00-10','2026-13-01','2026-11-31','2026-01-00'])('impossible %s never becomes a covering quote',async date=>{
  for(const name of ['frankfurter','vatcomply','fawaz']){const j=JSON.parse(originals[name]);j.date=date;stub(name,JSON.stringify(j));await expect(handleFx({from_currency:'USD',to_currency:'EUR'})).rejects.toMatchObject({code:'FX_SOURCES_DOWN'});await expect(handleFxNow({currency:'EUR'})).rejects.toMatchObject({code:'FX_SOURCES_DOWN'});}
 });
 it.each(['2024-02-29','2000-02-29','2026-11-23','unknown','2099-01-01'])('calendar-valid/unknown label %s does not introduce freshness refusal',async date=>{
  const j=JSON.parse(originals.frankfurter);j.date=date;stub('frankfurter',JSON.stringify(j));expect((await handleFx({from_currency:'USD',to_currency:'EUR'})).rate).toBe(j.rates.EUR);
 });
});
