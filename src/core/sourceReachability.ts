// Nonblocking, bounded transport observations. Not source-data validity or API health clearance.
const MIN_INTERVAL_MS = 60_000;
const TIMEOUT_MS = 2_000;
const SOURCES: Record<string,string> = {
  coinpaprika: 'https://api.coinpaprika.com/v1/tickers/eth-ethereum',
};
interface State { attempted_at: string; completed_at: string|null; status: 'pending'|'reachable'|'http_error'|'timeout'|'unavailable'|'blocked'; http_status: number|null }
const results = new Map<string,State>();
const flights = new Map<string,Promise<void>>();
const halted = new Set<string>();
export function sourceReachabilitySnapshot(): Record<string,State> {
  return Object.fromEntries([...results].map(([key,value])=>[key,{...value}]));
}
export function refreshSourceReachability(): void {
  for(const [key,url] of Object.entries(SOURCES)) {
    const prior=results.get(key);
    if(halted.has(key)||flights.has(key)||prior && Date.now()-Date.parse(prior.attempted_at)<MIN_INTERVAL_MS) continue;
    results.set(key,{attempted_at:new Date().toISOString(),completed_at:null,status:'pending',http_status:null});
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const work=(async()=>{
      try {
        const response=await Promise.race([
          fetch(url,{redirect:'error',signal:controller.signal,headers:{accept:'application/json','user-agent':'VeriReceipt/2.0 bounded source reachability'}}).then(r=>{if(controller.signal.aborted){void r.body?.cancel().catch(()=>{});throw new Error('deadline');}return r;}),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('deadline'));},TIMEOUT_MS);}),
        ]);
        void response.body?.cancel().catch(()=>{});
        const blocked=response.status===403||response.status===429;
        if(blocked)halted.add(key); // No challenge or rate-limit retry in this process.
        results.set(key,{...results.get(key)!,completed_at:new Date().toISOString(),status:blocked?'blocked':response.ok?'reachable':'http_error',http_status:response.status});
      }catch {
        results.set(key,{...results.get(key)!,completed_at:new Date().toISOString(),status:controller.signal.aborted?'timeout':'unavailable',http_status:null});
      }finally{clearTimeout(timer!);controller.abort();}
    })();
    flights.set(key,work);
    void work.finally(()=>flights.delete(key));
  }
}
export async function awaitReachabilityForTests():Promise<void>{await Promise.all(flights.values());}
export function resetReachabilityForTests():void{results.clear();flights.clear();halted.clear();}
