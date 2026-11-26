import{StartBudget}from'../core/publicSource';
let budget=new StartBudget(120,60000);
export function resetWalletBudgetForTests(){budget=new StartBudget(120,60000);}
type RpcResult={result:unknown;rawText:string};
const owners=new Map<string,{url:string;result:Promise<RpcResult>}>();
// Per-request singleflight and bounded per-endpoint transport ownership outlives caller deadlines and cancellation.
export async function walletRpc(url:string,method:string,params:unknown[]):Promise<{result:unknown;rawText:string}>{
 const key=JSON.stringify([url,method,params]),prior=owners.get(key);if(prior)return prior.result;
 if(owners.size>=12||[...owners.values()].filter(v=>v.url===url).length>=3||!budget.take())throw Error('wallet RPC capacity');const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const io=(async()=>{const r=await fetch(url,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(!r.ok){await r.body?.cancel().catch(()=>{});throw Error('wallet RPC HTTP');}if(!r.body)throw Error('wallet RPC body');const reader=r.body.getReader(),parts:Uint8Array[]=[];let bytes=0;try{while(true){const p=await reader.read();if(p.done)break;bytes+=p.value.byteLength;if(bytes>65536){await reader.cancel().catch(()=>{});throw Error('wallet RPC size');}parts.push(p.value);}}finally{reader.releaseLock();}if(controller.signal.aborted)throw Error('wallet RPC deadline');const rawText=Buffer.concat(parts).toString('utf8'),d=JSON.parse(rawText);if(d?.jsonrpc!=='2.0'||d.id!==1||d.error!=null||!Object.hasOwn(d,'result'))throw Error('wallet RPC envelope');return{result:d.result,rawText};})();
 const result=Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('wallet RPC caller deadline'));},4000);})]).finally(()=>{clearTimeout(timer);controller.abort();});
 const entry={url,result};owners.set(key,entry);const release=()=>{if(owners.get(key)===entry)owners.delete(key);};void io.then(release,release);
 return result;
}
export async function pinWalletBlock(rpcs:string[]){
 const heads=await Promise.all(rpcs.map(async url=>{try{const r=await walletRpc(url,'eth_getBlockByNumber',['finalized',false]);const b=r.result as any;if(!b||typeof b.number!=='string'||!/^0x[0-9a-fA-F]+$/.test(b.number)||BigInt(b.number)>1000000000000n)return null;return{url,number:BigInt(b.number),raw:r.rawText};}catch{return null;}}));const good=heads.filter((h):h is NonNullable<typeof h>=>!!h);if(good.length<2)throw Error('finalized heads unavailable');const low=good.reduce((a,b)=>a.number<b.number?a:b).number;if(low<5n)throw Error('finalized head too low');return{number:low-3n,heads:good.map(h=>({...h,number:h.number.toString()})),scope:'fixed block3below lowest of at least2observed finalized heads; retry once2blocks earlier if no balance quorum'};
}
