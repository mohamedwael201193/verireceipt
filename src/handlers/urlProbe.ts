import {guardPublicHttpUrl,measureHeaders} from './ssrfGuard';
const UA='VeriReceipt/2.0 URL header observer (+https://verireceipt.vercel.app)';
interface ProbeDeps {guard?:typeof guardPublicHttpUrl;measure?:typeof measureHeaders}
export async function probeUrlHeaders(raw:string,deps:ProbeDeps={}) {
 const guard=deps.guard??guardPublicHttpUrl,measure=deps.measure??measureHeaders;
 const deadline=Date.now()+4000;
 const hops:Array<{url:string;resolved_addresses:string[];status:number;latency_ms:number;tls_verified:boolean;location?:string;raw_headers:string[]}>=[];
 let next=raw,stop='complete';
 try{
  for(let i=0;i<3;i++){
   if(Date.now()>=deadline){stop='deadline';break;}
   const target=await guard(next,'url');
   const left=deadline-Date.now();if(left<=0){stop='deadline';break;}
   const result=await measure(target,Math.min(2000,left),UA);
   hops.push({url:target.url,resolved_addresses:target.addresses,...result});
   if([403,429].includes(result.status)){stop='source-refused';break;}
   if(![301,302,303,307,308].includes(result.status))break;
   if(!result.location){stop='redirect-without-location';break;}
   next=new URL(result.location,target.url).toString();
   if(i===2)stop='redirect-limit';
  }
 }catch(error){
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  stop=['PRIVATE_HOST','PORT_NOT_CHECKED','RATE_LIMITED','DNS_UNRESOLVABLE','BAD_URL','BAD_SCHEME','URL_TOO_LONG'].includes(code)?code:'probe-unavailable';
 }
 return {kind:'header-only public-target observation',hops,stop,complete:stop==='complete',scope:'Pinned public addresses and ordinary TLS certificate validation per hop; no page body downloaded, no JavaScript, no malware execution or safety clearance. Existing per-target one-minute probe pacing applies.'};
}
