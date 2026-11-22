// Operator-only inspection. Every query runs inside a read-only transaction.
// No signing, external calls, refunds, retries, deletion or payer-lease changes.
import type { PoolClient } from 'pg';
export interface RetentionPreview { payloadDays:number; accountingDays:number }
export function validatePreview(v:RetentionPreview):void {
  if(!Number.isInteger(v.payloadDays)||!Number.isInteger(v.accountingDays)||v.payloadDays<1||v.accountingDays<v.payloadDays||v.accountingDays>3650)throw new Error('Invalid explicit preview periods');
}
export async function inspectVisitorJobs(client:PoolClient, id?:string, preview?:RetentionPreview) {
  if(id&&!/^[0-9a-f-]{36}$/.test(id))throw new Error('Invalid job id');
  if(preview)validatePreview(preview);
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='5000ms'");
    const r=await client.query(`SELECT j.id,j.state,j.created_at,j.signed_at,j.reserved_uusdc::text,j.plan_hash,j.nonce,
      j.response_headers, j.private_response IS NOT NULL AS body_captured,
      j.result IS NOT NULL AS report_captured,
      coalesce(j.private_response->>'receiptHeader',j.response_headers->>'receiptHeader') AS receipt_header,
      p.active_job=j.id AND p.blocked_until>clock_timestamp() AS lease_active,
      CASE WHEN p.active_job=j.id THEN p.blocked_until ELSE NULL END AS lease_expires_at
      FROM visitor_research_jobs j CROSS JOIN visitor_research_payer p WHERE p.id=1
      AND ($1::uuid IS NULL OR j.id=$1::uuid) ORDER BY j.created_at DESC LIMIT 100`,[id??null]);
    const totals=await client.query(`SELECT count(*)::text AS jobs, count(*) FILTER(WHERE state='uncertain')::text AS uncertain_jobs,
      coalesce(sum(reserved_uusdc),0)::text AS reserved_uusdc FROM visitor_research_jobs`);
    let retentionPreview=null;
    if(preview){
      const counts=await client.query(`SELECT count(*) FILTER(WHERE created_at<clock_timestamp()-$1*interval '1 day')::text AS payload_candidates,
        count(*) FILTER(WHERE created_at<clock_timestamp()-$2*interval '1 day')::text AS accounting_candidates,
        count(*) FILTER(WHERE state IN ('reserved','signed','uncertain'))::text AS unresolved_hold_jobs
        FROM visitor_research_jobs`,[preview.payloadDays,preview.accountingDays]);
      retentionPreview={hypothetical_only:true,not_approved:true,erasure_performed:false,...preview,...counts.rows[0]};
    }
    await client.query('COMMIT');
    return {version:1,read_only:true,network:'eip155:11155111',retention_policy:'undecided',records_auto_expire:false,
      settlement_verified:false,warning:'Local reservation and captured evidence only. A receipt header or completed report is not proof of settlement. No refund, retry or lease release is authorized by this output.',
      totals:totals.rows[0],jobs:r.rows,retention_preview:retentionPreview};
  }catch(error){await client.query('ROLLBACK');throw error;}
}
