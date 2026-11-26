import expandedBindings from '../data/returnPolicyBindings.json';
// Live official US policy observer. Closed retailer bindings only. A reviewed
// policy section must match exactly, otherwise no stale policy is substituted.
import {createHash} from 'node:crypto';
import {badRequest,upstreamUnavailable} from '../core/errors';
import {readPublicBody,StartBudget} from '../core/publicSource';
import {envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';
const INTENT='RETURN_POLICY_VERIFY_GENERAL';
let budget=new StartBudget(20,60000);
export function resetReturnPolicyBudgetForTests():void{budget=new StartBudget(20,60000);}
export function policyText(html:string):string{
 return html.replace(/<!--[^]*?-->/g,' ').replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&#(\d+);/g,(_,n)=>{const v=Number(n);return v<=0x10ffff?String.fromCodePoint(v):' ';}).replace(/&#x([0-9a-f]+);/gi,(_,n)=>{const v=parseInt(n,16);return v<=0x10ffff?String.fromCodePoint(v):' ';}).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
}
type Retailer=string;
const SECTIONS={"costco": ["Risk-Free 100% Satisfaction Guarantee", "How to Return an Item"], "ikea": ["IKEA offers a 365-day return policy", "In-store purchase"], "target": ["Return windows that give you plenty of time to decide", "Free returns, no matter how you do it"]};
export function reviewedSection(retailer:Retailer,html:string):string{
 const text=policyText(html);
 const expanded=expandedBindings.find(p=>p.key===retailer);
 const start=expanded?expanded.start:retailer in SECTIONS?SECTIONS[retailer as keyof typeof SECTIONS][0]:retailer==='apple'?'Holiday Return Policy Eligible products':'This policy applies to returns of products purchased in Walmart U.S. stores';
 const end=expanded?expanded.end:retailer in SECTIONS?SECTIONS[retailer as keyof typeof SECTIONS][1]:retailer==='apple'?'How to Return an Item Ship your item back to Apple':'Seafood Policy';
 const i=text.indexOf(start),j=text.indexOf(end,i+start.length);
 if(i<0||j<=i)throw Error('reviewed policy section missing');
 return text.slice(i,j).trim();
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
interface Binding {name:string;url:string;days:number|null;sectionHash:string;conditions:string[];quotes?:string[];window_basis?:string;start?:string;end?:string;accept?:string;}
const BINDINGS:Record<Retailer,Binding>={
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
 ]},
 costco:{"name": "Costco US", "url": "https://customerservice.costco.com/app/answers/detail/a_id/1191/", "days": null, "sectionHash": "3b56f54ae65c32e00b1bac63697f06bfd2e9348d3e1e63037041a2990d867e9b", "conditions": ["No single general merchandise day limit is stated in this guarantee; do not treat the electronics exception as the general window.", "Electronics and listed recreational carts have a 90-day window from receipt. Diamond paperwork, carrier contracts, limited-life warranties and other category conditions apply. Precious metals, Shop Cards, gift cards, tickets, airline/live event items and custom products have nonrefundable exceptions. Consult the official policy for the item."]},
 ikea:{"name": "IKEA US", "url": "https://www.ikea.com/us/en/customer-service/returns-claims/return-policy/", "days": 365, "sectionHash": "2e4523dd7937ca773a2fe63031c9e99f8b1535e8d3e89bb15df9d159fe9180e3", "conditions": ["365 days applies to unopened products. Open products have a 180-day window with proof of purchase. This summary is not a decision about item condition or eligibility; consult the full linked policy."]},
 target:{"name": "Target US", "url": "https://www.target.com/returns", "days": 90, "sectionHash": "2d2b0f7ae4838ba10d1f07a707b133b6267e170024deffded2023b4e1fb90b3c", "conditions": ["90 days applies to most items sold by Target. Target-brand items with a receipt have a 365-day window. Other products and sellers can have shorter windows.", "Electronics and limited-time collections have separate policies; consult the product page. Gift cards, trading cards, digital downloads and open breast pumps are among final-sale items. Membership or card extensions depend on eligibility. Holiday eligibility is not calculated."]}
};
for(const p of expandedBindings)BINDINGS[p.key]=p;
// Candidates returning blocks, redirects or JS-only bodies are not runtime bindings.
const COVERAGE_PAGES:Record<string,[string,string]>={};
export async function handleReturnPolicy(q:Record<string,string|undefined>):Promise<Record<string,unknown>>{
 const supplied=[q.retailer,q.store,q.merchant,q.brand].filter(v=>v?.trim()).map(v=>v!.trim().toLowerCase());
 if(!supplied.length)throw badRequest('MISSING_PARAM','retailer, store, merchant or brand is required');
 if(supplied.some(v=>v!==supplied[0]))throw badRequest('CONFLICTING_RETAILER','retailer aliases disagree');
 const input=supplied[0].replace(/^lowes(?= us| usa|$)/,"lowe's").replace(/^macys(?= us| usa|$)/,"macy's").replace(/^the home depot(?= us| usa|$)/,"home depot").replace(/^l\.?l\.?\s?bean(?= us| usa|$)/,'llbean');if(input.length>256||/[\x00-\x1f]/.test(input))throw badRequest('INVALID_RETAILER','retailer must be at most256printablecharacters');
 const key=(Object.keys(BINDINGS) as Retailer[]).find(k=>[k,k+' us',k+' usa'].includes(input));
 if(!key){
   const page=Object.entries(COVERAGE_PAGES).find(([k])=>[k,k+' us',k+' usa'].includes(input))?.[1];
   let raw:string|undefined,fetchedAt:string|undefined;
   if(page){
     if(!budget.take())throw upstreamUnavailable('POLICY_BUDGET','official policy request budget reached');
     let timer:ReturnType<typeof setTimeout>|undefined;
     try{const b=await Promise.race([readPublicBody(page[1],1500000,3500),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('policy deadline')),3500);})]);raw=b.raw;fetchedAt=b.fetchedAt;}catch{}finally{clearTimeout(timer);}
   }
   const checked=raw!==undefined;
   // Local status evidence, never invent a policy body when an attempted read fails.
   const evidence=JSON.stringify({kind:'policy_coverage_only',requested_retailer:input,attempted_official_url:page?.[1]??null,read_status:checked?'body_retrieved_unreviewed':page?'source_unavailable':'no_reviewed_binding',raw_body:raw??null,fetched_at:fetchedAt??null});
   const receipt=makeReceipt(INTENT,page?.[1]??'urn:verireceipt:local-policy-coverage',evidence,'coverage/status statement only; no policy interpretation verified');
   if(fetchedAt)receipt.fetched_at=fetchedAt;
   try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','coverage evidence could not be stored');}
   return envelope(INTENT,{retailer:page?.[0]??input,return_window_days:null,conditions:[checked?'Official page body retrieved but no reviewed policy interpretation; no return window asserted.':page?'Official page read failed; no policy body or return window asserted.':'No reviewed exact US retailer binding; no external merchant policy page was fetched.'],verified:false,sources:checked?[page![1]]:[],attempted_sources:page?[page[1]]:[],data_status:checked?'unreviewed_policy':page?'source_unavailable':'coverage_only',supported_retailers:Object.values(BINDINGS).map(b=>b.name)},receipt,{answer:checked?'Official page body retrieved but no policy interpretation verified. No return window or eligibility is asserted.':page?'Official policy page could not be retrieved. No policy body, return window or eligibility is asserted.':'No reviewed exact US retailer binding. No merchant policy page was fetched and no return window or eligibility is asserted.',verdict:'no_data',confidence:0,source:checked?`Uninterpreted official page body: ${page![1]}`:'Local coverage/read-status evidence only, not a retrieved retailer policy'});
 }
 // A pinned interpretation is not kept alive indefinitely. Changed pages and
 // expiry require a new review, never a cached or commonly remembered window.
 if(Date.now()>Date.parse('2026-12-01T23:59:59Z'))throw upstreamUnavailable('POLICY_REVIEW_EXPIRED','policy interpretation needs fresh review');
 if(!budget.take())throw upstreamUnavailable('POLICY_BUDGET','official policy request budget reached');
 const p=BINDINGS[key];let raw:string,fetchedAt:string;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{const b=await Promise.race([readPublicBody(p.url,1500000,3500,undefined,p.accept),new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('policy deadline')),3500);})]);raw=b.raw;fetchedAt=b.fetchedAt;if(hash(reviewedSection(key,raw))!==p.sectionHash)throw Error('policy changed');}
 catch{throw upstreamUnavailable('POLICY_UNVERIFIED','current reviewed official policy could not be confirmed; no remembered policy substituted');}finally{clearTimeout(timer);}
 const receipt=makeReceipt(INTENT,p.url,raw!,'single official policy page; exact raw bytes; reviewed section fingerprint');receipt.fetched_at=fetchedAt!;
 try{await saveReceipt(receipt,raw!);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 const scope='Standard US retailer policy only, not a decision about a particular item, purchase, order, refund or holiday deadline.';
 const quotes=p.quotes??[];const excerpt=quotes.length?` Official policy quotes: ${quotes.map(q=>'\"'+q+'\"').join(' ')}`:'';
 const answer=`${p.name}: ${p.days===null?(key==='llbean'?'return window is one year from purchase; no fixed day conversion asserted':'no single general return day window asserted in the reviewed policy'):`standard return window ${p.days} days`}. ${p.conditions.join(' ')}${excerpt} ${scope}`;
 return envelope(INTENT,{retailer:p.name,return_window_days:p.days,window_basis:p.window_basis??'standard US policy; exceptions in conditions',conditions:p.conditions,...(quotes.length?{policy_quotes:quotes,policy_section_quote:reviewedSection(key,raw!)}:{}),verified:true,sources:[p.url],scope,as_of:fetchedAt!},receipt,{answer,verdict:'verified',confidence:0.95,source:`${p.url}; live official page fetched ${fetchedAt!}`});
}
