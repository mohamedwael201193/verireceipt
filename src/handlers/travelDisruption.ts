import {observeFlight} from './flightStatus';
import {travelEndpoint,travelMetro} from '../data/travelMetros';
// TRAVEL_DISRUPTION_GENERAL — GET /v1/travel-disruption?route_or_flight=<IATA>
//
// Zero-LLM. US airport-level disruption status from the FAA's NAS
// status feed, with a SHA-256 receipt over the exact upstream body.
//
// Intent contract (read 2026-11-22): request route_or_flight (string);
// scored disrupted bool; off-chain route_or_flight, status,
// delay_minutes, reason.
//
// SOURCE: nasstatus.faa.gov airport-status-information, keyless,
// probed live 2026-11-23. The feed ignores its airport parameter and
// returns the full NAS snapshot, so filtering is local.
//
// HONEST SCOPE: this is AIRPORT-LEVEL FAA NAS status — ground delay
// programs, ground stops, general arrival/departure delays, closures —
// Airport observations never stand in for flight-level status. Bare flight
// numbers use the separately evidenced FlightStats path and route fallback.
// Every answer says so, and the receipt discloses the input narrowing
// (route_or_flight accepts a 3-letter FAA/IATA airport code or a name
// from the bundled US airport list, disclosed when resolved), or a
// two-endpoint route. A flight number alone does not establish its origin.
import {withAnswerClass} from '../core/answerClass';
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { resolveAirportName } from "../data/airportNames";

const SOURCE_TIMEOUT_MS = 8000;
const UA = "VeriReceipt/2.0 travel-disruption observer (+https://verireceipt.vercel.app)";
const NAS_URL = "https://nasstatus.faa.gov/api/airport-status-information";

export const INTENT = "TRAVEL_DISRUPTION_GENERAL";

export interface AirportStatusEntry { kind: string; reason: string; avg: string; max: string; trend: string }

function minutesOf(text: string): number | null {
  let total = 0;
  const h = /(\d+)\s*hours?/.exec(text);
  const m = /(\d+)\s*minutes?/.exec(text);
  if (h) total += Number(h[1]) * 60;
  if (m) total += Number(m[1]);
  return h || m ? total : null;
}

function notamTime(token: string): number | null {
  if (!/^\d{10}$/.test(token)) return null;
  const year=2000+Number(token.slice(0,2)),month=Number(token.slice(2,4)),day=Number(token.slice(4,6)),hour=Number(token.slice(6,8)),minute=Number(token.slice(8,10));
  const time=Date.UTC(year,month-1,day,hour,minute),d=new Date(time);
  return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day&&d.getUTCHours()===hour&&d.getUTCMinutes()===minute ? time : null;
}
export function classifyNasClosure(reason:string,updateTime:string): {active:boolean; exclusion:string|null} {
  // NOTAMs contain explicit two-digit-year UTC ranges, unlike display dates.
  const match=/(?:^|\s)(\d{10})-(\d{10})(?:\s|$)/.exec(reason.trim());
  const start=match?notamTime(match[1]):null,end=match?notamTime(match[2]):null,asOf=Date.parse(updateTime);
  if(start===null||end===null||end<=start||!Number.isFinite(asOf))throw upstreamUnavailable('FAA_CLOSURE_WINDOW_UNRESOLVED','FAA closure has no valid explicit dated window; refusing an airport-wide verdict');
  if(asOf<start||asOf>=end)return {active:false,exclusion:'outside explicit NOTAM UTC window'};
  if(/\bCLSD\s+TO\s+NON[ -]SKED\s+TRANSIENT\s+GA\s+ACFT\b/i.test(reason))return {active:false,exclusion:'restriction applies only to non-scheduled transient general aviation, not an airport-wide closure'};
  return {active:true,exclusion:null};
}
export function parseNasStatus(raw: string, airport: string): { updateTime: string; entries: AirportStatusEntry[]; excluded_closures:{reason:string;exclusion:string}[] } {
  const updateTime = /<Update_Time>([^<]*)<\/Update_Time>/.exec(raw)?.[1] ?? "";
  const entries: AirportStatusEntry[] = [];
  const excluded_closures:{reason:string;exclusion:string}[]=[];
  const arptRe = new RegExp(`<ARPT>${airport}</ARPT>`);
  for (const block of raw.match(/<Ground_Delay>[\s\S]*?<\/Ground_Delay>/g) ?? []) {
    if (!arptRe.test(block)) continue;
    entries.push({ kind: "ground delay program",
      reason: /<Reason>([^<]*)<\/Reason>/.exec(block)?.[1] ?? "",
      avg: /<Avg>([^<]*)<\/Avg>/.exec(block)?.[1] ?? "",
      max: /<Max>([^<]*)<\/Max>/.exec(block)?.[1] ?? "", trend: "" });
  }
  for (const block of raw.match(/<Ground_Stop>[\s\S]*?<\/Ground_Stop>/g) ?? []) {
    if (!arptRe.test(block)) continue;
    entries.push({ kind: "ground stop",
      reason: /<Reason>([^<]*)<\/Reason>/.exec(block)?.[1] ?? "",
      avg: "", max: "", trend: "" });
  }
  for (const block of raw.match(/<Delay>[\s\S]*?<\/Delay>/g) ?? []) {
    if (!arptRe.test(block)) continue;
    entries.push({ kind: "arrival/departure delay",
      reason: /<Reason>([^<]*)<\/Reason>/.exec(block)?.[1] ?? "",
      avg: /<Min>([^<]*)<\/Min>/.exec(block)?.[1] ?? "",
      max: /<Max>([^<]*)<\/Max>/.exec(block)?.[1] ?? "",
      trend: /<Trend>([^<]*)<\/Trend>/.exec(block)?.[1] ?? "" });
  }
  for (const block of raw.match(/<Airport>[\s\S]*?<\/Airport>/g) ?? []) {
    if (!arptRe.test(block)) continue;
    const reason=/<Reason>([^<]*)<\/Reason>/.exec(block)?.[1] ?? "";
    const classification=classifyNasClosure(reason,updateTime);
    if(!classification.active){excluded_closures.push({reason,exclusion:classification.exclusion!});continue;}
    entries.push({ kind: "airport closure",
      reason: reason.slice(0, 200),
      avg: "", max: "", trend: "" });
  }
  return { updateTime, entries, excluded_closures };
}

/** Split a "<origin> to <destination>" or "AAA-BBB" route. The origin is the text after the last whole word "from", so leading words ("7:15 AM Southwest flight from BWI") are not part of the endpoint. Nothing else is inferred; text that still does not resolve stays coverage_unavailable. */
export function splitTravelRoute(input:string):{origin:string;destination:string}|null{
  const m=/^(.+?)\s+to\s+(.+)$/i.exec(input);
  if(m){
    let origin=m[1].trim().replace(/^from\s+/i,'');
    const words=[...m[1].matchAll(/\bfrom\s+/gi)];
    const last=words[words.length-1];
    if(last&&last.index!==undefined){const after=m[1].slice(last.index+last[0].length).trim();if(after)origin=after;}
    return {origin,destination:m[2].trim()};
  }
  const c=/^([a-z]{3})\s*[-/]\s*([a-z]{3})$/i.exec(input);
  return c?{origin:c[1].trim(),destination:c[2].trim()}:null;
}

async function travelUnknown(input:string,reason:'flight_status_unavailable'|'coverage_unavailable'){
 const now=new Date().toISOString();const notice=reason==='flight_status_unavailable'?'Flight status is not verifiable from keyless FAA NAS airport data. A flight number alone does not establish its airports or dated itinerary.':'FAA NAS coverage is limited to the bundled US airports in this slice. Non-US or unrecognized endpoints are not verified; no disruption status is inferred.';
 const evidence=JSON.stringify({route_or_flight:input,reason_code:reason,disrupted:null,notice,external_lookup:false,assessed_at:now});const receipt=makeReceipt(INTENT,'local:travel-coverage',evidence,'input/coverage assessment only; no flight or airport observation');receipt.fetched_at=now;
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 return envelope(INTENT,{route_or_flight:input,disrupted:null,status:'unverified',delay_minutes:null,reason_code:reason},receipt,{answer:notice+' Disruption is unknown, not false; no FAA status was fetched for this input.',verdict:'unverified',confidence:0,source:'Input coverage only; no external status evidence'});
}

async function handleTravelDisruptionInternal(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const rawInput = query.route_or_flight?.trim();
  if (!rawInput) throw badRequest("MISSING_PARAM", "route_or_flight is required as a 3-letter airport code, e.g. LGA, or a US airport name");
  if (rawInput.length > 200 || /[\x00-\x1f]/.test(rawInput)) throw badRequest('INVALID_ROUTE','route_or_flight must be at most 200 printable characters');
  if(/^[A-Za-z]{2,3}\s*\d{1,4}[A-Za-z]?$/.test(rawInput))return observeFlight(rawInput,airport=>handleTravelDisruptionInternal({route_or_flight:airport}));
  // A supplied airport route is context, never a dated flight-to-airport lookup.
  const suppliedFlight = /^([A-Za-z]{2,3}\s*\d{1,4}[A-Za-z]?)\s+(.+)$/i.exec(rawInput);
  const routeInput = suppliedFlight ? suppliedFlight[2].trim() : rawInput;
  const split = splitTravelRoute(routeInput);
  const route = split !== null;
  if(suppliedFlight&&!route)return travelUnknown(rawInput,'flight_status_unavailable');
  const names = split ? [split.origin,split.destination] : [routeInput.replace(/^from\s+/i,'')];
  if(suppliedFlight&&route){
    // Compare the supplied route with a verified flight record before anything else. Without one, the airport-route path below runs as before.
    const set=(n:string):string[]|null=>{const g=travelEndpoint(n);if(g.length)return g.map(x=>x.airport);return /^[A-Za-z]{3}$/.test(n)?[n.toUpperCase()]:null;};
    const o=set(names[0]),d=set(names[1]);
    const checked=await observeFlight(suppliedFlight[1],airport=>handleTravelDisruptionInternal({route_or_flight:airport}),{text:names[0]+' to '+names[1],originSet:o,destinationSet:d,airportRoute:o&&d?names[0]+' to '+names[1]:null});
    if(checked)return checked;
  }
  const endpointGroups=names.map(travelEndpoint);
  if(endpointGroups.some(group=>!group.length))return travelUnknown(rawInput,'coverage_unavailable');
  const resolutions=[...new Map(endpointGroups.flat().map(r=>[r.airport,r])).values()];
  const airport = resolutions[0].airport;
  const resolvedFrom = resolutions[0].resolvedFrom;
  const fetchedAt = new Date().toISOString();
  let body: string;
  try {
    const controller = new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    try {
      const io=(async()=>{const res = await fetch(`${NAS_URL}?airport=${airport}`, { signal: controller.signal, headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();})();
      body=await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error("FAA deadline"));},SOURCE_TIMEOUT_MS);})]);
    } finally {
      clearTimeout(timer!);
    }
  } catch {
    throw upstreamUnavailable("FAA_UNREACHABLE", "the FAA NAS status feed could not be reached");
  }
  if (!body.includes("AIRPORT_STATUS_INFORMATION")) {
    throw unprocessable("NO_USABLE_STATUS", "the FAA answer was not a NAS status document; nothing is guessed");
  }
  const airportStatuses=resolutions.map(({airport})=>{
    const {updateTime,entries,excluded_closures}=parseNasStatus(body,airport);
    const delays=entries.map(e=>minutesOf(e.avg)).filter((v):v is number=>v!==null);
    return {airport,update_time:updateTime,entries,excluded_closures,disrupted:entries.length>0,delay_minutes:delays.length?Math.max(...delays):null};
  });
  const updateTime=airportStatuses[0].update_time;
  const entries=airportStatuses.flatMap(s=>s.entries);
  const disrupted=airportStatuses.some(s=>s.disrupted);
  const delayMinutes=airportStatuses.map(s=>s.delay_minutes).filter((v):v is number=>v!==null);
  // These airport-level averages are not a sum or estimate of route/flight delay.
  const maxDelay=delayMinutes.length?Math.max(...delayMinutes):null;
  const status=disrupted?airportStatuses.filter(s=>s.disrupted).map(s=>s.airport+': '+s.entries.map(e=>e.kind).join('; ')).join('; '):'no active FAA-listed disruption';
  const reason=entries.map(e=>e.reason).filter(Boolean).join('; ');
  const resolvedRoute=(route||resolutions.length>1)?resolutions.map(r=>r.airport).join('-'):airport;
  const asOf = new Date().toISOString();
  const flightContext = suppliedFlight ? {flight_number:suppliedFlight[1].replace(/\s/g," ").trim().toUpperCase(),route_binding:"caller-supplied, not independently verified",flight_level_status:null,flight_level_data_available:false} : null;
  const evidence = JSON.stringify({ route_or_flight: resolvedRoute, flight_context:flightContext, airport_statuses:airportStatuses, route_name_resolutions:resolutions, as_of: asOf, feed_update_time: updateTime, entries,
    name_resolution: resolvedFrom ? { input: resolvedFrom.name, resolved_to: airport, label: resolvedFrom.label, source: "bundled static US airport list (in-repo table, not a live directory)" } : "not used (3-letter code given directly)",
    input_narrowing: "route_or_flight resolved to one or two airport codes: FAA airport-level NAS status only, never flight-level tracking; the feed ignores its airport parameter so filtering is local",
    source_policy: "FAA NAS status snapshot (ground delay programs, ground stops, arrival/departure delays, closures); airport-level only",
    raw_bodies: { nas_status: body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, NAS_URL, evidence, "FAA NAS status single source; airport-level only, input narrowing disclosed");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const namePrefix = names.some(name=>travelMetro(name)) ? `Metro expansion: ${resolutions.map(r=>r.airport).join(", ")} from the bundled static metro list; all checked, no single airport chosen. ` : resolvedFrom ? `"${resolvedFrom.name}" resolved to ${airport} (${resolvedFrom.label}) via the bundled airport list. ` : "";
  const excludedCount=airportStatuses.reduce((n,s)=>n+s.excluded_closures.length,0);
  const answer = (route||resolutions.length>1)
    ? `${namePrefix}${resolvedRoute}: ${airportStatuses.map(s=>s.airport+(s.disrupted?' has '+s.entries.map(e=>e.kind+(e.reason?' ('+e.reason+')':'')).join('; '):' has no active FAA-listed disruption')).join('; ')}. FAA NAS status as of ${updateTime}. All airports in the supplied endpoints or metro groups checked against one snapshot. Airport-level status only, not flight tracking or route delay; an unlisted condition is not claimed normal.`
    : disrupted
    ? `${namePrefix}${airport} is DISRUPTED at the airport level: ${status}${reason ? ` (${reason})` : ""}` +
      `${maxDelay !== null ? `, average delay up to ${maxDelay} minutes` : ""}. FAA NAS status as of ${updateTime}. ` +
      `This is airport-level FAA status, not flight-level tracking.`
    : `${namePrefix}${airport}: no active FAA-listed disruption (no ground delay program, ground stop, arrival/departure delay or closure) in the NAS status as of ${updateTime}. ` +
      `This is airport-level FAA status, not flight-level tracking; an unlisted airport or unlisted condition is not claimed normal.`;
  return envelope(INTENT, {
    disrupted:flightContext?null:disrupted,
    ...(flightContext?{airport_disrupted:disrupted,airport_delay_minutes:maxDelay,airport_reason:reason||null}:{}),
    route_or_flight: resolvedRoute,
    flight_context: flightContext,
    disruption_scope: "FAA airport-level only, not the flight",
    airport_statuses: airportStatuses,
    status,
    delay_minutes: flightContext?null:maxDelay,
    delay_semantics: "maximum reported airport average, not route or flight delay",
    reason: flightContext?null:reason || null,
    closure_policy: "Only active dated airport-wide closures count; restricted non-scheduled transient GA notices are disclosed separately and are not flight status",
  }, receipt, { answer:answer+(flightContext ? " Flight-level data not available. The caller supplied this airport route; it is not a verified route for the flight number. airport_disrupted describes only the supplied airports; flight-level disrupted is null." : "")+(excludedCount ? ` ${excludedCount} restricted or out-of-window closure notice(s) excluded from airport-wide disruption; full details retained per airport.` : ""), verdict: flightContext?"unverified":"verified", confidence: flightContext?0:0.9,
    source: `${NAS_URL}; FAA NAS status snapshot, airport-level only; feed updated ${updateTime}; fetched ${fetchedAt}` });
}

function travelInputClass(q:Record<string,string|undefined>):string {
 const raw=q.route_or_flight?.trim();
 if(!raw)return 'missing';
 if(raw.length>200||/[\x00-\x1f]/.test(raw))return 'invalid';
 if(/^[A-Za-z]{2,3}\s*\d{1,4}[A-Za-z]?(?:\s.*)?$/.test(raw))return 'flight_number';
 const split=splitTravelRoute(raw);const route=split!==null;
 const names=split?[split.origin,split.destination]:[raw];
 const kinds=names.map(n=>/^[a-z]{3}$/i.test(n)?'code':resolveAirportName(n).length===1?'name':resolveAirportName(n).length>1?'ambiguous':'unsupported');
 if(names.some(n=>travelMetro(n)))return 'metro';
 if(names.some(n=>!travelEndpoint(n).length))return 'coverage_unavailable';
 if(kinds.includes('ambiguous'))return 'ambiguous_airport';
 if(kinds.includes('unsupported'))return 'unsupported';
 return route?'airport_route':kinds[0]==='code'?'airport_code':'airport_name';
}
export async function handleTravelDisruption(q:Record<string,string|undefined>):Promise<Record<string,unknown>> {
 const cls={travel_input_class:travelInputClass(q)};
 try{return withAnswerClass(await handleTravelDisruptionInternal(q),INTENT,cls);}
 catch(error){if(error!==null&&typeof error==='object')withAnswerClass(error,INTENT,cls);throw error;}
}
