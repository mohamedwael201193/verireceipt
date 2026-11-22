import type {Fetch} from './client.js';
import {ENGINE_URL,MINER_BASE_URL,NODE_URL} from './constants.js';
import {canonical,type BuyerPlan} from '../../src/buyer/contracts.js';
/** Fixed ranked route, bounded public evidence reads. No paid retries or arbitrary destinations. */
export function makeBuyerFetch(plan:BuyerPlan,payer:string,signal:AbortSignal,recordHeaders:(r:{status:number;receipt_header:string|null})=>Promise<void>,transport:Fetch=fetch,readOnly=false):Fetch {
 let calls=0,total=0,probe=false,paid=false,stopped=false,lastSec=0;
 return async(input,init)=>{
  signal.throwIfAborted();if(stopped)throw new Error('Hosted transport stopped');
  const raw=String(input),url=new URL(raw),method=(init?.method??'GET').toUpperCase(),headers=new Headers(init?.headers);
  if(url.href!==raw||url.username||url.password||url.search||url.hash||headers.has('Authorization')||headers.has('Cookie'))throw new Error('Hosted destination refused');
  const nodeGet=url.origin===NODE_URL&&method==='GET'&&(url.pathname===`/v1/ledger/account/${payer.toLowerCase()}`||/^\/engine\/v1\/signal\/0x[0-9a-f]{64}$/.test(url.pathname)||/^\/v1\/blocks\/[0-9]{1,10}(?:\/deliveries\/0x[0-9a-f]{64})?$/.test(url.pathname));
  const ask=!readOnly&&raw===`${ENGINE_URL}/v1/ask`&&method==='POST';
  const receipt=url.origin===MINER_BASE_URL&&method==='GET'&&/^\/receipts\/rcpt_[A-Z0-9]{26}(?:\/raw|\/pages\/(?:[0-9]|1[0-9])\/raw)?$/.test(url.pathname);
  const cik=plan.input.cik.padStart(10,'0');
  const sec=!readOnly&&url.origin==='https://data.sec.gov'&&method==='GET'&&new RegExp(`^/submissions/CIK${cik}(?:-submissions-[0-9]{3,})?\\.json$`).test(url.pathname);
  if((!nodeGet&&!ask&&!receipt&&!sec)||(!ask&&headers.has('X-PAYMENT'))||++calls>120)throw new Error('Hosted destination or request budget refused');
  if(ask){
   const expected={intent:'REGULATORY_FILING_MONITOR_GENERAL',params:plan.params,max_budget_usdc:10000};
   let body:unknown;try{body=JSON.parse(String(init?.body));}catch{throw new Error('Hosted request body refused');}
   if(canonical(body)!==canonical(expected))throw new Error('Hosted request binding refused');
   if(headers.has('X-PAYMENT')){if(paid||!probe)throw new Error('No hosted paid retries');paid=true;}
   else{if(probe)throw new Error('No hosted challenge retries');probe=true;}
  }
  // At most 5 SEC requests per second for this single hosted payer.
  if(sec){const wait=Math.max(0,lastSec+200-Date.now());if(wait)await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new Error('Aborted'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},wait);signal.addEventListener('abort',abort,{once:true});});signal.throwIfAborted();lastSec=Date.now();}
  const response=await transport(raw,{...init,redirect:'error',signal:init?.signal?AbortSignal.any([signal,init.signal]):signal});
  if(ask&&headers.has('X-PAYMENT')){try{await recordHeaders({status:response.status,receipt_header:response.headers.get('x-payment-response')});}catch(error){await response.body?.cancel();throw error;}}
  if(response.status===403||response.status===429){stopped=true;await response.body?.cancel();throw new Error('Hosted transport paused after source refusal');}
  if(!response.body)return response;
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;total+=value.length;if(size>(sec?8000000:2000000)||total>20000000)throw new Error('Hosted evidence bytes exceeded');chunks.push(value);}}
  finally{await reader.cancel();reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
}
