// A separate hosted product policy. Never edits or substitutes the original
// gate-policy.v1.json or any frozen benchmark. No visitor-chosen threshold.
import { randomUUID } from 'node:crypto';
import { buyerInput, buyerPlanHash, BUYER, type BuyerPlan } from '../../src/buyer/contracts.js';
import { policyObjectHash, type GatePolicy } from './gatePolicy.js';
export const BUYER_TASK='hosted-exact-10q-minimum-three';
const policy:GatePolicy={version:'gate-policy-v1',committed_at:'2026-11-22T18:52:02Z',network:'eip155:11155111',rail:'escrow',routing:'auto',max_call_uusdc:'10000',note:'Hosted filing product v1, exact 10-Q, completed calendar filing year, fixed minimum three. Advisory research only. Dedicated operator-sponsored testnet payer; disabled by default.',tasks:[{id:BUYER_TASK,mission:'M4',title:'Exact 10-Q filing coverage for the selected CIK and completed calendar year',intent:'REGULATORY_FILING_MONITOR_GENERAL',value_field:'filing_count',fixed_params:{},accepts_params:['entity','period'],rule:{op:'>=',value:3,units:'filings',label:'Verified exact 10-Q filing count at least three'}}]};
export function hostedBuyerPolicy():GatePolicy{return structuredClone(policy);}
export const BUYER_POLICY_HASH=policyObjectHash(policy);
export function makeBuyerPlan(raw:unknown,now=new Date(),id=randomUUID()):BuyerPlan {
 const input=buyerInput(raw,now),task=policy.tasks[0];
 const body:Omit<BuyerPlan,'plan_hash'>={version:'sponsored-filing-plan-v1',id,created_at:now.toISOString(),expires_at:new Date(now.getTime()+BUYER.planSeconds*1000).toISOString(),input,policy_hash:BUYER_POLICY_HASH,task_hash:policyObjectHash(task),network:BUYER.network,call_uusdc:BUYER.callUusdc,daily_cap_uusdc:BUYER.dailyUusdc,form:'10-Q',minimum_count:3,params:{entity:`Form 10-Q filings (CIK ${input.cik})`,period:`calendar ${input.year}`},rule:{op:'>=',value:3,units:'filings',label:task.rule.label}};
 return {...body,plan_hash:buyerPlanHash(body)};
}
