import {StartBudget} from '../core/publicSource';
import {CHAIN_RPCS} from '../config/chains';
import {SELECTOR_TOTAL_SUPPLY,SELECTOR_DECIMALS} from './tokenContracts';
export const SUPPLY_DISCOVERY_CHAINS=['ethereum','base','arbitrum','optimism','polygon','sepolia','base-sepolia'] as const;
type Probe={chain:string;rpc_url:string;status:'matched'|'no_erc20'|'unavailable';bodies:string[]};
// A single read-only endpoint per chain, two calls maximum, no retries or endpoint bypass.
let starts=new StartBudget(20,60000);
export function resetSupplyDiscoveryBudgetForTests():void{starts=new StartBudget(20,60000);}
const owners=new Map<string,Promise<Probe[]>>();
const unavailable=():Probe[]=>SUPPLY_DISCOVERY_CHAINS.map(chain=>({chain,rpc_url:CHAIN_RPCS[chain][0],status:'unavailable',bodies:[]}));
export function discoverSupplyChains(contract:string):Promise<Probe[]>{
 const key=contract.toLowerCase(),existing=owners.get(key);if(existing)return existing;
 // One discovery may own transports at a time, including after caller timeout.
 if(owners.size>=1||!starts.take())return Promise.resolve(unavailable());
 const result=discoverOwned(contract,()=>owners.delete(key));owners.set(key,result);return result;
}
async function discoverOwned(contract:string,drained:()=>void):Promise<Probe[]>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const probes:Probe[]=SUPPLY_DISCOVERY_CHAINS.map(chain=>({chain,rpc_url:CHAIN_RPCS[chain][0],status:'unavailable',bodies:[]}));
 const work=Promise.all(probes.map(async probe=>{try{
  for(const selector of [SELECTOR_TOTAL_SUPPLY,SELECTOR_DECIMALS]){
   if(controller.signal.aborted)return;
   if(selector===SELECTOR_DECIMALS){await new Promise(r=>setTimeout(r,150));if(controller.signal.aborted)return;}
   const response=await fetch(probe.rpc_url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:contract,data:selector},'finalized']}),signal:controller.signal});
   if(!response.ok){await response.body?.cancel().catch(()=>{});return;}if(!response.body)return;
   const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536){await reader.cancel().catch(()=>{});return;}chunks.push(part.value);}}finally{reader.releaseLock();}
   if(controller.signal.aborted)return;
   const raw=Buffer.concat(chunks).toString('utf8');probe.bodies.push(raw);const data=JSON.parse(raw);
   if(!data||data.jsonrpc!=='2.0'||data.id!==1)return;
   if(data.error!=null){if(data.error.code===3&&typeof data.error.message==='string'&&/execution reverted/i.test(data.error.message))probe.status='no_erc20';return;}
   if(data.result==='0x'){probe.status='no_erc20';return;}
   // ABI uint256 results must occupy exactly one word; empty/malformed is not zero.
   if(typeof data.result!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(data.result))return;
   if(selector===SELECTOR_DECIMALS){if(BigInt(data.result)>36n)return;probe.status='matched';}
  }
 }catch{/* Transport/malformed results remain unknown, never prove absence. */}})).finally(drained);
 try{await Promise.race([work,new Promise<void>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve();},4000);})]);}
 finally{clearTimeout(timer);controller.abort();}
 return probes.map(probe=>({...probe,bodies:[...probe.bodies]}));
}
