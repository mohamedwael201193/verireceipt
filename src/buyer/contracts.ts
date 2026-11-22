// Public narrow hosted contract. Never accepts a key, recipient, rule, form,
// network, price, URL, miner or signing message from a visitor.
import { createHash } from 'node:crypto';
export const BUYER = Object.freeze({network:'eip155:11155111',callUusdc:'10000',dailyUusdc:'2000000',form:'10-Q',minimum:3,planSeconds:600,payloadHours:24,tombstoneHours:48,leaseSeconds:180,executionMs:90000,maxResultBytes:24000000,maxRetainedBytes:256000000});
function deepFreeze<T>(value:T):T {if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))deepFreeze(v);}return value;}
export const HOSTED_BUYER_POLICY=deepFreeze({version:'gate-policy-v1',committed_at:'2026-11-22T18:52:02Z',network:'eip155:11155111',rail:'escrow',routing:'auto',max_call_uusdc:'10000',note:'Hosted filing product v1, exact 10-Q, completed calendar filing year, fixed minimum three. Advisory research only. Dedicated operator-sponsored testnet payer; disabled by default.',tasks:[{id:'hosted-exact-10q-minimum-three',mission:'M4',title:'Exact 10-Q filing coverage for the selected CIK and completed calendar year',intent:'REGULATORY_FILING_MONITOR_GENERAL',value_field:'filing_count',fixed_params:{},accepts_params:['entity','period'],rule:{op:'>=',value:3,units:'filings',label:'Verified exact 10-Q filing count at least three'}}]});
export interface BuyerInput {cik:string;year:number}
export interface BuyerPlan {version:'sponsored-filing-plan-v1';id:string;created_at:string;expires_at:string;input:BuyerInput;plan_hash:string;policy_hash:string;task_hash:string;network:string;call_uusdc:string;daily_cap_uusdc:string;form:'10-Q';minimum_count:3;params:Record<string,string>;rule:{op:'>=';value:3;units:'filings';label:string}}
export function buyerInput(value:unknown,now=new Date()):BuyerInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Use CIK and completed calendar year');
 const p=value as Record<string,unknown>;
 if(Object.keys(p).sort().join(',')!=='cik,year'||typeof p.cik!=='string'||! /^[1-9][0-9]{0,9}$/.test(p.cik)||typeof p.year!=='number'||!Number.isInteger(p.year)||p.year<1994||p.year>=now.getUTCFullYear())throw new Error('Unsupported filing question');
 return {cik:p.cik,year:p.year};
}
export function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(value);
}
export const digest=(v:unknown)=>createHash('sha256').update(canonical(v).replace(/&/g,'\\u0026').replace(/</g,'\\u003c').replace(/>/g,'\\u003e')).digest('hex');
export const HOSTED_BUYER_POLICY_HASH=digest(HOSTED_BUYER_POLICY);
export const HOSTED_BUYER_TASK_HASH=digest(HOSTED_BUYER_POLICY.tasks[0]);
export const buyerId=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function buyerPlanHash(p:Omit<BuyerPlan,'plan_hash'>|BuyerPlan):string {const {plan_hash:_,...body}=p as BuyerPlan;return digest(body);}
export function validateBuyerPlan(p:BuyerPlan,now=new Date(),allowExpired=false):void {
 const input=buyerInput(p.input,now);
 if(p.version!=='sponsored-filing-plan-v1'||!buyerId(p.id)||p.network!==BUYER.network||p.call_uusdc!==BUYER.callUusdc||p.daily_cap_uusdc!==BUYER.dailyUusdc||p.form!==BUYER.form||p.minimum_count!==BUYER.minimum||p.rule.op!=='>='||p.rule.value!==3||p.rule.units!=='filings'||p.policy_hash!==HOSTED_BUYER_POLICY_HASH||p.task_hash!==HOSTED_BUYER_TASK_HASH||canonical(p.rule)!==canonical(HOSTED_BUYER_POLICY.tasks[0].rule))throw new Error('Invalid frozen buyer terms');
 if(p.params.entity!==`Form 10-Q filings (CIK ${input.cik})`||p.params.period!==`calendar ${input.year}`||Object.keys(p.params).sort().join(',')!=='entity,period'||p.plan_hash!==buyerPlanHash(p))throw new Error('Buyer input/plan binding failed');
 const created=Date.parse(p.created_at),expires=Date.parse(p.expires_at);
 if(!Number.isFinite(created)||!Number.isFinite(expires)||expires-created!==BUYER.planSeconds*1000||created>now.getTime()+5000||(!allowExpired&&expires<=now.getTime()))throw new Error('Buyer plan expired or invalid');
}
export function assertDedicatedBuyer(address:string,exclusions:{cli:string[];research:string[]}):string {
 if(!exclusions||!Array.isArray(exclusions.cli)||!exclusions.cli.length||!Array.isArray(exclusions.research)||!exclusions.research.length||[...exclusions.cli,...exclusions.research].some(x=>! /^0x[0-9a-fA-F]{40}$/.test(x)))throw new Error('Complete CLI and research payer exclusion sets are required');
 const otherAddresses=[...exclusions.cli,...exclusions.research];
 if(! /^0x[0-9a-fA-F]{40}$/.test(address)||/^0x0{40}$/i.test(address))throw new Error('Configure a dedicated testnet payer address');
 const normalized=address.toLowerCase();
 if(['0xf76e6b0920e9332ff4410f6dd53f01722abc71a3',...otherAddresses.map(x=>x.toLowerCase())].includes(normalized))throw new Error('Buyer payer must be separate from existing CLI/research payers');
 return normalized;
}
