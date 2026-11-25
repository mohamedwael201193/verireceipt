import {afterAll,afterEach,expect,it} from 'vitest';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
const dir=mkdtempSync('/tmp/proof-restore-');process.env.SQLITE_PATH=join(dir,'receipts.sqlite');
import {makeReceipt,sha256Hex} from '../src/core/receipt';import {getDb,saveReceipt,getReceiptEvidence,getReceiptPageEvidence,closeDb} from '../src/core/db';import {restoreProofEvidence} from '../src/tools/restoreProofEvidence';
afterEach(()=>delete process.env.PROOF_RECEIPT_IDS);afterAll(()=>{closeDb();rmSync(dir,{recursive:true,force:true});});
it.skipIf(!!process.env.DATABASE_URL)('restores main and pages only from exact matching bytes, keeps metadata immutable and idempotent',async()=>{
 const body=Buffer.from('retention test bytes'),page=Buffer.from('retention page bytes');const r=makeReceipt('TRAVEL_DISRUPTION_GENERAL','https://nasstatus.faa.gov/api/airport-status-information',body,'single source');saveReceipt(r,body,[{url:r.upstream_url,body:page}]);const db=getDb();
 db.prepare('UPDATE miner_receipts SET evidence_gzip=NULL,evidence_bytes=0 WHERE receipt_id=?').run(r.receipt_id);db.prepare('UPDATE miner_receipt_pages SET evidence_gzip=NULL,evidence_bytes=0 WHERE receipt_id=?').run(r.receipt_id);
 await expect(restoreProofEvidence(r.receipt_id,body)).rejects.toThrow('configured');process.env.PROOF_RECEIPT_IDS=r.receipt_id;
 await expect(restoreProofEvidence(r.receipt_id,Buffer.from('wrong'))).rejects.toThrow('Digest');expect(getReceiptEvidence(r.receipt_id).evidence).toBeNull();
 expect(await restoreProofEvidence(r.receipt_id,body)).toBe('restored');expect(await restoreProofEvidence(r.receipt_id,body)).toBe('already-present');expect(getReceiptEvidence(r.receipt_id).evidence).toEqual(body);
 await expect(restoreProofEvidence(r.receipt_id,body,0)).rejects.toThrow('Digest');expect(await restoreProofEvidence(r.receipt_id,page,0)).toBe('restored');expect(getReceiptPageEvidence(r.receipt_id,0).evidence).toEqual(page);
 await expect(restoreProofEvidence(r.receipt_id,page,9)).rejects.toThrow('not found');expect(db.prepare('SELECT raw_response_sha256,fetched_at FROM miner_receipts WHERE receipt_id=?').get(r.receipt_id)).toEqual({raw_response_sha256:r.raw_response_sha256,fetched_at:r.fetched_at});
});

it.skipIf(!process.env.DATABASE_URL)('Postgres restores exact pinned main/page bytes and rejects mismatches with no metadata changes',async()=>{
 const pg=await import('../src/core/pgStore');const storage=await import('../src/core/storage');storage.__setStorageBackendForTests('postgres');
 try{const body=Buffer.from('pg retention bytes'),page=Buffer.from('pg page bytes');const r=makeReceipt('TRAVEL_DISRUPTION_GENERAL','https://nasstatus.faa.gov/api/airport-status-information',body,'single source');await storage.saveReceipt(r,body,[{url:r.upstream_url,body:page}]);await storage.settleStoragePrunes();process.env.PROOF_RECEIPT_IDS=r.receipt_id;
 await pg.pgQueryForTests('UPDATE miner_receipts SET evidence_gzip=NULL,evidence_bytes=0 WHERE receipt_id=$1',[r.receipt_id]);await pg.pgQueryForTests('UPDATE miner_receipt_pages SET evidence_gzip=NULL,evidence_bytes=0 WHERE receipt_id=$1',[r.receipt_id]);
 await expect(restoreProofEvidence(r.receipt_id,page)).rejects.toThrow('Digest');expect((await storage.getReceiptEvidence(r.receipt_id)).evidence).toBeNull();
 expect(await restoreProofEvidence(r.receipt_id,body)).toBe('restored');expect(await restoreProofEvidence(r.receipt_id,body)).toBe('already-present');expect((await storage.getReceiptEvidence(r.receipt_id)).evidence).toEqual(body);
 await expect(restoreProofEvidence(r.receipt_id,body,0)).rejects.toThrow('Digest');expect(await restoreProofEvidence(r.receipt_id,page,0)).toBe('restored');expect((await storage.getReceiptPageEvidence(r.receipt_id,0)).evidence).toEqual(page);
 }finally{await storage.closeStorage();storage.__setStorageBackendForTests(null);}
});

it.skipIf(!!process.env.DATABASE_URL)('refuses over64MiB before gzip/write but accepts exact64MiB and rejects invalid page indices',async()=>{
 const bytes=Buffer.alloc(65*1024*1024,65);const r=makeReceipt('TRAVEL_DISRUPTION_GENERAL','https://nasstatus.faa.gov/api/airport-status-information',bytes,'single source');const db=getDb();db.prepare('INSERT INTO miner_receipts(receipt_id,intent,upstream_url,raw_response_sha256,fetched_at,evidence_bytes) VALUES(?,?,?,?,?,0)').run(r.receipt_id,r.intent,r.upstream_url,r.raw_response_sha256,r.fetched_at);process.env.PROOF_RECEIPT_IDS=r.receipt_id;
 await expect(restoreProofEvidence(r.receipt_id,bytes)).rejects.toThrow('exceeds64MiB');expect(getReceiptEvidence(r.receipt_id).evidence).toBeNull();
 for(const page of [-1,.5,NaN,Infinity])await expect(restoreProofEvidence(r.receipt_id,Buffer.from('bytes'),page)).rejects.toThrow('Invalid page');
 const boundary=bytes.subarray(0,64*1024*1024);db.prepare('UPDATE miner_receipts SET raw_response_sha256=? WHERE receipt_id=?').run(sha256Hex(boundary),r.receipt_id);expect(await restoreProofEvidence(r.receipt_id,boundary)).toBe('restored');expect(getReceiptEvidence(r.receipt_id).evidence?.length).toBe(64*1024*1024);
});
