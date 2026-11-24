import { unprocessable, upstreamUnavailable } from './errors';
import { admitRetry, type ReceiptRead } from './receiptQuorum';
const REQUIRED=['hash','blockHash','blockNumber','from','to','value','nonce','input'] as const;
const OPTIONAL=['r','s','v','yParity','type','gasPrice','gas','blockTimestamp','transactionIndex'] as const;
export function canonicalTransactionValue(value:unknown):string {
 const sort=(v:any):any=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
 return JSON.stringify(sort(value));
}
function parsed(value:unknown,hash:string):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('malformed transaction');
 const r=value as Record<string,unknown>;
 if(REQUIRED.some(k=>!Object.hasOwn(r,k)))throw new Error('missing transaction field');
 if(typeof r.hash!=='string'||r.hash.toLowerCase()!==hash.toLowerCase())throw new Error('wrong transaction');
 for(const k of ['from','to'] as const)if(!(k==='to'&&r[k]===null)&&(typeof r[k]!=='string'||!/^0x[0-9a-f]{40}$/i.test(r[k] as string)))throw new Error('bad address');
 if(!(r.blockHash===null||typeof r.blockHash==='string'&&/^0x[0-9a-f]{64}$/i.test(r.blockHash)))throw new Error('bad block hash');
 for(const k of ['blockNumber','value','nonce'] as const)if(!(k==='blockNumber'&&r[k]===null)&&(typeof r[k]!=='string'||!/^0x[0-9a-f]+$/i.test(r[k] as string)))throw new Error('bad quantity');
 if(typeof r.input!=='string'||!/^0x(?:[0-9a-f]{2})*$/i.test(r.input))throw new Error('bad calldata');
 return r;
}
function compatible(a:Record<string,unknown>,b:Record<string,unknown>):boolean {
 return REQUIRED.every(k=>canonicalTransactionValue(a[k])===canonicalTransactionValue(b[k]))&&OPTIONAL.every(k=>!Object.hasOwn(a,k)||!Object.hasOwn(b,k)||canonicalTransactionValue(a[k])===canonicalTransactionValue(b[k]));
}
/** Largest all-pairs-compatible set, with deterministic input-order tie break. */
export function selectCompatibleTransactions(present:Record<string,unknown>[]):Record<string,unknown>[] {
  let best:Record<string,unknown>[]=[];
  for(let mask=1;mask<2**present.length;mask++){
   const group=present.filter((_,i)=>mask&(2**i));
   if(group.every((a,i)=>group.slice(i+1).every(b=>compatible(a,b)))&&group.length>best.length)best=group;
  }
  return best;
}
/** Present votes are distinct providers in the final round, never accumulated retries. */
export async function transactionQuorum(rpcs:string[],hash:string,read:(url:string)=>Promise<ReceiptRead>):Promise<{result:Record<string,unknown>;bodies:Record<string,string>;legs:number}>{
 const urls=[...new Set(rpcs)],bodies:Record<string,string>={};let eligible=urls,sawFound=false;
 const fail=(code:string,message:string)=>Object.assign(upstreamUnavailable(code,message),{transactionEvidence:{...bodies}});
 for(let round=0;round<2;round++){
  const settled=await Promise.all(eligible.map(async url=>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([read(url),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('transaction read deadline')),4200);})]);}catch{return undefined;}finally{clearTimeout(timer!);}}));
  const present:Record<string,unknown>[]=[],answered:string[]=[];let missing=0;
  for(let i=0;i<settled.length;i++){
   const item=settled[i];if(!item)continue;bodies[`attempt${round+1}:${eligible[i]}`]=item.body;
   if(item.result===null){missing++;answered.push(eligible[i]);continue;}
   try{present.push(parsed(item.result,hash));answered.push(eligible[i]);}catch{throw fail('RPC_QUORUM_DISAGREEMENT','malformed or wrong-identity transaction; no value guessed');}
  }
  sawFound ||= present.length>0;
  if(present.length&&missing&&round===0){await new Promise(resolve=>setTimeout(resolve,1100));eligible=answered.filter(admitRetry);continue;}
  if(answered.length<2)throw fail('RPC_QUORUM_UNREACHABLE','fewer than two usable transaction providers');
  if(present.length===0&&!sawFound)throw unprocessable('TX_NOT_FOUND','no ethereum mainnet transaction with that hash (2-of-N quorum agreement); this slice covers ethereum mainnet only');
  // Pairwise compatibility prevents an optional-field-absent leg from bridging
  // two conflicting observations into a falsely unanimous group.
  const best=selectCompatibleTransactions(present);
  if(best.length<2)throw fail('RPC_QUORUM_DISAGREEMENT','transaction providers did not agree; no value guessed');
  return {result:best[0],bodies,legs:answered.length};
 }
 throw fail('RPC_QUORUM_DISAGREEMENT','transaction disagreement unresolved');
}
