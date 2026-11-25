// One public Yahoo workflow. No host rotation, retries, redirect or block bypass.
let busy=false,draining=false,nextStart=0;
const waiters:(()=>void)[]=[];
export function resetYahooTransportForTests(){busy=false;draining=false;nextStart=0;waiters.length=0;}
const unavailable=()=>Object.assign(Error('Yahoo public acquisition unavailable; no new request made'),{status:503,localCapacity:true});
async function acquire(deadline:number){
 if(draining)throw unavailable();
 if(!busy){busy=true;return;}
 if(waiters.length>=16)throw unavailable();
 await new Promise<void>((resolve,reject)=>{const ready=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{const i=waiters.indexOf(ready);if(i>=0)waiters.splice(i,1);reject(unavailable());},Math.max(0,deadline-Date.now()));waiters.push(ready);});
}
function release(){const next=waiters.shift();if(next)next();else busy=false;}
export async function fetchYahooBody(url:string,allowed:()=>void,rateLimited:(retry:string|null)=>void):Promise<string>{
 const u=new URL(url);if(u.origin!=='https://query1.finance.yahoo.com'||!['/v8/finance/chart/','/v1/finance/search','/ws/fundamentals-timeseries/v1/finance/timeseries/'].some(p=>u.pathname.startsWith(p)))throw Error('unsupported Yahoo acquisition URL');
 allowed();const deadline=Date.now()+12000;await acquire(deadline);let releaseHere=true;
 try{
  allowed();const wait=Math.min(Math.max(0,nextStart-Date.now()),Math.max(0,deadline-Date.now()));if(wait)await new Promise(r=>setTimeout(r,wait));
  allowed();const remaining=deadline-Date.now();if(remaining<=0)throw unavailable();
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>,settled=false,timedOut=false;
  nextStart=Date.now()+1000;
  const io=(async()=>{const res=await fetch(url,{signal:controller.signal,redirect:'error',headers:{'User-Agent':'VeriReceipt/2.0 equity observer (+https://verireceipt.vercel.app)',Accept:'application/json'}});
   if(res.status===429)rateLimited(res.headers.get('retry-after'));
   if(!res.ok){void res.body?.cancel().catch(()=>{});throw Object.assign(Error('Yahoo HTTP '+res.status),{status:res.status});}
   const reader=res.body?.getReader();if(!reader)throw Error('Yahoo body missing');let bytes=0;const parts:Uint8Array[]=[];
   try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1000000){void reader.cancel().catch(()=>{});throw Error('Yahoo body exceeds limit');}parts.push(part.value);}}finally{reader.releaseLock();}
   return Buffer.concat(parts).toString('utf8');
  })().finally(()=>{settled=true;});
  try{
   const body=await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Object.assign(Error('Yahoo source deadline exceeded'),{timeout:true}));},Math.min(5000,remaining));})]);
   if(timedOut||Date.now()>=deadline)throw Object.assign(Error('Yahoo source deadline exceeded'),{timeout:true});return body;
  }catch(err){if(!settled){draining=true;releaseHere=false;void io.then(()=>{draining=false;release();},()=>{draining=false;release();});}throw err;}
  finally{clearTimeout(timer!);}
 }finally{if(releaseHere)release();}
}
