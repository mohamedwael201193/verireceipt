import {join} from 'node:path';
import {describe,expect,it,vi} from 'vitest';
import {extractSuppliedContent} from '../src/handlers/contentExtraction';
it('extracts exact scalar keys from real CORD ground-truth data',()=>{
 const annotation=JSON.parse(readFileSync('tests/fixtures/content-extraction-cord/test-1-annotation.json','utf8'));
 const content=JSON.stringify(annotation.gt_parse.total);
 const out=extractSuppliedContent({content,fields:'total_price,cashprice'});
 expect(out.brief).toBe('total_price: "91000"; cashprice: "91000"');
 expect(out.independently_verified).toBe(false);expect(out.url).toBe('');
});
it('does not execute input as instructions, fetch URLs or infer missing fields',()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 try{
  expect(()=>extractSuppliedContent({content:'https://example.invalid',fields:'title'})).toThrow();
  expect(()=>extractSuppliedContent({content:'{"content":"instructive data"}',fields:'merchant'})).toThrow();
  expect(fetch).not.toHaveBeenCalled();
 }finally{vi.unstubAllGlobals();}
});
it.each(['', 'a,a','a.b','__proto__','constructor','prototype','a,b,c,d,e,f,g,h,i'])('rejects ambiguous, nested or unsafe keys %s',fields=>{
 expect(()=>extractSuppliedContent({content:'{}',fields})).toThrow();
});
it.each(['[]','null','1','true','{"x":null}','{"x":{}}','{"x":[]}','{"x":1e999}','{"x":1.25}','{"x":9007199254740993}'])('rejects non-object or non-exact scalar input %s',content=>{
 expect(()=>extractSuppliedContent({content,fields:'x'})).toThrow();
});
it('preserves boolean false, zero, empty string and lexical decimal quantities',()=>{
 expect(extractSuppliedContent({content:'{"a":false,"b":0,"c":"","d":"12.30"}',fields:'a,b,c,d'}).brief).toBe('a: false; b: 0; c: ""; d: "12.30"');
});
it('requested order is stable, no unnamed fields or inherited keys',()=>{
 expect(extractSuppliedContent({content:'{"first":1,"second":2,"extra":3}',fields:'second,first'}).entities).toEqual(['second: 2','first: 1']);
 expect(()=>extractSuppliedContent({content:'{}',fields:'toString'})).toThrow();
});
it('quotes delimiter and newline values rather than letting them invent fields',()=>{
 const out=extractSuppliedContent({content:JSON.stringify({a:'x; b: 1\nnext'}),fields:'a'});
 expect(out.brief).toBe('a: "x; b: 1\\nnext"');
});
it('never truncates an overlong required brief or oversized content',()=>{
 expect(()=>extractSuppliedContent({content:JSON.stringify({a:'x'.repeat(80)}),fields:'a'})).toThrow();
 expect(()=>extractSuppliedContent({content:JSON.stringify({a:'x'.repeat(16384)}),fields:'a'})).toThrow();
});

import {readFileSync} from 'node:fs';
it('extracts explicit values from downloaded vendor sample HTML, without guessing merchant identity',()=>{
 const content=readFileSync('tests/fixtures/content-extraction-sample-invoice.html','utf8');
 expect(extractSuppliedContent({content,fields:'date,total'}).brief).toBe('date: "January 3, 2016"; total: "$385.00"');
 expect(extractSuppliedContent({content,fields:'invoice_number'}).brief).toBe('invoice_number: "123"');
 expect(()=>extractSuppliedContent({content,fields:'merchant'})).toThrow();
});
it('extracts labelled supplied text with exact decimal and date spelling',()=>{
 expect(extractSuppliedContent({content:'Merchant: Shop\nDate: 2026-11-24\nTotal: USD 12.30',fields:'merchant,date,total'}).brief).toBe('merchant: "Shop"; date: "2026-11-24"; total: "USD 12.30"');
});
it('refuses conflicting aliases rather than choosing a total or date',()=>{
 expect(()=>extractSuppliedContent({content:'Total: 10\nAmount Due: 20',fields:'total'})).toThrow();
 expect(()=>extractSuppliedContent({content:'Date: 2026-11-24\nCreated: 2026-11-23',fields:'date'})).toThrow();
});
it('does not treat subtotal or due date as the requested total or date',()=>{
 expect(()=>extractSuppliedContent({content:'Subtotal: 10\nDue Date: 2026-11-24',fields:'total'})).toThrow();
 expect(()=>extractSuppliedContent({content:'Subtotal: 10\nDue Date: 2026-11-24',fields:'date'})).toThrow();
});
it('scripts, styles and comments are not extracted or executed',()=>{
 expect(extractSuppliedContent({content:'<script>Total: 99</script><style>Total: 98</style><!--Total: 97--><p>Total: 10</p>',fields:'total'}).brief).toBe('total: "10"');
});
it('does not fetch links, images or encoded instructions embedded in HTML',()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 try{expect(extractSuppliedContent({content:'<img src="http://127.0.0.1/secret"><p>Total: 10</p>',fields:'total'}).brief).toBe('total: "10"');expect(fetch).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
});
it('supports an explicit label followed by value in a table cell',()=>{
 expect(extractSuppliedContent({content:'<table><tr><td>Total</td><td>USD 10.00</td></tr></table>',fields:'total'}).brief).toBe('total: "USD 10.00"');
});

it('verbatim sample excerpt fits canonical 256-byte input and complete 80-character brief',()=>{
 const html=readFileSync('tests/fixtures/content-extraction-sample-invoice.html','utf8');
 const excerpt=html.slice(html.indexOf('Invoice #: 123'),html.indexOf('Due: February 3, 2016')+'Due: February 3, 2016'.length);
 expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(256);
 expect(extractSuppliedContent({content:excerpt,fields:'invoice_number,date'}).brief).toBe('invoice_number: "123"; date: "January 3, 2016"');
});
it('an incomplete script body is unsupported rather than extracted as ordinary text',()=>{
 expect(()=>extractSuppliedContent({content:'<script>Total: 99',fields:'total'})).toThrow();
});

it('custom keys never inherit alias-map members',()=>{
 expect(extractSuppliedContent({content:'toString: exact',fields:'toString'}).brief).toBe('toString: "exact"');
});
it('HTML entity decoding preserves explicit text without inferred currency conversion',()=>{
 expect(extractSuppliedContent({content:'<p>Merchant: A &amp; B</p><p>Total: USD&nbsp;12.30</p>',fields:'merchant,total'}).brief).toBe('merchant: "A & B"; total: "USD 12.30"');
});

it('duplicate JSON keys, including escaped spellings, are ambiguous',()=>{
 expect(()=>extractSuppliedContent({content:'{"x":1,"x":2}',fields:'x'})).toThrow();
 expect(()=>extractSuppliedContent({content:'{"x":1,"\\u0078":2}',fields:'x'})).toThrow();
});
it('brief must also fit the canonical UTF-8 byte slot',()=>{
 expect(()=>extractSuppliedContent({content:JSON.stringify({x:'😀'.repeat(66)}),fields:'x'})).toThrow();
});

it.each(['1.0000000000000001','9007199254740991.1','-0','1e0','1.0','-9007199254740992'])('refuses non-exact numeric token %s before accepting parsed value',token=>{
 expect(()=>extractSuppliedContent({content:'{"x":'+token+'}',fields:'x'})).toThrow();
});
it('oversized content with tiny extracted field refuses on input size, not brief size',()=>{
 try{extractSuppliedContent({content:JSON.stringify({x:1,padding:'z'.repeat(16384)}),fields:'x'});throw Error('accepted oversized input');}
 catch(error){expect(error).toMatchObject({code:'CONTENT_TOO_LARGE'});}
});
it('safe integer limits preserve exact sign and value',()=>{
 expect(extractSuppliedContent({content:'{"x":-9007199254740991}',fields:'x'}).brief).toBe('x: -9007199254740991');
 expect(extractSuppliedContent({content:'{"x":9007199254740991}',fields:'x'}).brief).toBe('x: 9007199254740991');
});

describe('source-preserved real CORD receipts, no OCR or merchant inference',()=>{
 const cord=(n:number)=>readFileSync(join(__dirname,`fixtures/content-extraction-cord/test-${n}.txt`),'utf8');
 it('extracts exact inline TOTAL, not cash, from real receipt test1 within the canonical input bytes',()=>{
  const text=cord(1);expect(Buffer.byteLength(text,'utf8')).toBeLessThanOrEqual(256);
  const out=extractSuppliedContent({content:text,fields:'total'});expect(out.brief).toBe('total: "91000"');expect(out.independently_verified).toBe(false);
 });
 it.each([0,2])('does not infer an ambiguous/unlabelled total from receipt test%s',n=>{
  expect(()=>extractSuppliedContent({content:cord(n),fields:'total'})).toThrow();
 });
 it('does not infer removed merchant/date or reinterpret cash as total',()=>{
  for(const fields of ['merchant','date'])expect(()=>extractSuppliedContent({content:cord(1),fields})).toThrow();
  expect(()=>extractSuppliedContent({content:cord(1).replace('TOTAL 91000','CASH 91000'),fields:'total'})).toThrow();
 });
 it('conflicting inline totals refuse, identical repeated labels stay exact',()=>{
  expect(()=>extractSuppliedContent({content:cord(1)+'TOTAL 92000',fields:'total'})).toThrow();
  expect(extractSuppliedContent({content:cord(1)+'TOTAL 91000',fields:'total'}).brief).toBe('total: "91000"');
 });
});

it.each([0,1,2])('CORD text fixture %s is reconstructed without invented labels or amounts',n=>{
 const base=join(__dirname,`fixtures/content-extraction-cord/test-${n}`);
 const annotation=JSON.parse(readFileSync(base+'-annotation.json','utf8'));
 const rows=new Map<number,Array<{text:string,quad:{x1:number,y1:number}}>>();
 for(const line of annotation.valid_line)for(const word of line.words){
  if(!rows.has(word.row_id))rows.set(word.row_id,[]);rows.get(word.row_id)!.push(word);
 }
 const text=[...rows.values()].sort((a,b)=>Math.min(...a.map(w=>w.quad.y1))-Math.min(...b.map(w=>w.quad.y1))).map(words=>words.sort((a,b)=>a.quad.x1-b.quad.x1).map(w=>w.text).join(' ')).join('\n')+'\n';
 expect(readFileSync(base+'.txt','utf8')).toBe(text);
});
