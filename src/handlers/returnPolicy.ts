// Live official US policy observer. Closed retailer bindings only. A reviewed
// policy section must match exactly, otherwise no stale policy is substituted.
import {createHash} from 'node:crypto';
import {badRequest,unprocessable,upstreamUnavailable} from '../core/errors';
import {readPublicBody,StartBudget} from '../core/publicSource';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
const INTENT='RETURN_POLICY_VERIFY_GENERAL';
let budget=new StartBudget(20,60000);
export function resetReturnPolicyBudgetForTests():void{budget=new StartBudget(20,60000);}
export function policyText(html:string):string{
 return html.replace(/<!--[^]*?-->/g,' ').replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&#(\d+);/g,(_,n)=>{const v=Number(n);return v<=0x10ffff?String.fromCodePoint(v):' ';}).replace(/&#x([0-9a-f]+);/gi,(_,n)=>{const v=parseInt(n,16);return v<=0x10ffff?String.fromCodePoint(v):' ';}).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
}
export function reviewedSection(retailer:'apple'|'walmart',html:string):string{
 const text=policyText(html);
 const start=retailer==='apple'?'Holiday Return Policy Eligible products':'This policy applies to returns of products purchased in Walmart U.S. stores';
 const end=retailer==='apple'?'How to Return an Item Ship your item back to Apple':'Seafood Policy';
 const i=text.indexOf(start),j=text.indexOf(end,i+start.length);
 if(i<0||j<=i)throw Error('reviewed policy section missing');
 return text.slice(i,j).trim();
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
interface Binding {name:string;url:string;days:number;sectionHash:string;conditions:string[];}
const BINDINGS:Record<'apple'|'walmart',Binding>={
 apple:{name:'Apple US',url:'https://www.apple.com/shop/help/returns_refund',days:14,sectionHash:'6c87193be8f19a133e54356d3f1b6252ffc029f73a636a9f34ad9413c98272ee',conditions:[
 'US standard policy: 14 calendar days from receipt, only for items bought directly from Apple; other retailers have their own policies.',
 'Return with included cords, adapters and documentation. Opened software, electronic software downloads, software upgrades, gift cards and developer products have exclusions.',
 'Holiday exception: eligible Apple Store Online products received November 6 through December 25, 2026 may be returned through January 8, 2027; carrier-financed iPhones on T-Mobile or Verizon and Verizon-financed iPads are excluded.',
 'Returning a device does not automatically cancel its wireless service or associated fees.'
 ]},
 walmart:{name:'Walmart US',url:'https://corporate.walmart.com/policies',days:90,sectionHash:'9e50b7d3bf70222cb6289a81f4b9fadeadd42107c7c01173f06ea47c9e4654bd',conditions:[
 'US standard policy: 90 days after purchase or receipt unless an exception applies; provide a receipt or order number. Marketplace seller rules can differ.',
 'Holiday exception: most purchases October 1 through December 31 are returnable until January 31; wireless phones, protection plans, major appliances, Dyson and some seasonal/luxury goods have exceptions.',
 'Shorter windows include 2 days for major appliances, 14 days for most wireless phones and Marketplace collectibles/luxury items, 30 days for consumer electronics and most Marketplace items, and 60 days for optical/hearing products.',
 'Perennials, shrubs and trees have a 365-day in-store window. Nonreturnable products and other conditions apply; consult the full official policy for the item.'
 ]}
};
export async function handleReturnPolicy(q:Record<string,string|undefined>):Promise<Record<string,unknown>>{
 const input=q.retailer?.trim().toLowerCase();if(!input)throw badRequest('MISSING_PARAM','retailer is required');
 const key=['apple','apple us','apple usa'].includes(input)?'apple':['walmart','walmart us','walmart usa'].includes(input)?'walmart':undefined;
 if(!key)throw unprocessable('UNSUPPORTED_RETAILER','only exact Apple US or Walmart US policy bindings are supported; no country or retailer substitution');
 // A pinned interpretation is not kept alive indefinitely. Changed pages and
 // expiry require a new review, never a cached or commonly remembered window.
 if(Date.now()>Date.parse('2026-12-01T23:59:59Z'))throw upstreamUnavailable('POLICY_REVIEW_EXPIRED','policy interpretation needs fresh review');
 if(!budget.take())throw upstreamUnavailable('POLICY_BUDGET','official policy request budget reached');
 const p=BINDINGS[key];let raw:string,fetchedAt:string;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{const b=await Promise.race([readPublicBody(p.url,700000,3500),new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('policy deadline')),3500);})]);raw=b.raw;fetchedAt=b.fetchedAt;if(hash(reviewedSection(key,raw))!==p.sectionHash)throw Error('policy changed');}
 catch{throw upstreamUnavailable('POLICY_UNVERIFIED','current reviewed official policy could not be confirmed; no remembered policy substituted');}finally{clearTimeout(timer);}
 const receipt=makeReceipt(INTENT,p.url,raw!,'single official policy page; exact raw bytes; reviewed section fingerprint');receipt.fetched_at=fetchedAt!;
 try{await saveReceipt(receipt,raw!);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 const scope='Standard US retailer policy only, not a decision about a particular item, purchase, order, refund or holiday deadline.';
 const answer=`${p.name}: standard return window ${p.days} days. ${p.conditions.join(' ')} ${scope}`;
 return envelope(INTENT,{retailer:p.name,return_window_days:p.days,window_basis:'standard US policy; exceptions in conditions',conditions:p.conditions,verified:true,sources:[p.url],scope,as_of:fetchedAt!},receipt,{answer,verdict:'verified',confidence:0.95,source:`${p.url}; live official page fetched ${fetchedAt!}`});
}
