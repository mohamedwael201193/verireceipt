type Kind = 'geocode' | 'forecast';
interface Entry { body:string; fetchedAt:string }
const caches:Record<Kind,Map<string,Entry>>={geocode:new Map(),forecast:new Map()};
const active=new Map<string,Promise<Entry>>();
export function resetForecastSourcesForTests():void { caches.geocode.clear();caches.forecast.clear(); }
export function rememberForecastSource(kind:Kind,url:string,entry:Entry):void {
 const cache=caches[kind];if(cache.size>=256&&!cache.has(url))cache.delete(cache.keys().next().value!);cache.set(url,entry);
}
export async function readForecastSource(kind:Kind,url:string):Promise<Entry> {
 const prior=caches[kind].get(url);const age=prior?Date.now()-Date.parse(prior.fetchedAt):Infinity;
 if(prior&&age>=0&&(kind==='geocode'||age<300000))return {...prior};
 let io=active.get(url);
 if(!io){
  if(active.size>=8)throw Error('forecast source capacity');
  io=(async()=>{
   for(let n=0;n<2;n++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),15000);
    try{
     const res=await fetch(url,{signal:controller.signal,headers:{'User-Agent':'VeriReceipt/2.0','Accept':'application/json'}});
     if(!res.ok){
      console.info(JSON.stringify({event:'forecast_source_failure',source:kind,status:res.status,attempt:n+1}));
      try{await res.body?.cancel();}catch{}
      if(controller.signal.aborted)throw Error('forecast source timeout');
      if(n===0&&(res.status===429||res.status>=500)){await new Promise(r=>setTimeout(r,1000));continue;}
      {const failure=Error('forecast upstream HTTP failure') as Error&{httpStatus?:number};failure.httpStatus=res.status;throw failure;}
     }
     const body=await res.text();
     if(controller.signal.aborted)throw Error('forecast source timeout');
     return {body,fetchedAt:new Date().toISOString()};
    }finally{clearTimeout(timer);}
   }
   throw Error('forecast source unavailable');
  })();
  active.set(url,io);const owned=io;void io.then(()=>{if(active.get(url)===owned)active.delete(url);},()=>{if(active.get(url)===owned)active.delete(url);});
 }
 let deadline:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([io,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(Error('forecast source deadline')),31000);})]);}
 finally{clearTimeout(deadline);}
}
