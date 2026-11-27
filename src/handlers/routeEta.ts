// ROUTE_ETA_GENERAL — GET /v1/route-eta?origin=<lat,lon>&destination=<lat,lon>
//
// Zero-LLM. Driving ETA between two points from the public OSRM demo
// server, with a SHA-256 receipt over the exact upstream response body.
//
// Intent contract (read 2026-11-22): request origin/destination
// (strings, "Start point"/"End point"); response duration (scored,
// integer seconds 1..1000000). R1 (audit 2026-11-23): each endpoint may
// be "lat,lon" or a place name; names go through the same Open-Meteo
// city geocoder, selecting its first ranked match, with Photon street fallback
// only on an empty successful city result. Every answer discloses the selection,
// returned count and coordinates. This explicitly reverses ambiguity refusal.
//
// SOURCE: router.project-osrm.org demo server, keyless, probed live
// 2026-11-23. Fair use respected: exactly one lightweight request
// (overview=false, steps=false) per answer, identifying User-Agent.
//
// HONEST SCOPE, stated in every answer: this is the OSRM routing
// MODEL's static estimate for the car profile — no live traffic, no
// closures — and the demo server carries no uptime guarantee. The
// answer names the road-snapped waypoints OSRM actually routed between
// and their snapping distance, which can be large near water or in
// sparse map coverage.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, sha256Hex } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import {resolveRoutePlace,ROUTE_GEOCODER_ATTRIBUTION,type RouteCandidate} from "./routeGeocoder";

const SOURCE_TIMEOUT_MS = 6000;
// Assumed response budget (the contract publishes none): geocoding may use up to ROUTE_GEOCODE_BUDGET_MS, the route read gets what is left (at least 1.5 s, because geocode reads end by 7.5 s), so the worst case is 9 s.
export const ROUTE_TOTAL_BUDGET_MS = 9000;
const UA = "VeriReceipt/2.0 route-eta observer (+https://verireceipt.vercel.app)";

export interface OsrmRoute {
  duration_s: number; distance_m: number;
  origin_snapped: [number, number]; destination_snapped: [number, number];
  origin_snap_m: number; destination_snap_m: number;
}

export function parseOsrm(raw: string): OsrmRoute {
  const d = JSON.parse(raw) as Record<string, unknown>;
  if (d.code !== "Ok" || !Array.isArray(d.routes) || !(d.routes as unknown[]).length) {
    throw unprocessable("NO_ROUTE", `OSRM answered code=${String(d.code ?? "missing")}; no route is guessed`);
  }
  const r = (d.routes as Record<string, unknown>[])[0];
  const wps = (d.waypoints ?? []) as Record<string, unknown>[];
  const duration = r.duration;
  const distance = r.distance;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 1 || duration > 1000000 || typeof distance !== "number" || !Number.isFinite(distance) || distance < 0) {
    throw unprocessable("NO_USABLE_ROUTE", "the OSRM answer carried no usable duration; never guessed");
  }
  const loc = (i: number): [number, number] => {
    const l = wps[i]?.location as unknown;
    if (!Array.isArray(l) || l.length !== 2 || typeof l[0] !== 'number' || typeof l[1] !== 'number' || !Number.isFinite(l[0]) || !Number.isFinite(l[1]) || Math.abs(l[0]) > 180 || Math.abs(l[1]) > 90)
      throw unprocessable('NO_USABLE_ROUTE', 'missing or invalid source-snapped waypoint');
    return [l[0], l[1]];
  };
  const snaps = [wps[0]?.distance, wps[1]?.distance];
  if (snaps.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0))
    throw unprocessable('NO_USABLE_ROUTE', 'missing or invalid source snapping distance');
  return {
    duration_s: Math.round(duration), distance_m: distance,
    origin_snapped: loc(0), destination_snapped: loc(1),
    origin_snap_m: snaps[0] as number, destination_snap_m: snaps[1] as number,
  };
}

/** Check source-reported snapping distances against endpoint coordinates. Small implementation
 * differences are tolerated; no maximum snap is invented or silently clamped. */
export function verifyRouteEndpoints(route:OsrmRoute,origin:{lat:number;lon:number},destination:{lat:number;lon:number}):void{
 const distance=(a:{lat:number;lon:number},b:[number,number])=>{const r=Math.PI/180,x=Math.sin((b[1]-a.lat)*r/2)**2+Math.cos(a.lat*r)*Math.cos(b[1]*r)*Math.sin((b[0]-a.lon)*r/2)**2;return 6371000*2*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));};
 for(const [point,snapped,reported] of [[origin,route.origin_snapped,route.origin_snap_m],[destination,route.destination_snapped,route.destination_snap_m]] as const){
  const computed=distance(point,snapped),tolerance=Math.max(20,reported*.02);
  if(Math.abs(computed-reported)>tolerance)throw unprocessable('ROUTE_ENDPOINT_MISMATCH','source snapped waypoint does not match requested endpoint and reported snap distance; no duration asserted');
 }
}

export const INTENT = "ROUTE_ETA_GENERAL";

const greatCircleKm=(a:{latitude:number;longitude:number},b:{latitude:number;longitude:number}):number=>{
 const r=Math.PI/180,x=Math.sin((b.latitude-a.latitude)*r/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin((b.longitude-a.longitude)*r/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));
};
/** Pair choice from the candidates the geocoder already returned (top 5 per side, no extra call). A named side with 2+ candidates is
 * ambiguous. A coordinate endpoint or a named side with one candidate is fixed. When at least one side is ambiguous, the
 * origin/destination pair with the smallest great-circle distance is used (a fixed side contributes only itself). Ties go to the
 * better provider rank (rank sum, then origin rank). Two fixed sides stay exactly as today. The disclosure is added to the ambiguous side. */
export function chooseClosestPair(o:ResolvedPoint,d:ResolvedPoint):{o:ResolvedPoint;d:ResolvedPoint}{
 const oAmb=o.candidates.length>=2,dAmb=d.candidates.length>=2;
 if(!oAmb&&!dAmb)return {o,d};
 const fixed=(p:ResolvedPoint):RouteCandidate[]=>[{latitude:p.lat,longitude:p.lon,label:p.label,rank:1,provider:p.provider}];
 const oc=oAmb?o.candidates:fixed(o),dc=dAmb?d.candidates:fixed(d);
 let best:{a:RouteCandidate;b:RouteCandidate;km:number}|undefined;
 for(const a of oc)for(const b of dc){
  const km=greatCircleKm(a,b);
  if(!best||km<best.km||(km===best.km&&(a.rank+b.rank<best.a.rank+best.b.rank||(a.rank+b.rank===best.a.rank+best.b.rank&&a.rank<best.a.rank))))best={a,b,km};
 }
 const b=best!,lab=(c:RouteCandidate)=>c.label+' ('+c.latitude+', '+c.longitude+')';
 const pairLabel=(c:RouteCandidate,p:ResolvedPoint,amb:boolean)=>amb?lab(c):p.label;
 const pair='chose the closest pair among '+oc.length+' x '+dc.length+' candidates ('+pairLabel(b.a,o,oAmb)+' to '+pairLabel(b.b,d,dAmb)+', great-circle '+b.km.toFixed(1)+' km); not confirmed unique';
 const mk=(p:ResolvedPoint,c:RouteCandidate):ResolvedPoint=>({...p,lat:c.latitude,lon:c.longitude,label:lab(c),
  selection:'chose '+lab(c)+' ('+c.provider+' rank '+c.rank+' of the first rows it returned); '+pair});
 return {o:oAmb?mk(o,b.a):o,d:dAmb?mk(d,b.b):d};
}

interface ResolvedPoint { lat:number;lon:number;label:string;selection:string;geocoders:{url:string;body:string;fetched_at:string}[];candidates:RouteCandidate[];count:number;provider:string }
async function resolveEndpoint(raw:string|undefined,which:'origin'|'destination'):Promise<ResolvedPoint> {
 if(!raw?.trim())throw badRequest('MISSING_PARAM',which+' is required: lat,lon or a place/street');
 const trimmed=raw.trim();
 // Coordinate-like tokens must not become remote geocoding queries on parse failure.
 if(/^[+\-\d.\s,eE]+$/.test(trimmed)) {
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*,\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed))throw badRequest('BAD_LOCATION','invalid coordinates; expected latitude,longitude');
  const [lat,lon]=trimmed.split(',').map(Number);if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw badRequest('BAD_LOCATION','coordinates outside latitude/longitude bounds');
  return {lat,lon,label:lat+','+lon,selection:'coordinates given directly',geocoders:[],candidates:[],count:0,provider:''};
 }
 if(trimmed.length>250)throw badRequest('BAD_LOCATION','location name too long');
 const {hit,candidates,captures}=await resolveRoutePlace(trimmed);
 const label=hit.label+' ('+hit.latitude+', '+hit.longitude+')';
 return {lat:hit.latitude,lon:hit.longitude,label,selection:'chose '+label+' of '+hit.count+' matches returned by '+hit.provider+' (rank 1, provider order; not confirmed unique)',geocoders:captures,candidates,count:hit.count,provider:hit.provider};
}

// At most four demo-server operations, no queue. A timed-out read retains
// its slot until the underlying fetch/body settles. Healthy overlap is allowed.
let routeSourceActive = 0;
export function resetRouteSourceForTests() { routeSourceActive = 0; }
async function readRouteBody(url: string, timeoutMs: number = SOURCE_TIMEOUT_MS): Promise<string> {
  if (routeSourceActive >= 4) throw Error("route source busy");
  routeSourceActive++;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const io = (async () => {
    try {
      const res = await fetch(url, {redirect:"error",signal:controller.signal,headers:{"User-Agent":UA,Accept:"application/json"}});
      if (!res.ok || !res.body) throw Error("route source unavailable");
      const reader = res.body.getReader();
      const parts: Uint8Array[] = []; let size=0;
      while (true) {
        const part=await reader.read(); if(part.done)break;
        size+=part.value.byteLength;
        if(size>262144){void reader.cancel().catch(()=>{});throw Error("route body limit");}
        parts.push(part.value);
      }
      return Buffer.concat(parts).toString("utf8");
    } finally {routeSourceActive--;}
  })();
  try {
    return await Promise.race([io,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{controller.abort();reject(Error("route source deadline"));},timeoutMs);
    })]);
  } finally {clearTimeout(timer);}
}

export async function handleRouteEta(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const [o0,d0] = await Promise.all([resolveEndpoint(query.origin, "origin"),resolveEndpoint(query.destination, "destination")]);
  const {o,d:dst}=chooseClosestPair(o0,d0);
  // OSRM takes lon,lat order.
  const url = `https://router.project-osrm.org/route/v1/driving/${o.lon},${o.lat};${dst.lon},${dst.lat}?overview=false&steps=false`;
  const fetchedAt = new Date().toISOString();
  let body: string;
  try {
    body = await readRouteBody(url, Math.min(SOURCE_TIMEOUT_MS, ROUTE_TOTAL_BUDGET_MS - (Date.now() - startedAt)));
  } catch {
    throw upstreamUnavailable("OSRM_UNREACHABLE", "the OSRM demo server could not be reached");
  }
  const route = parseOsrm(body);
  verifyRouteEndpoints(route,o,dst);
  const durationS = route.duration_s; // Validated source value, rounded only; never clamped.
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ origin: `${o.lat},${o.lon}`, destination: `${dst.lat},${dst.lon}`,
    origin_resolved:o.label, origin_selection:o.selection,
    destination_resolved:dst.label,destination_selection:dst.selection,
    geocoders: [...o.geocoders,...dst.geocoders].map((g) => ({ url: g!.url, sha256: sha256Hex(Buffer.from(g!.body, "utf8")), raw_body: g!.body, fetched_at:g!.fetched_at })),
    as_of: asOf, route,geocoder_policy:ROUTE_GEOCODER_ATTRIBUTION,geocoder_terms:{photon:'https://photon.komoot.io/',open_meteo:'https://open-meteo.com/en/terms',odbl:'https://opendatacommons.org/licenses/odbl/1-0/',checked_at:'2026-11-24',photon_project_use:'fair use, throttling and no availability guarantee',open_meteo_free_commercial_use:false},
    source_policy: "OSRM demo server static car-profile model estimate; no live traffic; snapped waypoints disclosed; fair use: one lightweight request",
    raw_bodies: { route: body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, url, evidence, "OSRM demo server single source; static model estimate, snapped waypoints disclosed");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const km = (route.distance_m / 1000).toFixed(1);
  const mins = Math.round(durationS / 60);
  const answer =
    `Driving ETA ${mins} min (${durationS}s) over ${km} km from ${o.label} to ${dst.label}. ` +
    `This is the OSRM routing model's static car-profile estimate — no live traffic or closures — from the public demo server. ` +
    `Origin: ${o.selection}. Destination: ${dst.selection}. ${ROUTE_GEOCODER_ATTRIBUTION} ` +
    `OSRM snapped the origin to ${route.origin_snapped[1]}, ${route.origin_snapped[0]} (${Math.round(route.origin_snap_m)} m away) ` +
    `and the destination to ${route.destination_snapped[1]}, ${route.destination_snapped[0]} (${Math.round(route.destination_snap_m)} m away).`;
  return envelope(INTENT, {
    duration: durationS, duration_seconds:durationS,duration_minutes:durationS/60,distance_km:route.distance_m/1000,
    distance_m: route.distance_m,
    origin: `${o.lat},${o.lon}`,
    destination: `${dst.lat},${dst.lon}`,
    origin_snapped_lonlat: route.origin_snapped,
    destination_snapped_lonlat: route.destination_snapped,
    origin_snap_m: route.origin_snap_m,
    destination_snap_m: route.destination_snap_m,
  }, receipt, { answer, verdict: "verified", confidence: 0.7,
    source: `${url}; OSRM demo server static model estimate, no live traffic; fetched ${fetchedAt}` });
}
