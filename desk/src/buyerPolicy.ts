// A separate hosted product policy. Never edits or substitutes the original
// gate-policy.v1.json or any frozen benchmark. No visitor-chosen threshold.
import { randomUUID } from 'node:crypto';
import { buyerInput, buyerPlanHash, BUYER, HOSTED_BUYER_POLICY, HOSTED_BUYER_POLICY_HASH, type BuyerPlan } from '../../src/buyer/contracts.js';
import { policyObjectHash, type GatePolicy } from './gatePolicy.js';
export const BUYER_TASK='hosted-exact-10q-minimum-three';

export function hostedBuyerPolicy():GatePolicy{return structuredClone(HOSTED_BUYER_POLICY) as GatePolicy;}
export const BUYER_POLICY_HASH=HOSTED_BUYER_POLICY_HASH;
export function makeBuyerPlan(raw:unknown,now=new Date(),id=randomUUID()):BuyerPlan {
 const input=buyerInput(raw,now),task=HOSTED_BUYER_POLICY.tasks[0];
 const body:Omit<BuyerPlan,'plan_hash'>={version:'sponsored-filing-plan-v1',id,created_at:now.toISOString(),expires_at:new Date(now.getTime()+BUYER.planSeconds*1000).toISOString(),input,policy_hash:BUYER_POLICY_HASH,task_hash:policyObjectHash(task),network:BUYER.network,call_uusdc:BUYER.callUusdc,daily_cap_uusdc:BUYER.dailyUusdc,form:'10-Q',minimum_count:3,params:{entity:`Form 10-Q filings (CIK ${input.cik})`,period:`calendar ${input.year}`},rule:{op:'>=',value:3,units:'filings',label:task.rule.label}};
 return {...body,plan_hash:buyerPlanHash(body)};
}
