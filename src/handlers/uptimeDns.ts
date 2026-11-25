// A negative DNS answer is evidence only when both independent resolvers agree.
// No target connection or arbitrary URL is used here.
export async function confirmNxDomain(hostname:string):Promise<{source:string;raw:string}[]|null>{
 const deadline=Date.now()+2000;
 const results=await Promise.all(['https://dns.google/resolve','https://cloudflare-dns.com/dns-query'].map(async base=>{
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([(async()=>{
   const source=base+'?name='+encodeURIComponent(hostname)+'&type=A';
   const response=await fetch(source,{headers:{accept:'application/dns-json'},redirect:'error',signal:abort.signal});
   if(!response.ok)return null;
   const reader=response.body?.getReader();if(!reader)return null;const parts:Uint8Array[]=[];let size=0;
   try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>65536){void reader.cancel().catch(()=>{});return null;}parts.push(chunk.value);}}finally{reader.releaseLock();}
   const raw=Buffer.concat(parts).toString('utf8'),data=JSON.parse(raw);
   if(data.Status!==3||data.TC!==false||!Array.isArray(data.Question)||data.Question.length!==1||data.Question[0].type!==1||typeof data.Question[0].name!=='string'||data.Question[0].name.toLowerCase().replace(/\.$/,'')!==hostname.toLowerCase().replace(/\.$/,'')||data.Answer!==undefined&&(!Array.isArray(data.Answer)||data.Answer.length>0))return null;
   return {source,raw};
  })(),new Promise<null>(resolve=>{timer=setTimeout(()=>{abort.abort();resolve(null);},Math.max(0,deadline-Date.now()));})]);}catch{return null;}finally{clearTimeout(timer);}
 }));
 return results.every(r=>r!==null)?results as {source:string;raw:string}[]:null;
}
