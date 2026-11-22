// Server-only bundle. No live work occurs on import. Disabled until explicit startup configuration.
import {privateKeyToAccount} from 'viem/accounts';
import {mkdirSync,mkdtempSync,rmSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {normalizePrivateKey} from './secrets.js';
import {assertDedicatedBuyer,BUYER,canonical,validateBuyerPlan,type BuyerPlan} from '../../src/buyer/contracts.js';
import type {BuyerRuntime,BuyerExecutionOptions,BuyerExecutionResult} from '../../src/buyer/runtimeTypes.js';
import {hostedBuyerPolicy,makeBuyerPlan,BUYER_TASK} from './buyerPolicy.js';
import {runGate,spendLedgerFromFiles} from './gate.js';
import {readLedgerAccount,type Fetch,type Payer} from './client.js';
import {decodeReceipt} from './escrow.js';
import {checkDelivery,checkEpochConsistency,fetchEpochBlock,merkleProofShapeOk} from './verify.js';
import {makeBuyerFetch} from './buyerTransport.js';
function exclusions(name:string):string[]{const raw=process.env[name];if(!raw)throw new Error('Complete payer exclusion sets required');const list=JSON.parse(raw);if(!Array.isArray(list))throw new Error('Complete payer exclusion sets required');return list;}
function configuredPayer():Payer {
 if(!/[^\s@]+@[^\s@]+\.[^\s@]+/.test(process.env.SEC_USER_AGENT??''))throw new Error('SEC contact user-agent required before buying');
 const expected=assertDedicatedBuyer(process.env.BUYER_PAYER_ADDRESS??'',{cli:exclusions('BUYER_CLI_PAYER_EXCLUSIONS'),research:exclusions('BUYER_RESEARCH_PAYER_EXCLUSIONS')});
 if(process.env.BUYER_EXCLUSIONS_COMPLETE!=='yes'||process.env.BUYER_SINGLE_HOST_PERSISTENT!=='yes'||process.env.BUYER_NO_INDEPENDENT_PURCHASER!=='yes')throw new Error('Explicit complete exclusions and persistent single-host confirmation required');
 const secret=process.env.BUYER_PAYER_PRIVATE_KEY;if(!secret)throw new Error('Dedicated testnet payer not configured');
 const account=privateKeyToAccount(normalizePrivateKey(secret));if(account.address.toLowerCase()!==expected)throw new Error('Dedicated payer mismatch');
 return {address:expected,signMessage:message=>account.signMessage({message})};
}
export function cleanBuyerScratch(root:string,now=Date.now()):void {
 for(const name of readdirSync(root)){if(!/^job-[A-Za-z0-9_-]+$/.test(name))continue;const path=join(root,name),stat=lstatSync(path);if(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.mtimeMs<=now-BUYER.payloadHours*3600000)rmSync(path,{recursive:true,force:true});}
}
export function assertConfiguration():{payer:string;scratchRoot:string}{
 const payer=configuredPayer(),root=process.env.BUYER_SCRATCH_ROOT;
 if(!root||!isAbsolute(root)||root.startsWith('/tmp/'))throw new Error('Private persistent scratch root required');
 mkdirSync(root,{recursive:true,mode:0o700});const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||realpathSync(root)!==root)throw new Error('Scratch root must be canonical and private');
 cleanBuyerScratch(root);return {payer:payer.address,scratchRoot:root};
}
export const makePlan=makeBuyerPlan;
export async function execute(plan:BuyerPlan,options:BuyerExecutionOptions,injected?:{payer:Payer;transport:Fetch}):Promise<BuyerExecutionResult>{
 validateBuyerPlan(plan);const payer=injected?.payer??configuredPayer();
 const dir=mkdtempSync(join(options.scratchRoot,'job-'));let allowed=false,signed=false,publicReceipt:Record<string,unknown>|null=null;
 const f=makeBuyerFetch(plan,payer.address,options.signal,options.recordHeaders,injected?.transport??fetch);
 try{
  const balance=await readLedgerAccount(payer.address,f);if(!/^\d+$/.test(balance.available)||BigInt(balance.available)<1010000n)throw new Error('Dedicated testnet payer reserve reached');
  const record=await runGate(BUYER_TASK,{address:payer.address,signMessage:async message=>{options.signal.throwIfAborted();if(!allowed||signed)throw new Error('Hosted signer not authorized or reused');signed=true;return payer.signMessage(message);}}, {
   policy:hostedBuyerPolicy(),policyHash:plan.policy_hash,overrides:plan.params,ledgerFile:join(dir,'gate.jsonl'),
   spend:spendLedgerFromFiles({reservationsFile:join(dir,'reservation.jsonl'),lockFile:join(dir,'lock'),runLedgerFiles:[]}),f,
   durableBeforeSign:async notice=>{options.signal.throwIfAborted();await options.beforeSign({plan_hash:plan.plan_hash,payer:notice.authorization.from,amount_uusdc:notice.amountUusdc.toString(),nonce:notice.authorization.nonce,valid_before:Number(notice.authorization.validBefore)});options.signal.throwIfAborted();allowed=true;},
   onRawResponse:async raw=>{
    // Deliberately never persist authorization, signedMessage, signature or request headers.
    const header=raw.headers['x-payment-response']??null;
    await options.recordBody({status:raw.status,receipt_header:header,body_text:raw.bodyText});
    try{publicReceipt=decodeReceipt(header,{payer:payer.address,amountUusdc:BUYER.callUusdc}) as unknown as Record<string,unknown>;}catch{/* Invalid receipt remains an uncertain charge, never zero. */}
   },
  });
  if(record.policy_hash!==plan.policy_hash||record.task_hash!==plan.task_hash||canonical(record.rule)!==canonical(plan.rule)||canonical(record.params)!==canonical(plan.params)||record.payer!==payer.address.toLowerCase())throw new Error('Gate result binding failed');
  if(record.outcome==='PASS'&&(record.source_verification?.status!=='verified'||!record.node_checks.length||record.node_checks.some(c=>!c.ok)||record.miner_checks.some(c=>!c.ok)||!record.record_appended))throw new Error('Gate PASS lacks verified evidence');
  return {version:'hosted-ranked-filing-result-v1',plan_id:plan.id,plan_hash:plan.plan_hash,policy_hash:plan.policy_hash,task_hash:plan.task_hash,payer:payer.address.toLowerCase(),charge:{status:!signed?'not_signed':publicReceipt?'receipt':'uncertain',amount_uusdc:publicReceipt?BUYER.callUusdc:null,maximum_uusdc:BUYER.callUusdc},record:record as unknown as Record<string,unknown>,receipt:publicReceipt,limits:['Operator-sponsored related-party Sepolia testnet ranked purchase. Not independent adoption or revenue.','PASS is advisory evidence for exact filing coverage only, not investment advice.','Receipt amount is a node-reported charge, not proof of final settlement.','Merkle proof shape only, not a proof walk. Delivery follow-up never purchases again.']};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
export async function followup(plan:BuyerPlan,result:BuyerExecutionResult,signal:AbortSignal,transport:Fetch=fetch):Promise<unknown>{
 validateBuyerPlan(plan,new Date(),true);if(result.plan_hash!==plan.plan_hash||result.plan_id!==plan.id||result.charge.status!=='receipt'||!result.receipt)throw new Error('No bound payment receipt');
 const r=result.receipt;if(!/^0x[0-9a-f]{64}$/.test(String(r.receipt_hash))||!Number.isSafeInteger(r.epoch_id)||!Number.isFinite(r.timestamp)||r.payer!==result.payer||r.amount_uusdc!==BUYER.callUusdc)throw new Error('Invalid stored receipt');
 const f=makeBuyerFetch(plan,result.payer,signal,async()=>{throw new Error('Read-only follow-up');},transport,true);
 const d=await checkDelivery(Number(r.epoch_id),String(r.receipt_hash),f),epoch=await checkEpochConsistency({claimedEpoch:Number(r.epoch_id),receiptTimeMs:Number(r.timestamp)*1000},f);
 const prev=d.status==='pending'&&Number(r.epoch_id)>0?await fetchEpochBlock(Number(r.epoch_id)-1,f):null;
 const identity=d.status==='included'&&d.epochId===r.epoch_id&&d.delivery?.receipt_hash===r.receipt_hash&&String(d.delivery?.payer).toLowerCase()===result.payer&&String(d.delivery?.miner_id)===String(r.miner)&&String(d.delivery?.intent)==='REGULATORY_FILING_MONITOR_GENERAL'&&Number(d.delivery?.usdc)===10000;
 const pending=d.status==='pending'&&prev?.status==='recorded'&&prev.epoch_id===Number(r.epoch_id)-1&&prev.windowFromMs!==undefined&&prev.windowToMs!==undefined&&prev.windowFromMs<prev.windowToMs&&prev.windowToMs<=Number(r.timestamp)*1000;
 const ok=epoch.ok&&(identity&&merkleProofShapeOk(d)||pending);
 return {observed_at:new Date().toISOString(),status:ok?d.status:'error',verified:!!ok,delivery:d,epoch,paid_retry:false,settlement_finality:false,proof_walked:false};
}
export const runtime:BuyerRuntime={cleanup:cleanBuyerScratch,assertConfiguration,makePlan,execute,followup};
