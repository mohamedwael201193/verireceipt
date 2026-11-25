export interface ObservedRate {source:string;url:string;rawBody:string;rate:number;rateDate:string;observedAt:string}
interface Quote {source:string;url:string;rawBody:string;rate:number;rateDate:string}
interface Panel {quotes:ObservedRate[];failed:string[];uncovered:string[];observedAt:string}
const cache=new Map<string,{value:Panel;expires:number}>();
const pending=new Map<string,Promise<Panel>>();
export const FX_OBSERVATION_CACHE_MS=55000;
export const FX_MAX_OBSERVATION_AGE_MS=300000;
export function resetFxObservationsForTests(){cache.clear();pending.clear();}
export function medianObservedRate(quotes:ObservedRate[]):number{
 if(!quotes.length)throw Error('no observed rates');const sorted=quotes.map(q=>q.rate).sort((a,b)=>a-b);if(sorted.some(r=>!Number.isFinite(r)||r<=0))throw Error('invalid observed rate');const m=Math.floor(sorted.length/2);return sorted.length%2?sorted[m]:(sorted[m-1]+sorted[m])/2;
}
export async function observeRatePanel(from:string,to:string,sources:{name:string;quote:(from:string,to:string)=>Promise<Quote|null>}[]):Promise<Panel>{
 const key=from+'/'+to,now=Date.now(),hit=cache.get(key);if(hit&&now<hit.expires&&hit.value.quotes.every(q=>{const age=now-Date.parse(q.observedAt);return Number.isFinite(age)&&age>=0&&age<=FX_MAX_OBSERVATION_AGE_MS;}))return hit.value;
 if(pending.has(key))return pending.get(key)!;
 const work=(async()=>{
  const settled=await Promise.all(sources.map(async s=>{try{let timer:ReturnType<typeof setTimeout>|undefined;let q:Quote|null;try{q=await Promise.race([s.quote(from,to),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('source deadline')),4000);})]);}finally{clearTimeout(timer);}if(!q||!Number.isFinite(q.rate)||q.rate<=0)return{name:s.name,quote:null,uncovered:true};return{name:s.name,quote:{...q,observedAt:new Date().toISOString()},uncovered:false};}catch{return{name:s.name,quote:null,uncovered:false};}}));
  const selected=settled.filter((x):x is {name:string;quote:ObservedRate;uncovered:boolean}=>x.quote!==null),value={quotes:selected.map(x=>x.quote),failed:settled.filter(x=>x.quote===null).map(x=>x.name),uncovered:settled.filter(x=>x.uncovered).map(x=>x.name),observedAt:new Date().toISOString()};
  if(value.quotes.length){if(cache.size>=128&&!cache.has(key))cache.delete(cache.keys().next().value!);cache.set(key,{value,expires:Date.now()+FX_OBSERVATION_CACHE_MS});}return value;
 })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
}

export function selectObservedRates(quotes:ObservedRate[]):{serving:ObservedRate[];excluded:ObservedRate[];rate:number}{
 if(!quotes.length)throw Error('no observed rates');
 const sorted=[...quotes].sort((a,b)=>a.rate-b.rate);let best:ObservedRate[]=[];let span=Infinity;let tied=false;
 for(let i=0;i<sorted.length;i++){const group=sorted.slice(i).filter(q=>(q.rate-sorted[i].rate)/sorted[i].rate<=0.005);const width=(group.at(-1)!.rate-group[0].rate)/group[0].rate;if(group.length>best.length||(group.length===best.length&&width<span-1e-12)){best=group;span=width;tied=false;}else if(group.length===best.length&&Math.abs(width-span)<=1e-12)tied=true;}
 if(tied&&best.length<sorted.length)throw Error('rate panel has ambiguous clusters');
 // An equally sized disjoint pair has no trustworthy majority.
 if(best.length*2<=sorted.length)throw Error('rate panel has no agreeing majority');
 const serving=best.length===sorted.length?sorted:best;
 return{serving,excluded:quotes.filter(q=>!serving.includes(q)),rate:medianObservedRate(serving)};
}
