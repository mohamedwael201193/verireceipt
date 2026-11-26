import {PublicBodyCache,StartBudget,readPublicBody,publicSourceFailure} from '../core/publicSource';
import {sha256Hex,envelope,makeReceipt} from '../core/receipt';
import {saveReceipt} from '../core/storage';import {upstreamUnavailable} from '../core/errors';
let cache=new PublicBodyCache(64,60000,()=>Date.now()),budget=new StartBudget(30,60000,()=>Date.now());
let active=0;let blockedUntil=0;
export function resetFlightSourcesForTests(){cache=new PublicBodyCache(64,60000,()=>Date.now());budget=new StartBudget(30,60000,()=>Date.now());active=0;blockedUntil=0;}
async function read(url:string){
 if(active>=4||!budget.take())throw Error('flight source capacity');
 active++;let timer:ReturnType<typeof setTimeout>;
 const io=readPublicBody(url,1_000_000,3000).finally(()=>{active--;});
 try{return await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('flight source deadline')),3100);})]);}finally{clearTimeout(timer!);}
}
export function parseFlightStats(html:string,carrier:string,number:string,now=Date.now()){
 const match=/__NEXT_DATA__\s*=\s*([\s\S]*?);\s*__NEXT_LOADED_PAGES__/.exec(html);
 if(!match)throw Error('no embedded flight data');
 const embedded=match[1],data=JSON.parse(embedded),flight=data?.props?.initialState?.flightTracker?.flight;
 if(data?.query?.carrierCode!==carrier||String(data?.query?.flightNumber)!==number||!flight||flight.ticketHeader?.carrier?.fs!==carrier||String(flight.ticketHeader.flightNumber)!==number||flight.resultHeader?.carrier?.fs!==carrier||String(flight.resultHeader.flightNumber)!==number)throw Error('flight identity mismatch');
 const schedule=flight.schedule;
 const strictUtc=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
 if(!strictUtc(schedule?.scheduledDepartureUTC)||!strictUtc(schedule?.scheduledArrivalUTC))throw Error('invalid real UTC schedule timestamp');
 const dep=Date.parse(schedule.scheduledDepartureUTC),arr=Date.parse(schedule.scheduledArrivalUTC);
 if(!Number.isFinite(dep)||!Number.isFinite(arr)||arr<=dep||dep<now-48*3600000||dep>now+36*3600000||arr<now-24*3600000||arr>now+60*3600000)throw Error('flight date unavailable or outside recent/current coverage');
 const origin=flight.departureAirport?.iata,destination=flight.arrivalAirport?.iata;
 if(!/^[A-Z]{3}$/.test(origin)||!/^[A-Z]{3}$/.test(destination)||flight.resultHeader.departureAirportFS!==origin||flight.resultHeader.arrivalAirportFS!==destination)throw Error('flight airport identity mismatch');
 const status=flight.status;
 if(!status||typeof status.statusDescription!=='string'||typeof status.status!=='string')throw Error('missing flight status');
 const updateText=status.lastUpdatedText;
 const terminal=flight.flightNote?.final===true&&((status.status==='Arrived'&&status.statusCode==='L'&&flight.flightNote?.landed===true&&flight.isLanded===true)||(status.status==='Canceled'&&status.statusCode==='C'&&flight.flightNote?.canceled===true)||(status.status==='Diverted'&&status.statusCode==='D'&&status.diverted===true));
 if(!terminal){const mins=/^(?:Status Last Updated )(\d+) Minutes? Ago$/.exec(updateText??'');if(!mins||Number(mins[1])>60)throw Error('current flight status update age unverified');}
 const text=[status.statusDescription,status.finalStatus,status.status].filter(Boolean).join('; ');
 const positive=/\b(cancelled|canceled|delayed|diverted)\b/i.test(text)||status.diverted===true||flight.flightNote?.canceled===true;
 const negative=/\bon time\b/i.test(status.statusDescription)&&!positive;
 if(!positive&&!negative)throw Error('flight status not explicitly delayed/cancelled/diverted or on time');
 const delay=status.delayStatus?.minutes;
 if(delay!==undefined&&(typeof delay!=='number'||!Number.isFinite(delay)||delay<0||delay>10000))throw Error('invalid delay');
 // Provider classification is used as stated, not an inferred threshold on
 // departure/arrival differences. Those timestamps remain evidence only.
 return {embedded,fields:{disrupted:positive,status:status.status+'; '+status.statusDescription,delay_minutes:typeof delay==='number'?delay:null,reason:null,flight_date:schedule.scheduledDepartureUTC.slice(0,10),schedule,origin,destination,provider_update_label:typeof status.lastUpdatedText==='string'?status.lastUpdatedText:null,method:'FlightStats explicit flight-level status classification; not inferred from airport conditions',date_selection:'source-selected recent/current occurrence, exact departure UTC date disclosed; no date was supplied'}};
}
async function persist(input:string,fields:Record<string,unknown>,evidence:Record<string,unknown>,url:string,fetchedAt:string,answer:string){
 const raw=JSON.stringify(evidence),receipt=makeReceipt('TRAVEL_DISRUPTION_GENERAL',url,raw,'dated flight status or explicitly separate airport fallback; no missing status converted to false');receipt.fetched_at=fetchedAt;
 try{await saveReceipt(receipt,raw);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','flight receipt evidence could not be stored');}
 return envelope('TRAVEL_DISRUPTION_GENERAL',{route_or_flight:input,...fields},receipt,{answer,verdict:typeof fields.disrupted==='boolean'?'verified':'unverified',confidence:typeof fields.disrupted==='boolean'?0.85:0,source:typeof fields.disrupted==='boolean'?url:'No verified flight-level status; separately labeled route/airport evidence only'});
}
/** A caller-supplied route to compare with the provider's record. With a supplied route, observeFlight returns null when no verified provider record exists, so the caller keeps the airport-route path. */
export interface SuppliedRoute{text:string;originSet:string[]|null;destinationSet:string[]|null;airportRoute:string|null}
export async function observeFlight(input:string,airportStatus:(airport:string)=>Promise<Record<string,unknown>>):Promise<Record<string,unknown>>;
export async function observeFlight(input:string,airportStatus:(airport:string)=>Promise<Record<string,unknown>>,supplied:SuppliedRoute):Promise<Record<string,unknown>|null>;
export async function observeFlight(input:string,airportStatus:(airport:string)=>Promise<Record<string,unknown>>,supplied?:SuppliedRoute):Promise<Record<string,unknown>|null>{
 const normalized=input.replace(/\s/g,'').toUpperCase(),parts=/^([A-Z]{2,3})(\d{1,4}[A-Z]?)$/.exec(normalized)!;
 let carrier=parts[1],number=parts[2],route:any=null,routeBody:string|null=null,routeUrl:string|null=null;let routeAttempted=false;
 const attempted:string[]=[];let sourceFailure='no_verified_flight_record';
 const getRoute=async()=>{if(routeAttempted)return;routeAttempted=true;routeUrl='https://api.adsbdb.com/v0/callsign/'+normalized;attempted.push(routeUrl);try{const got=await cache.get(routeUrl,()=>read(routeUrl!));const data=JSON.parse(got.raw),r=data?.response?.flightroute;if(!r||![r.callsign,r.callsign_iata,r.callsign_icao].includes(normalized))return;if(!/^[A-Z]{3}$/.test(r.origin?.iata_code)||!/^[A-Z]{3}$/.test(r.destination?.iata_code))return;route=r;routeBody=got.raw;}catch{}};
 if(carrier.length===3){await getRoute();const iata=/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/.exec(route?.callsign_iata??'');if(iata){carrier=iata[1];number=iata[2];}}
 if(carrier.length===2&&Date.now()>=blockedUntil){
  const url=`https://www.flightstats.com/v2/flight-tracker/${carrier}/${number}`;attempted.push(url);
  try{
   const day=new Date().toISOString().slice(0,10),got=await cache.get(url+':'+day,async()=>{const page=await read(url);parseFlightStats(page.raw,carrier,number);return page;});
   const parsed=parseFlightStats(got.raw,carrier,number);
   if(Date.now()-Date.parse(got.fetchedAt)<0||Date.now()-Date.parse(got.fetchedAt)>=60000)throw Error('flight observation expired');
   let matchFields:Record<string,unknown>={},matchEvidence:Record<string,unknown>={};
   if(supplied){
    const o=parsed.fields.origin as string,d=parsed.fields.destination as string;
    const state:'match'|'mismatch'|'unresolved'=!supplied.originSet||!supplied.destinationSet?'unresolved':(supplied.originSet.includes(o)&&supplied.destinationSet.includes(d))?'match':'mismatch';
    const comparison={supplied_route:supplied.text,provider_route:o+'-'+d,supplied_origin_airports:supplied.originSet,supplied_destination_airports:supplied.destinationSet,result:state};
    if(state==='match'){matchFields={route_match:true,supplied_route:supplied.text};matchEvidence={route_comparison:comparison};}
    if(state!=='match'){
    let airportEvidence:Record<string,unknown>|null=null;
    if(state==='mismatch'&&supplied.airportRoute){try{airportEvidence=await airportStatus(supplied.airportRoute);}catch(error){if((error as any)?.code==='RECEIPT_PERSIST_FAILED')throw error;}}
    const why=state==='mismatch'?`The provider reports ${normalized} flying ${o}-${d}, which does not match the supplied route "${supplied.text}".`:`The supplied route "${supplied.text}" could not be resolved to airports, so it cannot be compared with the provider route ${o}-${d}.`;
    const fields={disrupted:null,status:'unverified',delay_minutes:null,reason:null,reason_code:state==='mismatch'?'flight_route_mismatch':'flight_route_unresolved',disruption_scope:'flight-level unknown for the supplied route; provider record is for '+o+'-'+d+' only',airport_disrupted:airportEvidence?.disrupted??null,airport_delay_minutes:airportEvidence?.delay_minutes??null,airport_reason:airportEvidence?.reason??null,airport_statuses:airportEvidence?.airport_statuses??null,provider_route:{origin:o,destination:d,flight_date:parsed.fields.flight_date,flight_status:parsed.fields.status,flight_disrupted_for_provider_route:parsed.fields.disrupted,note:'status of the provider-matched flight on its own route, not an answer for the supplied route'},supplied_route:supplied.text,route_match:false,as_of:got.fetchedAt};
    return persist(input,fields,{requested_flight:input,source_url:url,extracted_json:parsed.embedded,page_sha256:sha256Hex(got.raw),extraction:'literal __NEXT_DATA__ JSON substring, not reserialized; whole page hash retained',fetched_at:got.fetchedAt,route_comparison:comparison,provider_fields:parsed.fields,airport_result:airportEvidence,...fields},url,got.fetchedAt,`${normalized}: flight disruption for the supplied route is unknown, not false. ${why} The provider's own status for ${o}-${d} (${parsed.fields.status}) is kept in the evidence under provider_route and is not applied to the supplied route. ${airportEvidence?'FAA airport conditions for the supplied airports are reported separately in airport_disrupted and airport_statuses, not the flight status.':'No airport status is reported.'}`);
    }
   }
   return persist(input,{...parsed.fields,disruption_scope:'flight-level provider status',as_of:got.fetchedAt,...matchFields},{...matchEvidence,requested_flight:input,source_url:url,extracted_json:parsed.embedded,page_sha256:sha256Hex(got.raw),extraction:'literal __NEXT_DATA__ JSON substring, not reserialized; whole page hash retained',fetched_at:got.fetchedAt,...parsed.fields},url,got.fetchedAt,`${normalized}: ${parsed.fields.status}; departure ${parsed.fields.schedule.scheduledDepartureUTC}, ${parsed.fields.origin}-${parsed.fields.destination}. Flight-level status reported by FlightStats, not airport inference. ${parsed.fields.delay_minutes===null?'No delay minutes asserted.':`Provider delay ${parsed.fields.delay_minutes} minutes.`} Source-selected occurrence because no date was supplied. Retrieved ${got.fetchedAt}.`);
  }catch(error){sourceFailure=publicSourceFailure(error);if(['http_403','http_429'].includes(sourceFailure)){blockedUntil=Date.now()+300000;sourceFailure='flight_source_blocked_no_bypass';}}
 }
 if(supplied)return null;
 await getRoute();let airportEvidence:Record<string,unknown>|null=null;
 const usEndpoint=route?[route.origin,route.destination].filter((a:any)=>a.country_iso_name==='US'&&/^[A-Z]{3}$/.test(a.iata_code)):[];
 if(usEndpoint.length){try{const codes=usEndpoint.map((a:any)=>a.iata_code).join('-');airportEvidence=await airportStatus(codes);}catch(error){if((error as any)?.code==='RECEIPT_PERSIST_FAILED')throw error;}}
 const now=new Date().toISOString();
 const fields={disrupted:null,status:'unverified',delay_minutes:null,reason:null,reason_code:'flight_status_unavailable',disruption_scope:'flight-level unknown; airport evidence separate',airport_disrupted:airportEvidence?.disrupted??null,airport_delay_minutes:airportEvidence?.delay_minutes??null,airport_reason:airportEvidence?.reason??null,airport_statuses:airportEvidence?.airport_statuses??null,route:route?{origin:route.origin.iata_code,destination:route.destination.iata_code,binding:'undated callsign route database claim, not a verified dated itinerary'}:null};
 return persist(input,fields,{requested_flight:input,attempted_sources:attempted,flight_source_status:sourceFailure,raw_route_body:routeBody,route_source:routeBody?routeUrl:null,airport_result:airportEvidence,...fields},routeBody?routeUrl!:'urn:verireceipt:flight-status-unavailable',now,`${normalized}: flight disruption is unknown, not false. No verified flight-level status was obtained. ${route?'A public callsign database reports '+route.origin.iata_code+'-'+route.destination.iata_code+', an undated route claim, not a dated itinerary. ':''}${airportEvidence?'FAA airport conditions are reported separately in airport_disrupted and airport_statuses, not the flight status.':'No airport status is asserted.'}${sourceFailure==='flight_source_blocked_no_bypass'?' Flight status source blocked the direct request; no bypass attempted.':''}`);
}
