import {queryFallback} from '../core/queryFallback';
// STORM_ALERT_GENERAL: aligned hourly model forecast plus available NWS alert evidence.
// Forecast heuristic is disclosed, not an official warning or a contract risk formula.
// NWS expiry-inside-window scoring policy is retained from the prior implementation.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { parseRankedLocation } from "./routeGeocoder";
import { envelope, makeReceipt, sha256Hex } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { forecastWindow,stormForecastUrl,readStormForecast,parseStormForecast,STORM_HEURISTIC } from "./stormForecast";

const SOURCE_TIMEOUT_MS = 6000;
const UA = "VeriReceipt/2.0 storm-alert observer (+https://verireceipt.vercel.app)";

const SEVERITY_SCORE: Record<string, number> = { Extreme: 1.0, Severe: 0.75, Moderate: 0.5, Minor: 0.25, Unknown: 0.25 };

export interface IssuedAlert {
  event: string; severity: string; area: string; sent: string; effective: string; onset: string; expires: string; score: number;
}

export function parseAlerts(raw: string): IssuedAlert[] {
  const d = JSON.parse(raw) as { features?: unknown };
  if (!Array.isArray(d.features)) {
    throw unprocessable("NO_USABLE_ALERTS", "the NWS answer carried no feature collection; never guessed");
  }
  const out: IssuedAlert[] = [];
  for (const f of d.features as Record<string, unknown>[]) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const sev = String(p.severity ?? "Unknown");
    out.push({
      event: String(p.event ?? ""), severity: sev, area: String(p.areaDesc ?? ""),
      sent: String(p.sent ?? ""), effective: String(p.effective ?? ""),
      onset: String(p.onset ?? ""), expires: String(p.expires ?? ""),
      score: SEVERITY_SCORE[sev] ?? SEVERITY_SCORE.Unknown,
    });
  }
  return out;
}

export function riskLevel(score: number): string {
  return score >= 0.875 ? "SEVERE" : score >= 0.625 ? "HIGH" : score >= 0.375 ? "MODERATE" : "LOW";
}

/** Alerts active at `nowIso` whose expiry falls inside the window set the risk. */
export function assessAlerts(alerts: IssuedAlert[], nowIso: string, windowHours: number): { score: number; level: string; counted: IssuedAlert[]; excluded: IssuedAlert[] } {
  const now = Date.parse(nowIso);
  const horizon = now + windowHours * 3600_000;
  const counted: IssuedAlert[] = [];
  const excluded: IssuedAlert[] = [];
  for (const a of alerts) {
    const exp = Date.parse(a.expires);
    const ons = Date.parse(a.onset || a.effective || a.sent);
    const activeNow = (Number.isNaN(ons) || ons <= now) && (Number.isNaN(exp) || exp > now);
    if (activeNow && !Number.isNaN(exp) && exp <= horizon) counted.push(a);
    else excluded.push(a);
  }
  const score = counted.reduce((m, a) => Math.max(m, a.score), 0);
  return { score, level: riskLevel(score), counted, excluded };
}

export function parseLocation(raw: string | undefined): { lat: number; lon: number } {
  if (!raw) throw badRequest("MISSING_PARAM", "location is required as \"lat,lon\" decimal degrees, e.g. \"27.345,-97.225\"");
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) throw badRequest("BAD_LOCATION", "location must be \"lat,lon\" decimal degrees; place names are not geocoded in this slice");
  const lat = Number(m[1]); const lon = Number(m[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw badRequest("BAD_LOCATION", "latitude must be in [-90, 90], longitude in [-180, 180]");
  return { lat, lon };
}

async function fetchText(url: string, outerSignal?: AbortSignal): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: outerSignal ? AbortSignal.any([controller.signal,outerSignal]) : controller.signal, headers: { "User-Agent": UA, Accept: "application/geo+json" } });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

export const INTENT = "STORM_ALERT_GENERAL";

export async function handleStormAlert(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  query=queryFallback(query,"location",text=>text);
  // S1: "lat,lon" as before, or a place name through the geocoder (the
  // contract's "The place"). The resolved label is used in the answer.
  const rawLocation = query.location?.trim();
  let lat: number, lon: number, placeLabel: string;
  let geocoder: { url: string; body: string; selection: string } | null = null;
  if (rawLocation && !/^\s*-?\d{1,2}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?\s*$/.test(rawLocation)) {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(rawLocation)}&count=10&language=en&format=json`;
    let g: { status: number; body: string };
    try {
      g = await fetchText(geoUrl);
      if (g.status >= 400) throw new Error(`geocoder HTTP ${g.status}`);
    } catch {
      throw upstreamUnavailable("GEOCODER_UNREACHABLE", "the Open-Meteo geocoder could not be reached; pass \"lat,lon\" to skip geocoding");
    }
    let hit;
    try { hit = parseRankedLocation(g.body, "Open-Meteo"); }
    catch { throw upstreamUnavailable("GEOCODER_UNREACHABLE", "invalid top geocoder result; no guessed location"); }
    if (!hit) throw unprocessable("PLACE_NOT_FOUND", "city geocoder returned no location; pass lat,lon");
    lat = hit.latitude; lon = hit.longitude;
    placeLabel = `${hit.label} (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
    geocoder = { url: geoUrl, body: g.body, selection: `chose ${hit.label} at ${lat},${lon} of ${hit.count} matches returned (rank 1, provider order; not confirmed unique)` };
  } else {
    ({ lat, lon } = parseLocation(query.location));
    placeLabel = `${lat},${lon}`;
  }
  let windowHours = 24;
  if (query.window_hours !== undefined && query.window_hours.trim() !== "") {
    const w = Number(query.window_hours);
    if (!Number.isInteger(w) || w < 1 || w > 240) throw badRequest("BAD_WINDOW", "window_hours must be an integer in [1, 240]");
    windowHours = w;
  }
  const requestedAt = Date.now();
  const forecastInterval=forecastWindow(requestedAt,windowHours);
  const forecastUrl=stormForecastUrl(lat,lon,forecastInterval.start,forecastInterval.end);
  const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;
  const alertsUrl = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
  const nwsController=new AbortController();
  const readNws=async()=>{
    const points=await fetchText(pointsUrl,nwsController.signal);
    if(nwsController.signal.aborted)throw new Error("NWS deadline");
    if(points.status===404)return {available:false as const,reason:"outside NWS grid",points,alerts:null};
    if(points.status>=400)throw new Error("NWS coverage unavailable");
    const alerts=await fetchText(alertsUrl,nwsController.signal);if(alerts.status>=400)throw new Error("NWS alerts unavailable");
    return {available:true as const,reason:"available",points,alerts};
  };
  let nwsTimer: ReturnType<typeof setTimeout>;
  const nwsRead=Promise.race([readNws(),new Promise<never>((_,reject)=>{nwsTimer=setTimeout(()=>{nwsController.abort();reject(new Error("NWS optional deadline"));},4100);})]).finally(()=>clearTimeout(nwsTimer!));
  const [forecastResult,nwsResult]=await Promise.allSettled([readStormForecast(forecastUrl),nwsRead]);
  const capture=forecastResult.status==="fulfilled"?forecastResult.value:null;
  let forecast=null;
  if(capture){try {forecast=parseStormForecast(capture.raw,forecastInterval.start,forecastInterval.end);}catch { /* invalid forecast may not replace available NWS evidence */ }}
  const nowIso=new Date(requestedAt).toISOString();
  let alerts:IssuedAlert[]=[],nwsState=nwsResult.status==='fulfilled'?nwsResult.value.reason:'unavailable';
  if(nwsResult.status==='fulfilled'&&nwsResult.value.available){
    try{alerts=parseAlerts(nwsResult.value.alerts.body);}catch{nwsState='malformed alert response';}
  }
  if(!forecast&&nwsState!=="available")throw upstreamUnavailable("STORM_FORECAST_UNAVAILABLE","no valid forecast or available NWS alert evidence; no guessed LOW");
  const assessed=assessAlerts(alerts,nowIso,windowHours);
  const {counted,excluded}=assessed;
  const score=Math.max(forecast?.score??0,nwsState==='available'?assessed.score:0),level=riskLevel(score);
  const window=forecast?`${new Date(forecastInterval.start).toISOString()}/${new Date(forecastInterval.end).toISOString()}`:`${nowIso}/${new Date(requestedAt+windowHours*3600000).toISOString()}`;
  const fetchedAt=capture?.fetchedAt??new Date().toISOString();
  const evidence=JSON.stringify({location:`${lat},${lon}`,resolved_place:geocoder?placeLabel:'coordinates given directly',
    geocoder:geocoder?{url:geocoder.url,selection:geocoder.selection,raw_body:geocoder.body,sha256:sha256Hex(Buffer.from(geocoder.body))}:null,
    window_hours:windowHours,window,requested_at:nowIso,forecast,forecast_url:forecastUrl,
    forecast_acquired_at:capture?.fetchedAt??null,forecast_sha256:capture?sha256Hex(Buffer.from(capture.raw)):null,forecast_source_url:capture?.url??null,forecast_cache_policy:"0.01-degree quantized cache key, actual source URL and model grid retained; cache may reuse nearby request body up to 10 minutes",
    risk_mapping:STORM_HEURISTIC,nws_state:nwsState,nws_assessment:assessed,
    nws_window_policy:'unchanged: active now, expiry inside request-now plus window_hours; NWS products outside this policy are disclosed, not scored',
    raw_bodies:{forecast:capture?.raw??null,points:nwsResult.status==='fulfilled'?nwsResult.value.points.body:null,alerts:nwsResult.status==='fulfilled'?nwsResult.value.alerts?.body??null:null},
    source_policy:'Open-Meteo forecast model and optional NWS issued products; no official warning outside available NWS evidence',
    attribution:'Weather data by Open-Meteo, CC BY 4.0; hourly values aggregated and transformed by VeriReceipt heuristic',
    terms:{url:'https://open-meteo.com/en/terms',free_endpoint_commercial_use:false,scope:'evaluation/prototyping only; data licence does not grant unrestricted commercial API access'},fetched_at:fetchedAt});
  const receipt=makeReceipt(INTENT,forecast?capture!.url:alertsUrl,evidence,'aligned complete forecast hours, exact raw model bytes, disclosed heuristic and NWS availability');receipt.fetched_at=fetchedAt;
  try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
  const nwsText=nwsState==='available'?`NWS available: ${counted.length} scored issued products (${counted.map(a=>a.event+' ('+a.severity+'), expires '+a.expires).join('; ')||'none'}); ${excluded.length} products excluded under the unchanged expiry-inside-window policy.`:`NWS ${nwsState}; forecast-only result, this does not confirm absence of official warnings.`;
  const answerForecast=forecast?`Storm/weather-disruption risk ${level} (score ${score}) for ${placeLabel}. Forecast assessed aligned complete-hour window ${window}, starting at the next whole UTC hour (up to 59m59s after request), not partial current-hour weather. Peak gust ${forecast.peakGust} km/h, total precipitation ${forecast.precipitation} mm, maximum rolling-24h precipitation ${forecast.max24hPrecipitation} mm. ${STORM_HEURISTIC} ${nwsText} Weather data by Open-Meteo (CC BY 4.0), model grid ${forecast.grid.latitude},${forecast.grid.longitude}; not an official warning. Forecast acquired ${fetchedAt}. Nearby requests may reuse the same 0.01-degree cache cell for up to 10 minutes; actual source URL and grid retained.`:`Storm risk ${level} (score ${score}) for ${placeLabel}, window ${window}. Forecast unavailable or invalid; NWS-only result with peak gust and precipitation unknown, not zero. ${nwsText}`;
  const answer=answerForecast+(geocoder?` Location selection: ${geocoder.selection}. Geocoding: Open-Meteo / GeoNames (CC BY 4.0).`:'');
  return envelope(INTENT,{location:`${lat},${lon}`,risk_score:score,risk_level:level,window_hours:windowHours,window,
    peak_gust_kmh:forecast?.peakGust??null,precipitation_mm:forecast?.precipitation??null,max_rolling_24h_precipitation_mm:forecast?.max24hPrecipitation??null,forecast_status:forecast?"available":"unavailable",
    nws_status:nwsState,alerts:counted,alerts_beyond_window:excluded},receipt,{answer,verdict:'verified',confidence:nwsState==='available'?.9:.7,source:forecast?`${capture?.url}; Open-Meteo CC BY 4.0 model forecast, acquired ${fetchedAt}; NWS ${nwsState}`:`${alertsUrl}; NWS-only, forecast unavailable`});
}
