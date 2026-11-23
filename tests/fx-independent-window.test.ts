import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const scratch=mkdtempSync('/tmp/fx-independent-');process.env.SQLITE_PATH=join(scratch,'receipts.sqlite');
import { handleFx, handleFxNow, selectAnchorServing, selectIndependentWindow } from '../src/handlers/currencyConvert';
import { getReceiptEvidence } from '../src/core/storage';
import { sha256Hex } from '../src/core/receipt';
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));afterEach(()=>vi.unstubAllGlobals());
const names=['frankfurter','openEr','fawaz','vatcomply','floatrates'] as const;
const raw=Object.fromEntries(names.map(n=>[n,readFileSync(join(__dirname,'fixtures/fx-independent-window',n+'.txt'),'utf8')]));
function stub(){vi.stubGlobal('fetch',async(input:unknown)=>{const u=String(input);const n=u.includes('frankfurter')?'frankfurter':u.includes('open.er-api')?'openEr':u.includes('jsdelivr')?'fawaz':u.includes('vatcomply')?'vatcomply':'floatrates';return new Response(raw[n]);});}
const q=(rate:number,source:string,rateDate='2026-11-23')=>({rate,source,rateDate,url:'https://example.invalid/source',rawBody:'{}'});
describe('same-date independent-origin window on captured real quotes',()=>{
 it.each([['EUR',0.911134,0.91416,0.9],['CAD',1.433905505,1.4362,1],['SEK',10.272877,10.272877,0.9]] as const)('%s before and after are explicit; SEK unchanged',async(currency,after,before,confidence)=>{
  stub();const result=await handleFxNow({currency});expect(result.rate).toBe(after);expect(result.confidence).toBe(confidence);
  const stored=await getReceiptEvidence((result.receipt as any).receipt_id);const ev=JSON.parse(stored.evidence!.toString());
  expect(sha256Hex(stored.evidence!)).toBe((result.receipt as any).raw_response_sha256);
  expect(ev.sources).toHaveLength(5);for(const x of ev.sources)expect(Object.values(raw)).toContain(x.raw_body);
  const legacy=selectAnchorServing(ev.sources.map((s:any)=>q(s.rate,s.source,s.rate_date)).sort((a:any,b:any)=>a.rate-b.rate));expect(legacy.serving[0].rate).toBe(before);
  if(currency!=='SEK'){
   expect(String(result.answer)).toContain('ECB fix reference:');expect(String(result.answer)).toMatch(/[+]\d+\.\d{2}bps/);
   expect(ev.independent_window_selection).toContain('known duplicate origins counted once');
   expect(String(result.answer)).toContain(currency==='CAD'?'even count: arithmetic mean':'odd count: middle');
   if(currency==='CAD')expect(String(result.answer)).toContain('median midpoint, not a single-source quote');
  }
 });
 it('USD conversion identity remains exactly1 on its fetched real bodies',async()=>{stub();const r=await handleFx({from_currency:'USD',to_currency:'USD',amount:'2'});expect(r.rate).toBe(1);expect(r.converted_amount).toBe(2);});
 it.each([['EUR',0.911134,91.1134],['CAD',1.433905505,143.390551]] as const)('conversion shares %s policy and disclosed calculation',async(currency,rate,amount)=>{stub();const r=await handleFx({from_currency:'USD',to_currency:currency,amount:'100'});expect(r.rate).toBe(rate);expect(r.converted_amount).toBe(amount);expect(String(r.answer)).toContain('ECB fix reference:');});
 it('ECB republications alone do not meet two independent origins',()=>{expect(()=>selectIndependentWindow([q(.91416,'Frankfurter (ECB reference rates)'),q(.91416,'vatcomply')])).toThrow('independent');});
 it('public and keyed ExchangeRate-API count as one origin',()=>{expect(()=>selectIndependentWindow([q(1,'open.er-api.com'),q(1.00001,'exchangerate-api v6')])).toThrow('independent');});
 it('no transitive chain bypasses the complete-span cap',()=>{const s=selectIndependentWindow([q(1,'a'),q(1.004,'b'),q(1.008,'c')]);expect(s.anchor).toHaveLength(2);expect((s.anchor.at(-1)!.rate-s.anchor[0].rate)/s.anchor[0].rate).toBeLessThanOrEqual(.005);expect(s.clusterDetail).toContain('smallest full relative span');});
 it('the two middle rates are averaged, never silently called a provider quote',()=>{const s=selectIndependentWindow([q(1,'a'),q(1.001,'b'),q(1.002,'c'),q(1.003,'d')]);expect(s.serving.map(x=>x.rate)).toEqual([1.001,1.002]);expect(s.clusterDetail).toContain('arithmetic mean');});
 it('different-date newest branch remains unchanged for wide EUR disagreement',async()=>{
  vi.stubGlobal('fetch',async(input:unknown)=>{
   const u=String(input);const n=u.includes('frankfurter')?'frankfurter':u.includes('open.er-api')?'openEr':u.includes('jsdelivr')?'fawaz':u.includes('vatcomply')?'vatcomply':'floatrates';
   const j=JSON.parse(raw[n]);if(n==='frankfurter')j.date='2026-11-24';return new Response(JSON.stringify(j));
  });
  const r=await handleFxNow({currency:'EUR'});expect(r.rate).toBe(.91416);expect(String(r.answer)).toContain('freshest is served');expect(String(r.answer)).not.toContain('independent-origin window');
 });

});
