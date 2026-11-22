import {BUYER,HOSTED_BUYER_POLICY,canonical,type BuyerPlan} from './contracts';
import type {BuyerExecutionResult} from './runtimeTypes';
export function validateBuyerResult(p:BuyerPlan,r:BuyerExecutionResult,payer:string):void {
 const record=r?.record,purchase=record?.purchase as Record<string,unknown>|undefined;
 if(r?.version!=='hosted-ranked-filing-result-v1'||r.plan_id!==p.id||r.plan_hash!==p.plan_hash||r.policy_hash!==p.policy_hash||r.task_hash!==p.task_hash||r.payer!==payer||!record||record.policy_hash!==p.policy_hash||record.task_hash!==p.task_hash||record.payer!==payer||record.gate_id!==HOSTED_BUYER_POLICY.tasks[0].id||record.intent!=='REGULATORY_FILING_MONITOR_GENERAL'||canonical(record.rule)!==canonical(p.rule)||canonical(record.params)!==canonical(p.params)||!['PASS','HOLD'].includes(String(record.outcome))||!purchase||r.charge?.maximum_uusdc!==BUYER.callUusdc)throw new Error('Result binding refused');
 if(r.charge.status==='receipt'){
  const receipt=r.receipt;
  if(r.charge.amount_uusdc!==BUYER.callUusdc||purchase.paid_uusdc!==BUYER.callUusdc||!receipt||String(receipt.payer).toLowerCase()!==payer||String(receipt.amount_uusdc)!==BUYER.callUusdc||receipt.intent!=='REGULATORY_FILING_MONITOR_GENERAL'||receipt.receipt_hash!==purchase.receipt_hash||receipt.epoch_id!==purchase.epoch_id||String(receipt.miner)!==purchase.serving_miner||!Number.isSafeInteger(receipt.timestamp)||Number(receipt.timestamp)<=0)throw new Error('Charge binding refused');
 }else if(!['not_signed','uncertain'].includes(r.charge.status)||r.charge.amount_uusdc!==null||r.receipt!==null||record.outcome!=='HOLD')throw new Error('Unknown charge must HOLD');
 if(record.outcome==='PASS'){
  const source=record.source_verification as {status?:string;checks?:{ok:boolean}[]}|undefined,node=record.node_checks as {ok:boolean}[]|undefined,miner=record.miner_checks as {ok:boolean}[]|undefined;
  if(r.charge.status!=='receipt'||record.record_appended!==true||!Number.isSafeInteger(record.value)||Number(record.value)<3||record.miner_chain==='failed'||!Array.isArray(node)||!node.length||node.some(c=>c.ok!==true)||!Array.isArray(miner)||miner.some(c=>c.ok!==true)||source?.status!=='verified'||!Array.isArray(source.checks)||!source.checks.length||source.checks.some(c=>c.ok!==true))throw new Error('PASS evidence refused');
 }
}
/** The job screen gets check summaries; full raw primary data is a separate private download. */
export function buyerResultSummary(result:unknown):unknown {
 if(!result)return null;const r=structuredClone(result) as BuyerExecutionResult;
 const source=r.record?.source_verification as {sources?:Record<string,unknown>[]} | undefined;
 if(Array.isArray(source?.sources))source.sources=source.sources.map(({raw_text:_,...rest})=>rest);
 return r;
}
