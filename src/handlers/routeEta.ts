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
import {resolveRoutePlace,ROUTE_GEOCODER_ATTRIBUTION} from "./routeGeocoder";

const SOURCE_TIMEOUT_MS = 6000;
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

export const INTENT = "ROUTE_ETA_GENERAL";

interface ResolvedPoint { lat:number;lon:number;label:string;selection:string;geocoders:{url:string;body:string;fetched_at:string}[] }
async function resolveEndpoint(raw:string|undefined,which:'origin'|'destination'):Promise<ResolvedPoint> {
 if(!raw?.trim())throw badRequest('MISSING_PARAM',which+' is required: lat,lon or a place/street');
 const trimmed=raw.trim();
 // Coordinate-like tokens must not become remote geocoding queries on parse failure.
 if(/^[+\-\d.\s,eE]+$/.test(trimmed)) {
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*,\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed))throw badRequest('BAD_LOCATION','invalid coordinates; expected latitude,longitude');
  const [lat,lon]=trimmed.split(',').map(Number);if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw badRequest('BAD_LOCATION','coordinates outside latitude/longitude bounds');
  return {lat,lon,label:lat+','+lon,selection:'coordinates given directly',geocoders:[]};
 }
 if(trimmed.length>250)throw badRequest('BAD_LOCATION','location name too long');
 const {hit,captures}=await resolveRoutePlace(trimmed);
 const label=hit.label+' ('+hit.latitude+', '+hit.longitude+')';
 return {lat:hit.latitude,lon:hit.longitude,label,selection:'chose '+label+' of '+hit.count+' matches returned by '+hit.provider+' (rank 1, provider order; not confirmed unique)',geocoders:captures};
}

// At most four demo-server operations, no queue. A timed-out read retains
// its slot until the underlying fetch/body settles. Healthy overlap is allowed.
let routeSourceActive = 0;
export function resetRouteSourceForTests() { routeSourceActive = 0; }
async function readRouteBody(url: string): Promise<string> {
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
      timer=setTimeout(()=>{controller.abort();reject(Error("route source deadline"));},SOURCE_TIMEOUT_MS);
    })]);
  } finally {clearTimeout(timer);}
}

export async function handleRouteEta(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const o = await resolveEndpoint(query.origin, "origin");
  const dst = await resolveEndpoint(query.destination, "destination");
  // OSRM takes lon,lat order.
  const url = `https://router.project-osrm.org/route/v1/driving/${o.lon},${o.lat};${dst.lon},${dst.lat}?overview=false&steps=false`;
  const fetchedAt = new Date().toISOString();
  let body: string;
  try {
    body = await readRouteBody(url);
  } catch {
    throw upstreamUnavailable("OSRM_UNREACHABLE", "the OSRM demo server could not be reached");
  }
  const route = parseOsrm(body);
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
    duration: durationS,
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
