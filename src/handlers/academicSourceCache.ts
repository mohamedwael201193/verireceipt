// Crossref public list pool: one active workflow, >=1second between starts.
// No personal mailto, bounded FIFO queue, no retry on429/4xx/invalid200.
const cache=new Map<string,{body:string;fetchedAt:string}>(),pending=new Map<string,Promise<AcademicObservation>>();
let busy=false,nextStart=0,blockedUntil=0,draining=false;
export interface AcademicObservation {body:string;fetchedAt:string;staleReason?:string}
const waiters: (()=>void)[]=[];
export function resetAcademicCacheForTests():void{waiters.length=0;cache.clear();pending.clear();busy=false;nextStart=0;blockedUntil=0;draining=false;}
export const normalizeAcademicQuery=(q:string)=>q.trim().replace(/\s+/g,' ').toLowerCase();
const failure=(message:string,status?:number,timeout=false)=>Object.assign(new Error(message),{status,timeout});
async function acquireSlot(deadline:number):Promise<void>{
 if(draining)throw failure('Crossref source still draining after timeout; no request made',503);
 if(!busy){busy=true;return;}
 if(waiters.length>=32)throw failure('Crossref bounded queue full; no request made',503);
 await new Promise<void>((resolve,reject)=>{
  const ready=()=>{clearTimeout(timer);resolve();};
  const timer=setTimeout(()=>{const i=waiters.indexOf(ready);if(i>=0)waiters.splice(i,1);reject(failure('Crossref queue budget exhausted',undefined,true));},Math.max(0,deadline-Date.now()));
  waiters.push(ready);
 });
}
function releaseSlot():void{const next=waiters.shift();if(next)next();else busy=false;}
export async function cachedAcademicBody(q:string,url:string,ua:string,validate:(body:string)=>void):Promise<AcademicObservation>{
 const key=normalizeAcademicQuery(q),prior=cache.get(key),age=prior?Date.now()-Date.parse(prior.fetchedAt):Infinity;
 if(prior&&age>=0&&age<15*60_000){validate(prior.body);return prior;}
 const existing=pending.get(key);if(existing)return existing;
 const task=(async()=>{
  try{
   if(Date.now()<blockedUntil)throw failure('Crossref429 cooldown; no request made',429);
   const deadline=Date.now()+12_000;
   await acquireSlot(deadline);
   let releaseHere=true;
   try{
    if(Date.now()<blockedUntil)throw failure('Crossref429 cooldown; no request made',429);
    for(let attempt=0;attempt<2;attempt++){
     const wait=Math.max(0,nextStart-Date.now(),attempt?1000:0);
     if(wait)await new Promise(r=>setTimeout(r,Math.min(wait,Math.max(0,deadline-Date.now()))));
     const remaining=deadline-Date.now();if(remaining<=0)throw failure('Crossref total budget exhausted',undefined,true);
     const controller=new AbortController();let timedOut=false,ioSettled=false;
     nextStart=Date.now()+1000;
     const io=(async()=>{
      const res=await fetch(url,{signal:controller.signal,headers:{'User-Agent':ua}});
      if(res.status===429){const retry=res.headers.get('retry-after');const delay=retry&&/^\d+$/.test(retry.trim())?Number(retry)*1000:retry?Date.parse(retry)-Date.now():0;blockedUntil=Math.max(blockedUntil,Date.now()+Math.max(60_000,Number.isFinite(delay)?delay:0));}
      if(!res.ok)throw failure(`Crossref HTTP ${res.status}`,res.status);
      return await res.text();
     })().finally(()=>{ioSettled=true;});
     let timer:ReturnType<typeof setTimeout>;
     const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
      timedOut=true;controller.abort();
      reject(failure('Crossref timeout',undefined,true));
     },Math.min(attempt?remaining:6000,remaining));});
     let body:string;
     try{
      body=await Promise.race([io,timeout]);
      if(timedOut||Date.now()>=deadline)throw failure('Crossref timeout',undefined,true);
     }catch(err){
      // Drain abort rejection microtasks without extending the caller's clock budget.
      if(timedOut){await Promise.resolve();await Promise.resolve();await Promise.resolve();}
      const e=timedOut?failure('Crossref timeout',undefined,true):err;
      if(!ioSettled){
       draining=true;releaseHere=false;
       void io.then(()=>{draining=false;releaseSlot();},()=>{draining=false;releaseSlot();});
       throw e;
      }
      const status=(e as any)?.status;
      if(attempt===0&&((e as any)?.timeout||status>=500&&status<=599))continue;
      throw e;
     }finally{clearTimeout(timer!);}
     validate(body); // Malformed success is never retried, cached or stale-passed.
     const value={body,fetchedAt:new Date().toISOString()};
     if(cache.size>=128)cache.delete(cache.keys().next().value!);cache.set(key,value);return value;
    }
    throw failure('Crossref attempts exhausted',undefined,true);
   }finally{if(releaseHere)releaseSlot();}
  }catch(err){
   const e=err as any,status=e?.status,nowAge=prior?Date.now()-Date.parse(prior.fetchedAt):Infinity;
   if(prior&&!e?.code&&nowAge>=0&&nowAge<30*60_000&&(e?.timeout||status>=500&&status<=599)){
    validate(prior.body);return{...prior,staleReason:e.timeout?'Crossref timeout':'Crossref server failure or local public-pool capacity'};
   }
   throw err;
  }
 })();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
}
