import {afterAll,afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
const dir=mkdtempSync('/tmp/evidence-pins-');process.env.SQLITE_PATH=join(dir,'receipts.sqlite');
import {getDb,saveReceipt,getReceiptEvidence,closeDb,MAX_EVIDENCE_TOTAL_BYTES} from '../src/core/db';
import * as store from '../src/core/storage';
import {proofReceiptIds,evidenceBudgetBytes,logEvidencePrune} from '../src/core/evidencePins';import {PRUNE_OLDEST_EVIDENCE_SQL_PG} from '../src/core/pgStore';
import {makeReceipt,sha256Hex} from '../src/core/receipt';
afterEach(()=>{delete process.env.PROOF_RECEIPT_IDS;vi.restoreAllMocks();});afterAll(()=>{closeDb();rmSync(dir,{recursive:true,force:true});});
it('configured proof main and page evidence survive oldest-first pruning and a storage restart',()=>{
 const bodies=[randomBytes(Math.floor(MAX_EVIDENCE_TOTAL_BYTES*.6)),randomBytes(Math.floor(MAX_EVIDENCE_TOTAL_BYTES*.3)),randomBytes(Math.floor(MAX_EVIDENCE_TOTAL_BYTES*.3)),randomBytes(Math.floor(MAX_EVIDENCE_TOTAL_BYTES*.6))];
 const proof=makeReceipt('TRAVEL_DISRUPTION_GENERAL','https://nasstatus.faa.gov/api/airport-status-information',bodies[0],'single source');proof.fetched_at='2026-01-01T00:00:00Z';
 const page=randomBytes(10000);saveReceipt(proof,bodies[0],[{url:proof.upstream_url,body:page}]);process.env.PROOF_RECEIPT_IDS=proof.receipt_id;
 closeDb();
 let ordinaryFirst:string;
 const ordinary=bodies.slice(1).map((b,i)=>{const r=makeReceipt(proof.intent,proof.upstream_url,b,'single source');r.fetched_at='2026-01-0'+(i+2)+'T00:00:00Z';saveReceipt(r,b);if(i===1)expect(getReceiptEvidence(ordinaryFirst!).evidence).not.toBeNull();if(i===0)ordinaryFirst=r.receipt_id;expect(getReceiptEvidence(r.receipt_id).evidence).not.toBeNull();expect(getReceiptEvidence(proof.receipt_id).evidence).not.toBeNull();return r;});
 expect(getReceiptEvidence(proof.receipt_id).found).toBe(true);expect(sha256Hex(getReceiptEvidence(proof.receipt_id).evidence as Buffer)).toBe(proof.raw_response_sha256);
 expect(getDb().prepare('SELECT evidence_gzip FROM miner_receipt_pages WHERE receipt_id=?').get(proof.receipt_id)).toMatchObject({evidence_gzip:expect.any(Buffer)});
 expect(getReceiptEvidence(ordinary[0].receipt_id).evidence).toBeNull();expect(getReceiptEvidence(ordinary[1].receipt_id).found).toBe(true);
},120000);

it('empty configuration pins nothing; valid duplicates collapse; malformed and excessive configs fail closed',()=>{
 expect(proofReceiptIds()).toEqual([]);const id='rcpt_'+'A'.repeat(26);process.env.PROOF_RECEIPT_IDS=' '+id+','+id+' ';expect(proofReceiptIds()).toEqual([id]);
 process.env.PROOF_RECEIPT_IDS='bad';expect(()=>proofReceiptIds()).toThrow();process.env.PROOF_RECEIPT_IDS=Array.from({length:65},(_,i)=>'rcpt_'+String(i).padStart(26,'0')).join(',');expect(()=>proofReceiptIds()).toThrow();
});
it('Postgres victim SQL has parameterized pin exclusion alongside page-only pruning',()=>{expect(PRUNE_OLDEST_EVIDENCE_SQL_PG).toContain('r.receipt_id <> ALL($2::text[])');expect(PRUNE_OLDEST_EVIDENCE_SQL_PG).toContain('miner_receipt_pages');});

it('budget defaults300MiB and validates1through500MiB',()=>{expect(evidenceBudgetBytes('')).toBe(300*1024*1024);expect(evidenceBudgetBytes('500')).toBe(500*1024*1024);for(const raw of ['0','501','-1','1.5','NaN','Infinity'])expect(()=>evidenceBudgetBytes(raw)).toThrow();});

it.skipIf(!process.env.DATABASE_URL)('Postgres proof evidence and pages survive pruning and pool restart; pinned bytes excluded from budget',async()=>{
 store.__setStorageBackendForTests('postgres');
 try{
  const body=randomBytes(Math.floor(MAX_EVIDENCE_TOTAL_BYTES*.6));const proof=makeReceipt('TRAVEL_DISRUPTION_GENERAL','https://nasstatus.faa.gov/api/airport-status-information',body,'single source');proof.fetched_at='2026-01-01T00:00:00Z';
  await store.saveReceipt(proof,body,[{url:proof.upstream_url,body:'exact page bytes'}]);await store.settleStoragePrunes();process.env.PROOF_RECEIPT_IDS=proof.receipt_id;await store.closeStorage();
  const ordinary=[];for(let i=0;i<3;i++){const bytes=randomBytes(Math.floor(MAX_EVIDENCE_TOTAL_BYTES*(i===2?.6:.3)));const r=makeReceipt(proof.intent,proof.upstream_url,bytes,'single source');r.fetched_at='2026-01-0'+(i+2)+'T00:00:00Z';store.__resetPruneEstimateForTests();await store.saveReceipt(r,bytes);await store.settleStoragePrunes();ordinary.push(r);if(i===1)expect((await store.getReceiptEvidence(ordinary[0].receipt_id)).evidence).not.toBeNull();expect((await store.getReceiptEvidence(r.receipt_id)).evidence).not.toBeNull();expect((await store.getReceiptEvidence(proof.receipt_id)).evidence).not.toBeNull();}
  const full=await store.getReceiptEvidence(proof.receipt_id);expect(sha256Hex(full.evidence as Buffer)).toBe(proof.raw_response_sha256);
  expect((await store.getReceiptPageEvidence(proof.receipt_id,0)).evidence?.toString()).toBe('exact page bytes');
  expect((await store.getReceiptEvidence(ordinary[0].receipt_id)).evidence).toBeNull();expect((await store.getReceiptEvidence(ordinary[1].receipt_id)).evidence).not.toBeNull();
 }finally{await store.closeStorage();store.__setStorageBackendForTests(null);}
},120000);

it('80percent warning has only closed diagnostic fields and fires at the boundary',()=>{const info=vi.spyOn(console,'info').mockImplementation(()=>{});const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});logEvidencePrune('postgres',79,100,0);expect(warn).not.toHaveBeenCalled();logEvidencePrune('postgres',80,100,0);expect(warn).toHaveBeenCalledTimes(1);expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({event:'evidence_budget_warning',backend:'postgres',unpinned_bytes:80,cap_bytes:100});expect(info).toHaveBeenCalledTimes(2);});
