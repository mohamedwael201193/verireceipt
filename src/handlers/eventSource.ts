import {readPublicBody, type PublicBody} from '../core/publicSource';
import {upstreamUnavailable} from '../core/errors';
const UA='VeriReceipt/2.0 event-resolution observer (+https://verireceipt.vercel.app)';
const active=new Map<string,Promise<PublicBody>>();
/** One URL owns fetch and body until settlement, even if its caller times out. */
export async function eventBody(url:string,deadlineAt:number):Promise<PublicBody>{
 const remaining=Math.min(650,deadlineAt-Date.now());
 if(remaining<=0)throw upstreamUnavailable('EVENT_SOURCE_TIMEOUT','event source budget exceeded');
 let io=active.get(url);
 if(!io){
  if(active.size>=32)throw upstreamUnavailable('EVENT_SOURCE_CAPACITY','event source capacity reached');
  io=readPublicBody(url,500000,remaining,UA);active.set(url,io);
  const owned=io,release=()=>{if(active.get(url)===owned)active.delete(url);};void io.then(release,release);
 }
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(upstreamUnavailable('EVENT_SOURCE_TIMEOUT','event source budget exceeded')),remaining);})]);}
 finally{clearTimeout(timer);}
}
