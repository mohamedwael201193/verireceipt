// These controls isolate the Crossref fallback and its cache/failure semantics.
vi.mock('../src/handlers/openAlexAcademic',()=>({openAlexAnswer:vi.fn(async()=>{throw Error('OpenAlex unavailable in Crossref-specific control');})}));
import {afterAll,afterEach,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
const dir=mkdtempSync('/tmp/academic-metadata-');process.env.SQLITE_PATH=join(dir,'r.sqlite');afterAll(()=>rmSync(dir,{recursive:true,force:true}));
import {parseCrossrefWorks,handleAcademicSearch} from '../src/handlers/academicSearch';import {resetAcademicCacheForTests} from '../src/handlers/academicSourceCache';import {getReceiptEvidence} from '../src/core/storage';import {sha256Hex} from '../src/core/receipt';
afterEach(()=>{resetAcademicCacheForTests();vi.unstubAllGlobals();});
const raw=readFileSync(join(__dirname,'fixtures/academic/crossref-verifiable-compute-receipts.json'),'utf8');
const changed=(edit:(a:any)=>void)=>{const b=JSON.parse(raw);edit(b.message.items[0]);return JSON.stringify(b);};
it('enriches real recorded works without changing rank, DOI alignment or corpus count',async()=>{
 const parsed=parseCrossrefWorks(raw);expect(parsed.papers[0]).toMatchObject({authors:['D. Chaum'],publication_year:2004,venue:'IEEE Security &amp; Privacy Magazine',work_type:'journal-article',crossref_citation_count:256});
 expect(parsed.papers[1]).toMatchObject({authors:['Matthew Schneider','Robert Orozco'],publication_year:2026,venue:null,work_type:'posted-content',crossref_citation_count:0});
 vi.stubGlobal('fetch',async()=>new Response(raw));const r=await handleAcademicSearch({query:'verifiable compute receipts'});expect(r.total_matches).toBe(18381);expect(r.papers).toEqual(parsed.papers);expect(r.paper_titles).toEqual(parsed.papers.map(p=>p.title));expect(r.dois).toEqual(parsed.papers.map(p=>p.doi));
 expect(r.answer).toContain('D. Chaum; 2004; IEEE Security &amp; Privacy Magazine; type journal-article; 256 Crossref citations');expect(r.answer).toContain('work type is not proof of peer review');expect(r.metadata_scope).toContain('Crossref-only');
 const receipt=r.receipt as any;const stored=await getReceiptEvidence(receipt.receipt_id);expect(sha256Hex(stored.evidence!)).toBe(receipt.raw_response_sha256);const e=JSON.parse(stored.evidence!.toString());expect(e.raw_body).toBe(raw);expect(e.papers).toEqual(parsed.papers);
});
it('missing optional metadata stays unknown, never inferred from DOI or other dates',async()=>{
 const body=changed(a=>{delete a.author;delete a.published;delete a['container-title'];delete a.type;delete a['is-referenced-by-count'];a.created={'date-parts':[[2025]]};});
 const p=parseCrossrefWorks(body).papers[0];expect(p).toMatchObject({authors:[],publication_year:null,venue:null,work_type:null,crossref_citation_count:null});vi.stubGlobal('fetch',async()=>new Response(body));const r=await handleAcademicSearch({query:'topic'});expect((r.papers as any[]).every(p=>p.publication_year!==null||p.venue!==null)).toBe(true);expect(r.paper_titles).not.toContain(p.title);
});
it.each([-1,1.2,'3',null,9007199254740992])('invalid citation count %s is unknown',count=>{expect(parseCrossrefWorks(changed(a=>a['is-referenced-by-count']=count)).papers[0].crossref_citation_count).toBeNull();});
it.each([0,10000,2026.5,'2026',null])('invalid publication year %s is unknown',year=>{expect(parseCrossrefWorks(changed(a=>a.published={'date-parts':[[year]]})).papers[0].publication_year).toBeNull();});
it('malformed optional containers do not discard valid title/DOI',()=>{
 const p=parseCrossrefWorks(changed(a=>{a.author={name:'not an array'};a.published=[];a['container-title']={name:'not an array'};a.type=4;})).papers[0];expect(p.authors).toEqual([]);expect(p.publication_year).toBeNull();expect(p.venue).toBeNull();expect(p.work_type).toBeNull();expect(p.doi).toBe('10.1109/msecp.2004.1264852');
});
it('author literal names, trimmed personal names and partial names, but no invented labels',()=>{
 const p=parseCrossrefWorks(changed(a=>a.author=[null,7,[],{}, {name:'  Consortium  ',given:'ignored',family:'ignored'},{given:' A ',family:' B '},{family:' Family '},{given:' Given '},{given:4,family:7}])).papers[0];expect(p.authors).toEqual(['Consortium','A B','Family','Given']);
});
it('skipped DOI/title items cannot shift enriched metadata onto another work',()=>{const b=JSON.parse(raw);delete b.message.items[0].DOI;const p=parseCrossrefWorks(JSON.stringify(b));expect(p.skipped).toBe(1);expect(p.papers[0].authors).toEqual(['Matthew Schneider','Robert Orozco']);expect(p.papers[0].doi).not.toBe('10.1109/msecp.2004.1264852');});
