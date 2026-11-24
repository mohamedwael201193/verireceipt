// Diagnostic side table only. Never serialize the error or inspect its message.
export type FailureClass = 'rate_limited'|'unreachable'|'bad_payload'|'other'|'unknown'|'mixed';
const failures=new WeakMap<object,FailureClass>();
export function markFailure(error:unknown,kind:FailureClass):void {try{if(error&&typeof error==='object')failures.set(error,kind);}catch{}}
export function failureKind(error:unknown):FailureClass {try{return error&&typeof error==='object'?failures.get(error)??'unknown':'unknown';}catch{return'unknown';}}
export function combineFailures(rows:Array<{upstream_name:string;upstream_failure:FailureClass}>):Record<string,string>{
 if(!rows.length)return{upstream_name:'unknown',upstream_failure:'unknown'};
 return{upstream_name:new Set(rows.map(r=>r.upstream_name)).size===1?rows[0].upstream_name:'mixed',upstream_failure:new Set(rows.map(r=>r.upstream_failure)).size===1?rows[0].upstream_failure:'mixed'};
}
export function metricUpstream(url:string):string {switch(url){case'https://eth-mainnet.public.blastapi.io':return'blastapi';case'https://eth.drpc.org':case'https://arbitrum.drpc.org':case'https://polygon.drpc.org':return'drpc';case'https://rpc.mevblocker.io':return'mevblocker';case'https://arb1.arbitrum.io/rpc':return'arbitrum_rpc';case'https://arbitrum.gateway.tenderly.co':case'https://polygon.gateway.tenderly.co':return'tenderly';default:return'unknown';}}
