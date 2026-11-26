import {StartBudget} from '../core/publicSource';
const MAX=100000000000000n;const HEX=/^0x[0-9a-fA-F]+$/;let owner:Promise<unknown>|undefined;let starts=new StartBudget(20,60000);
export function resetGasContextBudgetForTests(){starts=new StartBudget(20,60000);}
async function read(url:string,method:string,params:unknown[],signal:AbortSignal){
 const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal});
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error('context HTTP');}if(!response.body)throw Error('context body');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536){await reader.cancel().catch(()=>{});throw Error('context size');}chunks.push(part.value);}}finally{reader.releaseLock();}
 if(signal.aborted)throw Error('context deadline');const raw=Buffer.concat(chunks).toString('utf8'),d=JSON.parse(raw);if(d?.jsonrpc!=='2.0'||d.id!==1||d.error!=null||!Object.hasOwn(d,'result'))throw Error('context envelope');return{result:d.result,raw};
}
export async function feeContext(rpcs:string[]):Promise<{fields:Record<string,unknown>;evidence:unknown}|null>{
 if(owner||!starts.take())return null;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const io=(async()=>{try{
  const head=await read(rpcs[0],'eth_blockNumber',[],abort.signal);if(typeof head.result!=='string'||!HEX.test(head.result))return null;const height=BigInt(head.result);if(height<2n||height>1000000000002n)return null;const fixed=height-2n,tag='0x'+fixed.toString(16);
  const legs=await Promise.all(rpcs.map(async url=>{try{
   const block=await read(url,'eth_getBlockByNumber',[tag,false],abort.signal),b=block.result;
   if(!b||typeof b.number!=='string'||!HEX.test(b.number)||BigInt(b.number)!==fixed||typeof b.hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(b.hash)||typeof b.baseFeePerGas!=='string'||!HEX.test(b.baseFeePerGas))return null;
   const base=BigInt(b.baseFeePerGas);if(base>MAX)return null;
   let tip:Awaited<ReturnType<typeof read>>|undefined;let priority:bigint|undefined;
   try{tip=await read(url,'eth_maxPriorityFeePerGas',[],abort.signal);if(typeof tip.result==='string'&&HEX.test(tip.result)&&BigInt(tip.result)<=MAX)priority=BigInt(tip.result);}catch{}
   return{url,key:b.hash.toLowerCase()+':'+base,hash:b.hash.toLowerCase(),base,priority,raw:{block:block.raw,priority:tip?.raw??null}};
  }catch{return null;}}));
  const good=legs.filter((l):l is NonNullable<typeof l>=>l!==null),winner=good.find(l=>good.filter(x=>x.key===l.key).length>=2);if(!winner)return null;
  const agreeing=good.filter(l=>l.key===winner.key),tipWinner=agreeing.find(l=>l.priority!==undefined&&agreeing.filter(x=>x.priority===l.priority).length>=2);
  return{fields:{base_fee_gwei:Number(winner.base)/1e9,priority_fee_gwei:tipWinner?Number(tipWinner.priority)/1e9:null,block_number:Number(fixed),block_hash:winner.hash,fee_context_quorum:`${agreeing.length}/${rpcs.length} sources agreed`,priority_fee_reason:tipWinner?'two sources agree on contemporaneous suggestion':'no two block-agreeing sources agree on priority suggestion; not estimated',fee_context_scope:'base fee at one fixed block2below observed head; priority fee is the contemporaneous node suggestion, not a block-bound or future fee quote'},evidence:{head:{url:rpcs[0],raw:head.raw},fixed_block:tag,legs:agreeing.map(l=>({url:l.url,...l.raw}))}};
 }catch{return null;}})();owner=io;void io.finally(()=>{if(owner===io)owner=undefined;});
 try{return await Promise.race([io,new Promise<null>(resolve=>{timer=setTimeout(()=>{abort.abort();resolve(null);},1200);})]);}finally{clearTimeout(timer);abort.abort();}
}
