import {walletRpc} from './walletPinnedRpc';
import{rpcCall,HEX_QTY_RE}from'../core/evmRpc';
export async function walletContext(rpcs:readonly string[],address:string,fixedTag?:string):Promise<{transaction_count:number|null;is_contract:boolean|null;account_type:string;block_number:number|null;context_scope:string;context_evidence:unknown[]}>{
 const rows:{rpc:string;block:number;hash:string;nonce:number;code:string;raw:string[]}[]=[];
 for(const rpc of rpcs)try{
  const b=await (fixedTag?walletRpc:rpcCall)(rpc,'eth_getBlockByNumber',[fixedTag??'finalized',false]);const block=b.result as {number?:unknown;hash?:unknown};
  if(fixedTag&&block.number!==fixedTag)throw Error('wrong context block');
  if(typeof block.number!=='string'||!HEX_QTY_RE.test(block.number)||typeof block.hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(block.hash))throw new Error('bad block');
  const height=Number(BigInt(block.number));if(!Number.isSafeInteger(height))throw new Error('bad height');
  const n=await (fixedTag?walletRpc:rpcCall)(rpc,'eth_getTransactionCount',[address,block.number]);const c=await (fixedTag?walletRpc:rpcCall)(rpc,'eth_getCode',[address,block.number]);
  if(typeof n.result!=='string'||!HEX_QTY_RE.test(n.result)||typeof c.result!=='string'||!/^0x([0-9a-f]{2})*$/i.test(c.result)||c.result.length>200000)throw new Error('bad account context');
  const nonce=Number(BigInt(n.result));if(!Number.isSafeInteger(nonce))throw new Error('unsafe nonce');
  rows.push({rpc,block:height,hash:block.hash.toLowerCase(),nonce,code:c.result.toLowerCase(),raw:[b.rawText,n.rawText,c.rawText]});
 }catch{/* Optional enrichment cannot replace the independently agreed balance. */}
 const group=rows.map(r=>rows.filter(x=>x.hash===r.hash&&x.block===r.block&&x.nonce===r.nonce&&x.code===r.code)).sort((a,b)=>b.length-a.length)[0];
 if(!group||group.length<2)return{transaction_count:null,is_contract:null,account_type:'unknown',block_number:null,context_scope:'account context unavailable: no 2-source exact block/hash/nonce/code quorum; balance remains independently fixed-block agreed',context_evidence:rows};
 const win=group[0],contract=win.code!=='0x';return{transaction_count:win.nonce,is_contract:contract,account_type:win.code.startsWith('0xef0100')?'delegated_account':contract?'contract':'externally_owned_or_empty',block_number:win.block,context_scope:'account nonce and code at the disclosed fixed block when requested; independent block/hash/nonce/code quorum; nonce counts outgoing transactions only; code presence includes delegated accounts',context_evidence:group};
}
