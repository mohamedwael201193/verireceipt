import{HEX_QTY_RE}from'../core/evmRpc';
const activeHeads=new Set<string>();
export function resetHeadContextForTests(){activeHeads.clear();}
export async function confirmationContext(rpcs:readonly string[],txBlock:number):Promise<{confirmations:number|null;confirmation_evidence:unknown[];confirmation_scope:string}>{
 const head=async(url:string)=>{
  if(activeHeads.has(url)||activeHeads.size>=16)throw Error('optional head capacity unavailable');
  activeHeads.add(url);const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const io=(async()=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]}),signal:controller.signal});if(!response.ok)throw Error('head unavailable');const reader=response.body?.getReader();if(!reader)throw Error('head body missing');const chunks:Uint8Array[]=[];let bytes=0;try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>10000){void reader.cancel().catch(()=>{});throw Error('oversized head');}chunks.push(part.value);}}finally{reader.releaseLock();}const rawText=Buffer.concat(chunks).toString('utf8');const j=JSON.parse(rawText);if(j.error||j.jsonrpc!=='2.0'||j.id!==1)throw Error('bad envelope');return{result:j.result,rawText};})().finally(()=>activeHeads.delete(url));
  try{return await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('optional head deadline'));},700);})]);}finally{clearTimeout(timer!);}
 };
 const votes:{url:string;height:number;raw:string}[]=[];
 for(const url of rpcs)try{const r=await head(url);if(typeof r.result!=='string'||!HEX_QTY_RE.test(r.result))throw new Error('bad height');const height=Number(BigInt(r.result));if(!Number.isSafeInteger(height)||height<txBlock)throw new Error('bad height');votes.push({url,height,raw:r.rawText})}catch{/* optional context, never a replacement transaction vote */}
 const group=votes.map(r=>votes.filter(v=>v.height===r.height)).sort((a,b)=>b.length-a.length)[0];
 return{confirmations:group?.length>=2?group[0].height-txBlock:null,confirmation_evidence:votes,confirmation_scope:'confirmations counts blocks after inclusion (agreed latest height minus transaction block); optional exact2-source head-height quorum, not a finality guarantee'};
}
export function transactionFlags(tx:unknown):{contract_call:boolean|null;self_transfer:boolean|null;call_scope:string}{
 const t=tx as Record<string,unknown>|null;const from=typeof t?.from==='string'?t.from.toLowerCase():null,to=typeof t?.to==='string'?t.to.toLowerCase():null,input=typeof t?.input==='string'&&/^0x([0-9a-f]{2})*$/i.test(t.input)?t.input:null;
 return{contract_call:t===null?null:to!==null&&input!==null&&input!=='0x',self_transfer:from!==null&&to!==null?from===to:null,call_scope:'contract_call means nonempty calldata to a destination, not proof of deployed code; self_transfer compares source and destination addresses'};
}
