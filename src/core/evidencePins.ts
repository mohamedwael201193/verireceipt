import {RECEIPT_ID_RE} from './receipt';

/** Deployment configuration only, never request-controlled. Persist this env across deploys. */
export function proofReceiptIds(): string[] {
  const ids=[...new Set((process.env.PROOF_RECEIPT_IDS ?? '').split(',').map(id=>id.trim()).filter(Boolean))];
  if(ids.length>64||ids.some(id=>!RECEIPT_ID_RE.test(id)))throw new Error('Invalid PROOF_RECEIPT_IDS configuration: at most64 valid receipt ids');
  return ids;
}

export function evidenceBudgetBytes(raw=process.env.EVIDENCE_BUDGET_MIB): number {
  const text=raw?.trim()??'';
  if(!text)return 300*1024*1024;
  if(!/^[0-9]+$/.test(text)||Number(text)<1||Number(text)>500)throw new Error('Invalid EVIDENCE_BUDGET_MIB configuration: integer1through500');
  return Number(text)*1024*1024;
}

export function logEvidencePrune(backend:'sqlite'|'postgres',bytes:number,cap:number,pruned?:number): void {
  console.info(JSON.stringify({event:'evidence_prune',backend,unpinned_bytes:bytes,cap_bytes:cap,...(pruned===undefined?{}:{pruned})}));
  if(bytes>=cap*.8)console.warn(JSON.stringify({event:'evidence_budget_warning',backend,unpinned_bytes:bytes,cap_bytes:cap}));
}
