// Operator-only restore: exact bytes into an existing pinned row, never new metadata.
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {Pool} from 'pg';
import {getDb,closeDb} from '../core/db';
import {pgPoolConfig} from '../core/pgStore';
import {proofReceiptIds} from '../core/evidencePins';
import {RECEIPT_ID_RE,sha256Hex,normalizeSha256Hex} from '../core/receipt';

export async function restoreProofEvidence(id:string,body:Buffer,page?:number):Promise<'restored'|'already-present'> {
 if(!RECEIPT_ID_RE.test(id)||!proofReceiptIds().includes(id))throw Error('Restore requires a complete configured proof receipt id');
 if(page!==undefined&&(!Number.isSafeInteger(page)||page<0))throw Error('Invalid page index');
 if(body.length>64*1024*1024)throw Error('Restore body exceeds64MiB');
 const table=page===undefined?'miner_receipts':'miner_receipt_pages';
 const digest=sha256Hex(body),gzip=gzipSync(body);
 function check(row:any):boolean {
  if(!row)throw Error('Receipt or page not found; metadata will not be created');
  if(normalizeSha256Hex(row.raw_response_sha256)!==digest)throw Error('Digest mismatch; nothing restored');
  return row.evidence_gzip!==null;
 }
 if(process.env.DATABASE_URL?.trim()){
  const pool=new Pool(pgPoolConfig(process.env.DATABASE_URL));const client=await pool.connect();
  try{
   await client.query('BEGIN');const params:unknown[]=page===undefined?[id]:[id,page];const where=page===undefined?'receipt_id=$1':'receipt_id=$1 AND page_index=$2';
   const {rows:[row]}=await client.query(`SELECT raw_response_sha256,evidence_gzip FROM ${table} WHERE ${where} FOR UPDATE`,params);
   if(check(row)){await client.query('COMMIT');return 'already-present';}
   await client.query(`UPDATE ${table} SET evidence_gzip=$${params.length+1},evidence_bytes=$${params.length+2} WHERE ${where}`,[...params,gzip,body.length]);await client.query('COMMIT');return 'restored';
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
 }
 const db=getDb();return db.transaction(()=>{
  const params=page===undefined?[id]:[id,page];const where=page===undefined?'receipt_id=?':'receipt_id=? AND page_index=?';
  const row=db.prepare(`SELECT raw_response_sha256,evidence_gzip FROM ${table} WHERE ${where}`).get(...params);
  if(check(row))return 'already-present';
  db.prepare(`UPDATE ${table} SET evidence_gzip=?,evidence_bytes=? WHERE ${where}`).run(gzip,body.length,...params);return 'restored';
 })();
}
if(require.main===module){
 const [id,path,page]=process.argv.slice(2);
 if(!id||!path||process.argv.length>5){console.error('Usage: restoreProofEvidence RECEIPT_ID EXACT_BODY_PATH [PAGE_INDEX]');process.exitCode=1;}
 else {const body=readFileSync(path);restoreProofEvidence(id,body,page===undefined?undefined:Number(page)).then(result=>console.log(JSON.stringify({result,sha256:sha256Hex(body)}))).catch(()=>{console.error('Proof restore refused; verify configured pin, existing digest, page and exact bytes');process.exitCode=1;}).finally(()=>closeDb());}
}
