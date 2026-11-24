import {upstreamUnavailable} from './errors';
export interface ReceiptRead {body:string;result:unknown}
export interface ReceiptQuorum {result:Record<string,unknown>|null;bodies:Record<string,string>;legs:number;policy:string}
const retryStarts=new Map<string,number[]>();
export function resetReceiptRetryForTests():void{retryStarts.clear();}
function admitRetry(url:string):boolean{const now=Date.now(),starts=(retryStarts.get(url)??[]).filter(t=>t>now-60000);if(starts.length>=30||starts.some(t=>t>now-1100))return false;retryStarts.set(url,[...starts,now]);return true;}
const POLICY='Receipt quorum: at least two distinct providers; null/found split re-read once after 1100ms; present receipts must agree on transaction/block identity, effective execution status and log count; Ethereum pre-Byzantium root-only and synthesized success agree only before block4370000 with matching gasUsed/cumulativeGasUsed; all explicit roots across attempts must agree; no present-content conflict accepted; null minority disclosed, not turned into absence.';
export interface ReceiptQuorumOptions { legacyRootBeforeBlock?: bigint }
function projection(result:unknown,hash:string,options:ReceiptQuorumOptions):{key:string;root:string|null} {
 if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('malformed receipt');
 const r=result as Record<string,unknown>;
 const hex=(v:unknown,n:number)=>{if(typeof v!=='string'||!new RegExp('^0x[0-9a-f]{'+n+'}$','i').test(v))throw new Error('invalid receipt identity');return v.toLowerCase();};
 if(hex(r.transactionHash,64)!==hash.toLowerCase())throw new Error('wrong receipt transaction');
 if(typeof r.blockNumber!=='string'||!/^0x[0-9a-f]+$/i.test(r.blockNumber))throw new Error('invalid receipt block');
 if(r.status!==undefined&&(typeof r.status!=='string'||!/^0x0*[01]$/i.test(r.status)))throw new Error('invalid receipt status');
 const root=r.root===undefined?null:hex(r.root,64);
 const blockNumber=BigInt(r.blockNumber);
 const legacy=options.legacyRootBeforeBlock!==undefined&&blockNumber<options.legacyRootBeforeBlock;
 if(r.status===undefined&&(!legacy||root===null))throw new Error('receipt execution status unavailable');
 const status=r.status===undefined?'1':BigInt(r.status as string).toString();
 const gas=(v:unknown)=>{if(typeof v!=='string'||!/^0x[0-9a-f]+$/i.test(v))throw new Error('invalid legacy receipt gas');return BigInt(v).toString();};
 if(!Array.isArray(r.logs))throw new Error('receipt logs unavailable');
 return {key:JSON.stringify({hash:hash.toLowerCase(),blockHash:hex(r.blockHash,64),blockNumber:blockNumber.toString(),status,logCount:r.logs.length,...(legacy?{gasUsed:gas(r.gasUsed),cumulativeGasUsed:gas(r.cumulativeGasUsed)}:{})}),root};
}
/** Receipt-only recovery. One provider cannot vote twice across attempts. */
export async function receiptQuorum(rpcs:string[],hash:string,read:(url:string)=>Promise<ReceiptRead>,options:ReceiptQuorumOptions={}):Promise<ReceiptQuorum>{
 const urls=[...new Set(rpcs)],bodies:Record<string,string>={};
 const disagreement=(message:string)=>Object.assign(upstreamUnavailable("RPC_QUORUM_DISAGREEMENT",message),{receiptEvidence:{...bodies}});
 let previousKey:string|undefined;
 const roots=new Set<string>();
 let eligible=urls;
 for(let round=0;round<2;round++){
  const settled=await Promise.all(eligible.map(async url=>{let timer:ReturnType<typeof setTimeout>;try{const value=await Promise.race([read(url),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("receipt read deadline")),4200);})]);return {status:"fulfilled" as const,value};}catch(reason){return {status:"rejected" as const,reason};}finally{clearTimeout(timer!);}}));
  const present:{key:string;result:Record<string,unknown>}[]=[],missing:string[]=[],answered:string[]=[];
  for(let i=0;i<settled.length;i++){
   const r=settled[i];if(r.status!=='fulfilled')continue;
   const url=eligible[i];bodies[`attempt${round+1}:${url}`]=r.value.body;
   if(r.value.result===null){missing.push(url);answered.push(url);continue;}
   let key:string;try{const projected=projection(r.value.result,hash,options);key=projected.key;if(projected.root!==null)roots.add(projected.root);}catch{throw disagreement('malformed or wrong-identity receipt; no guessed result');}
   present.push({key,result:r.value.result as Record<string,unknown>});answered.push(url);
  }
  const keys=new Set(present.map(p=>p.key));if(roots.size>1||keys.size>1||(previousKey&&present.some(p=>p.key!==previousKey)))throw disagreement('receipt providers conflict on scored content or block identity');
  if(present.length&&missing.length&&round===0){previousKey=present[0].key;eligible=answered;await new Promise(resolve=>setTimeout(resolve,1100));eligible=eligible.filter(admitRetry);continue;}
  if(present.length>=2)return {result:present[0].result,bodies,legs:answered.length,policy:POLICY};
  if(!present.length&&missing.length>=2&&!previousKey)return {result:null,bodies,legs:answered.length,policy:POLICY};
  if(present.length||previousKey)throw disagreement('receipt existence split remains without two matching present providers');
  throw upstreamUnavailable('RPC_QUORUM_UNREACHABLE','fewer than two usable receipt providers');
 }
 throw disagreement('receipt disagreement unresolved');
}
