import {badRequest} from '../core/errors';
import {observeFromSources,type ObservationSource,type SourceApproval} from '../core/observedSources';
import {parseBarentswatchPosition,type VesselPositionObservation} from './vesselPosition';
export interface VesselQuery {vessel:string}
const TIMEOUT_MS=2500,MAX_BYTES=65536,MAX_FRAMES=32;
/** Bounded one-shot SSE capture, never an ongoing subscription or polling loop. */
async function readEvent(url:string,vessel:string,parent:AbortSignal):Promise<{raw:string;value:VesselPositionObservation;fetchedAt:string}>{
 const controller=new AbortController();let cancel:(()=>void)|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const signal=AbortSignal.any([controller.signal,parent]);
 const fail=()=>{controller.abort();cancel?.();};
 const parentAbort=()=>fail();parent.addEventListener('abort',parentAbort,{once:true});
 const work=async()=>{
  if(signal.aborted)throw Error('AIS aborted');
  const response=await fetch(url,{signal,redirect:'error',headers:{accept:'text/event-stream','user-agent':'VeriReceipt/2.0 bounded AIS observer'}});
  if(signal.aborted){void response.body?.cancel().catch(()=>{});throw Error('AIS aborted');}
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error('AIS HTTP unavailable');}
  if(!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')){void response.body?.cancel().catch(()=>{});throw Error('AIS stream type mismatch');}
  const reader=response.body?.getReader();if(!reader)throw Error('AIS body missing');
  cancel=()=>{void reader.cancel().catch(()=>{});};
  const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',size=0,frames=0;
  try{
   while(true){
    const part=await reader.read();if(signal.aborted)throw Error('AIS aborted');
    if(part.done)throw Error('AIS ended without supported position');
    size+=part.value.byteLength;if(size>MAX_BYTES)throw Error('AIS stream too large');
    pending+=decoder.decode(part.value,{stream:true});
    let end:number;
    while((end=pending.indexOf('\n'))>=0){
     const line=pending.slice(0,end).replace(/\r$/,'');pending=pending.slice(end+1);
     if(!line.startsWith('data:'))continue;
     if(++frames>MAX_FRAMES)throw Error('AIS frame limit');
     const raw=line.slice(5).replace(/^ /,'');
     const event=JSON.parse(raw);
     if(event?.type==='error')throw Error('AIS source error');
     if(event?.type!=='event'||event?.msg_type!=='PositionReport')continue;
     const value=parseBarentswatchPosition(raw,vessel,Date.now());
     return {raw,value,fetchedAt:new Date().toISOString()};
    }
   }
  }finally{cancel();reader.releaseLock();cancel=undefined;}
 };
 try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(Error('AIS stream deadline'));fail();},TIMEOUT_MS);})]);}
 finally{if(timer)clearTimeout(timer);parent.removeEventListener('abort',parentAbort);fail();}
}
/** Terms/grants are provided by reviewed caller configuration, never inferred here. */
export function barentswatchPositionSource(approval:SourceApproval):ObservationSource<VesselQuery,VesselPositionObservation>{
 return {name:'Open Waters BarentsWatch decoded AIS position',approval,read:async(q,signal)=>{
  if(!/^[2-7][0-9]{8}$/.test(q.vessel))throw Error('unsupported ship MMSI');
  const url='https://ais.openwaters.io/v1/stream?'+new URLSearchParams({mmsi:q.vessel,snapshot:'1'});
  const {raw,value,fetchedAt}=await readEvent(url,q.vessel,signal);
  return {identity:value.vessel,sourceUrl:url,rawBody:raw,observedAt:value.observed_at,fetchedAt,value};
 }};
}
/** Unwired handler factory. No default source approval or route is enabled. */
export function createVesselObservationHandler(approval:SourceApproval){
 const source=barentswatchPositionSource(approval);
 return async(q:Record<string,string|undefined>)=>{
  const vessel=q.vessel;if(typeof vessel!=='string'||!/^[2-7][0-9]{8}$/.test(vessel))throw badRequest('INVALID_VESSEL','Only an exact nine-digit ship MMSI is supported');
  return observeFromSources({vessel},[source],{intent:'VESSEL_TELEMETRY_VERIFY_GENERAL',identity:q=>q.vessel,validate:v=>{if(v.vessel!==vessel)throw Error('AIS identity mismatch');},fields:v=>({vessel:v.vessel,speed_knots:v.speed_knots,latitude:v.latitude,longitude:v.longitude,course_deg:v.course_deg,observed_at:v.observed_at,ais_source:v.source,license:v.license,attribution:v.attribution,synthesized:v.synthesized,observation_scope:v.scope}),answer:v=>`${v.vessel}: ${v.speed_knots} knots SOG, ${v.latitude}, ${v.longitude}; COG ${v.course_deg} degrees. ${v.scope} Synthesized: ${v.synthesized}. ${v.attribution}`,maxAgeMs:300000,sourceTimeoutMs:3000,totalTimeoutMs:3000,stopAfterTimeout:true,scope:'Single decoded source event via Open Waters/BarentsWatch, not cross-source consensus or independent authentication. No navigation use, global coverage, name or IMO resolution.'});
 };
}
