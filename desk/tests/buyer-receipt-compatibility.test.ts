import {test,expect,vi} from 'vitest';
import {makeBuyerPlan} from '../src/buyerPolicy';import {followup} from '../src/buyerRuntime';import {decodeReceipt} from '../src/escrow';
const payer='0x'+'ab'.repeat(20),hash='0x'+'ab'.repeat(32);
for(const variant of ['canonical','numeric-amount','mixed-case-payer'])test('accepted paid receipt must remain usable for read-only followup: '+variant,async()=>{
 const p=makeBuyerPlan({cik:'320193',year:2025}),now=Math.floor(Date.now()/1000);
 const raw={receipt_hash:hash,rail:'escrow',payer:variant==='mixed-case-payer'?'0x'+'aB'.repeat(20):payer,miner:'999',amount_uusdc:variant==='numeric-amount'?10000:'10000',epoch_id:40,settlement:'epoch',chain:'telegraph',timestamp:now};
 const receipt=decodeReceipt(Buffer.from(JSON.stringify(raw)).toString('base64'),{payer,amountUusdc:'10000'});
 const result:any={plan_hash:p.plan_hash,plan_id:p.id,payer,charge:{status:'receipt'},receipt};
 const transport=vi.fn(async(url:any)=>String(url).includes('/deliveries/')?Response.json({epoch_id:40,deliveries_root:'0x'+'cd'.repeat(32),proof:['0x'+'ef'.repeat(32)],delivery:{receipt_hash:hash,payer,miner_id:'999',intent:'REGULATORY_FILING_MONITOR_GENERAL',usdc:10000}}):Response.json({epoch_id:40,body:{window_from:new Date((now-1)*1000).toISOString(),window_to:new Date((now+1)*1000).toISOString()}}));
 await expect(followup(p,result,new AbortController().signal,transport)).resolves.toMatchObject({verified:true});
});
