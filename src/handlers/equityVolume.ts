export function parseEquityVolume(raw:string,ticker:string,at:number){
 const r=JSON.parse(raw)?.chart?.result?.[0],m=r?.meta,q=r?.indicators?.quote?.[0];
 if(!Number.isFinite(at))throw Error('invalid observation time');
 if(m?.symbol!==ticker||m.currency!=='USD'||m.instrumentType!=='EQUITY'||m.dataGranularity!=='5m'||!Array.isArray(r.timestamp)||!Array.isArray(q?.close)||!Array.isArray(q?.volume)||r.timestamp.length>2000||r.timestamp.length!==q.close.length||r.timestamp.length!==q.volume.length)throw Error('intraday identity or shape mismatch');
 const end=Math.floor(at/300000)*300000,start=end-86400000;
 const periods=m.tradingPeriods;
 if(!Array.isArray(periods)||!periods.length||periods.length>10||periods.some((p:any)=>!Array.isArray(p)||p.length>2))throw Error('session coverage absent');
 const sessions=periods.flat();if(sessions.some((p:any)=>!Number.isSafeInteger(p?.start)||!Number.isSafeInteger(p.end)||p.end<=p.start||p.end-p.start>86400||p.start*1000>at+86400000||p.end*1000<at-10*86400000))throw Error('invalid session coverage');
 if(Math.min(...sessions.map((p:any)=>p.start))*1000>start||Math.max(...sessions.map((p:any)=>p.end))*1000<end-18*3600000)throw Error('session history does not cover recent window');
 const current=m.currentTradingPeriod?.regular;
 if(!current||!Number.isSafeInteger(current.start)||!Number.isSafeInteger(current.end)||current.end<=current.start||current.end-current.start>86400)throw Error('invalid current session');
 if(current.start*1000<end&&current.end*1000>start&&!sessions.some((p:any)=>p.start===current.start&&p.end===current.end))throw Error('current session metadata omitted or inconsistent');
 const rows=new Map<number,{close:number;volume:number}>();let previous=-Infinity;
 for(let i=0;i<r.timestamp.length;i++){
  const t=r.timestamp[i];if(!Number.isSafeInteger(t)||t<=previous||t*1000>at+60000)throw Error('invalid timestamp order');previous=t;
  if(t*1000<start||t*1000+300000>end)continue;
  if(!sessions.some((p:any)=>t>=p.start&&t+300<=p.end)){if(q.volume[i]!==0)throw Error('bar outside declared sessions');continue;}
  const c=q.close[i],v=q.volume[i];if(typeof c!=='number'||!Number.isFinite(c)||c<=0||!Number.isSafeInteger(v)||v<0)throw Error('missing or invalid bucket');rows.set(t,{close:c,volume:v});
 }
 for(const p of sessions)for(let t=Math.max(p.start,Math.ceil(start/1000/300)*300);t+300<=Math.min(p.end,end/1000);t+=300)if(!rows.has(t))throw Error('missing regular-session bucket');
 if(!rows.size)throw Error('no observed regular-session buckets');
 let value=0;for(const row of rows.values())value+=row.close*row.volume;
 if(!Number.isFinite(value)||value<0||value>1e15)throw Error('volume outside range');
 return {value_usd:Math.round(value),window_start:new Date(start).toISOString(),window_end:new Date(end).toISOString(),bucket_count:rows.size,basis:'trailing24h_regular_session_5m_close_times_share_volume_estimate',scope:'regular sessions only; excludes pre/post-market, uses bucket close not actual trade prices; latest incomplete bucket excluded',method:'sum of close USD times share volume for complete5minute regular-session buckets within trailing24hours ending at previous5minute boundary; not exact traded-dollar turnover'};
}
/** Optional enrichment must never spend a second Yahoo request or delay quotes.
 * The shared canonical chart currently has daily granularity, so null is honest.
 * Intraday observations supplied by that shared source can be parsed without I/O. */
export function equityVolumeFromObservation(ticker:string,raw:string,fetchedAt:string,sourceUrl:string){
 try{return {...parseEquityVolume(raw,ticker,Date.parse(fetchedAt)),source_url:sourceUrl,fetched_at:fetchedAt,raw_body:raw,status:'estimated'};}
 catch{return{value_usd:null,basis:'unavailable',status:'unavailable',reason:'shared canonical quote has no complete validated intraday volume window; no additional Yahoo request made',raw_body:null,window_start:null,window_end:null,fetched_at:fetchedAt};}
}
