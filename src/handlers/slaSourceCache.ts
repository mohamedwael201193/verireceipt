import {PublicBodyCache,readPublicBody,PublicBody} from '../core/publicSource';
import {upstreamUnavailable} from '../core/errors';
let cache=new PublicBodyCache(128,5*60_000,()=>Date.now());
const nextStart=new Map<string,number>();
export function resetSlaSourceCacheForTests(){cache=new PublicBodyCache(128,5*60_000,()=>Date.now());nextStart.clear();}
export async function readSlaBody(url:string,host:string,ua:string,timeoutMs:number):Promise<PublicBody>{
 const result=await cache.get(url,async()=>{
  const now=Date.now(),start=Math.max(now,nextStart.get(host)??0),wait=start-now;
  if(wait>5000)throw upstreamUnavailable('STATUSPAGE_CAPACITY','statuspage start queue full; no request made');
  if(nextStart.size>=128&&!nextStart.has(host)){for(const[h,t]of nextStart)if(t<=now)nextStart.delete(h);if(nextStart.size>=128)throw upstreamUnavailable('STATUSPAGE_CAPACITY','host pacing capacity reached');}
  nextStart.set(host,start+1000);
  if(wait)await new Promise(r=>setTimeout(r,wait));
  // Use the handler identity, a bounded body and a timeout covering body reads.
  return readPublicBody(url,1_000_000,timeoutMs,ua);
 });
 return result;
}
