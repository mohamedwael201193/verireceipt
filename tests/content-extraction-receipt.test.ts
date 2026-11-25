import {afterAll,afterEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
const dir=mkdtempSync('/tmp/extract-receipt-');process.env.SQLITE_PATH=join(dir,'r.sqlite');afterAll(()=>rmSync(dir,{recursive:true,force:true}));afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});
vi.mock('../src/core/storage',async original=>({...await original<typeof import('../src/core/storage')>(),saveReceipt:vi.fn(async()=>{})}));
import {handleContentExtraction} from '../src/handlers/contentExtractionReceipt';import {saveReceipt} from '../src/core/storage';import {sha256Hex} from '../src/core/receipt';
const raw=readFileSync(join(__dirname,'fixtures/content-extraction-sample-invoice.html'),'utf8');
it('receipts exact real supplied HTML and aligned extracted fields without a network call',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const out=await handleContentExtraction({content:raw,fields:'date,total'});
 expect(out.brief).toBe('date: "January 3, 2016"; total: "$385.00"');expect(out.title).toBe('');expect(out.title_identified).toBe(false);expect(out.url).toBe('');expect(out.independently_verified).toBe(false);expect(out.source_kind).toBe('caller-supplied-content');expect(out.verdict).toBe('extracted');expect(out.answer).toContain('not independently verified');expect(fetch).not.toHaveBeenCalled();
 expect(saveReceipt).toHaveBeenCalledTimes(1);const [receipt,evidence]=vi.mocked(saveReceipt).mock.calls[0];expect(receipt.intent).toBe('CONTENT_EXTRACTION_GENERAL');expect(receipt.upstream_url).toBe('supplied:inline');expect(receipt.raw_response_sha256).toBe(sha256Hex(evidence));const e=JSON.parse(String(evidence));expect(e.supplied_content).toBe(raw);expect(e.requested_fields).toBe('date,total');expect(e.extracted.brief).toBe(out.brief);expect(e.independently_verified).toBe(false);expect(receipt.fetched_at).toBe(out.acquired_at);
});
it('source is caller input even for JSON, never the extracted URL or title',async()=>{
 const content=JSON.stringify({title:'Supplied label',url:'https://example.invalid/untrusted'});const r=await handleContentExtraction({content,fields:'title'});expect(r.title).toBe('');expect(r.url).toBe('');expect((r.receipt as any).upstream_url).toBe('supplied:inline');expect(r.content).toBe('title: "Supplied label"');
});
it('storage failure refuses and is not retried',async()=>{
 vi.mocked(saveReceipt).mockRejectedValueOnce(Error('private storage detail'));await expect(handleContentExtraction({content:raw,fields:'date,total'})).rejects.toMatchObject({status:502,code:'RECEIPT_PERSIST_FAILED'});expect(saveReceipt).toHaveBeenCalledTimes(1);
});
it.each([{content:'https://example.invalid/',fields:'total'},{content:raw,fields:'merchant'},{content:'{}',fields:'total'},{fields:'total'}])('invalid/unsupported input never receives a receipt %j',async query=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);await expect(handleContentExtraction(query)).rejects.toBeDefined();expect(saveReceipt).not.toHaveBeenCalled();expect(f).not.toHaveBeenCalled();
});
