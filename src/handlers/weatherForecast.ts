import {forecastExtras} from './forecastExtras';
import {readMetForecast,compareMetForecast} from './metForecast';
// WEATHER_FORECAST_GENERAL — GET /v1/weather-forecast?location=<place|lat,lon>&window_hours=<1-240>
//
// Zero-LLM. A forecast HIGH/LOW temperature, peak precipitation
// probability and dominant condition over a forward window, with a
// SHA-256 receipt over the exact upstream bodies.
//
// Intent contract (read 2026-11-23): request location (string, "City
// or place name"), window_hours (integer 1..240, default 24); scored
// temp_max_c in [-90, 60]; judgment class.
//
// Place names use the provider's rank-1 result, with chosen coordinates,
// match count and non-unique selection disclosed. Explicit coordinates
// bypass geocoding. A missing or malformed top result is never guessed.
//
// SOURCES (both keyless, probed live 2026-11-23):
//   1. Open-Meteo geocoder (geocoding-api.open-meteo.com/v1/search)
//   2. Open-Meteo forecast (api.open-meteo.com/v1/forecast), hourly
//      temperature_2m, precipitation_probability, weather_code,
//      timezone=auto so the window is local to the place.
//
// HONESTY: this is a numerical weather prediction MODEL forecast
// (Open-Meteo best-match), not a measurement, and a single model with
// no ensemble spread — the answer says so. The window is sliced from
// the current local hour; a window the upstream arrays do not cover is
// refused, never extrapolated. FAIL CLOSED on any upstream failure,
// truncation or null-filled window.
import { parseRankedLocation } from "./routeGeocoder";
import { ApiError, badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, sha256Hex } from "../core/receipt";
import { saveReceipt } from "../core/storage";

import {readForecastSource,rememberForecastSource} from './forecastSourceCache';

export const INTENT = "WEATHER_FORECAST_GENERAL";

const WMO_CONDITIONS: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "depositing rime fog",
  51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
  56: "light freezing drizzle", 57: "dense freezing drizzle",
  61: "slight rain", 63: "moderate rain", 65: "heavy rain",
  66: "light freezing rain", 67: "heavy freezing rain",
  71: "slight snow", 73: "moderate snow", 75: "heavy snow", 77: "snow grains",
  80: "slight rain showers", 81: "moderate rain showers", 82: "violent rain showers",
  85: "slight snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with slight hail", 99: "thunderstorm with heavy hail",
};

interface GeoHit { name: string; latitude: number; longitude: number; country?: string; admin1?: string; country_code?: string; timezone?: string; selection?: string }

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Resolve provider rank 1 and disclose its limits. Exported for tests. */
export function resolveGeocode(body: string, queried: string): GeoHit {
  let ranked;
  try { ranked = parseRankedLocation(body, "Open-Meteo"); }
  catch { throw upstreamUnavailable("GEOCODER_MALFORMED", "the geocoder returned an invalid top result; refusing to guess a location"); }
  if (!ranked) throw unprocessable("PLACE_NOT_FOUND", `no place matching "${queried}"; qualify the name or pass "lat,lon"`);
  const top = JSON.parse(body).results[0] as GeoHit;
  return { ...top, selection: `chose ${ranked.label} at ${ranked.latitude},${ranked.longitude} of ${ranked.count} matches returned (rank 1, provider order; not confirmed unique)` };
}

function dominantCondition(codes: number[]): string {
  const counts = new Map<number, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best = codes[0], bestN = 0;
  for (const [code, n] of counts) {
    if (n > bestN || (n === bestN && code > best)) { best = code; bestN = n; }
  }
  return WMO_CONDITIONS[best] ?? `WMO weather code ${best}`;
}

export async function handleWeatherForecast(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const location = query.location?.trim();
  if (!location) throw badRequest("MISSING_PARAM", "location is required: a city or place name (provider-ranked selection is disclosed), or \"lat,lon\"");
  if (Buffer.byteLength(location, "utf8") > 256) throw badRequest("INVALID_LOCATION", "location is over 256 UTF-8 bytes");
  let windowHours = 24;
  if (query.window_hours !== undefined && query.window_hours !== "") {
    if (!/^\d+$/.test(query.window_hours.trim())) throw badRequest("INVALID_WINDOW", "window_hours must be an integer between 1 and 240");
    windowHours = Number(query.window_hours.trim());
    if (windowHours < 1 || windowHours > 240) throw badRequest("INVALID_WINDOW", "window_hours must be between 1 and 240 hours");
  }

  // Resolve the location: direct coordinates, or the keyless geocoder.
  let locationSelection: string | null = null;
  let lat: number, lon: number, resolvedName: string, geoBody: string | null = null, geoUrl: string | null = null;
  const ll = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(location);
  if (ll) {
    lat = Number(ll[1]); lon = Number(ll[2]);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw badRequest("INVALID_LOCATION", "lat,lon out of range (lat -90..90, lon -180..180)");
    resolvedName = `${lat.toFixed(4)}, ${lon.toFixed(4)} (coordinates given directly, not geocoded)`;
  } else {
    const geocode = async (name: string): Promise<{ url: string; body: string; fetchedAt:string }> => {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
      try { const entry=await readForecastSource('geocode',url);return {url,...entry}; }
      catch { throw upstreamUnavailable('UPSTREAM_UNREACHABLE','Open-Meteo geocode source unavailable'); }
    };
    const nameOf = (hit: GeoHit) =>
      `${hit.name}${hit.admin1 ? `, ${hit.admin1}` : ""}${hit.country ? `, ${hit.country}` : ""} (${hit.latitude.toFixed(4)}, ${hit.longitude.toFixed(4)})`;
    let resolved: { lat: number; lon: number; name: string } | null = null;
    let notFound: ApiError | null = null;
    let first: Awaited<ReturnType<typeof geocode>>;
    try { first=await geocode(location); } catch { throw upstreamUnavailable('UPSTREAM_UNREACHABLE','Open-Meteo geocode source unavailable'); }
    try {
      const hit = resolveGeocode(first.body, location);
      rememberForecastSource('geocode',first.url,first);
      geoUrl = first.url; geoBody = first.body; locationSelection = hit.selection!;
      resolved = { lat: hit.latitude, lon: hit.longitude, name: nameOf(hit) };
    } catch (e) {
      if (e instanceof ApiError && e.code === "PLACE_NOT_FOUND") notFound = e;
      else throw e;
    }
    if (!resolved && notFound && /\s/.test(location)) {
      // A space-separated "City Country" without the comma defeats the
      // geocoder's literal search. Retry with the trailing tokens as a
      // country qualifier against a fresh city search. Select rank1 among
      // matching-country results, disclosing the remaining ambiguity.
      const tokens = location.split(/\s+/);
      for (let hintLen = 1; hintLen <= Math.min(3, tokens.length - 1) && !resolved; hintLen++) {
        const city = tokens.slice(0, tokens.length - hintLen).join(" ");
        const hint = tokens.slice(tokens.length - hintLen).join(" ").toLowerCase();
        const retry = await geocode(city);
        let hits: GeoHit[];
        try {
          hits = ((JSON.parse(retry.body) as { results?: GeoHit[] }).results ?? []);
        } catch {
          throw upstreamUnavailable("GEOCODER_MALFORMED", "the geocoder returned a body that is not JSON; refusing to guess a location");
        }
        const matches = hits.filter((r) =>
          (r.country ?? "").toLowerCase() === hint || (r.country_code ?? "").toLowerCase() === hint);
        if (matches.length > 0) {
          const selected = resolveGeocode(JSON.stringify({ results: matches }), location);
          rememberForecastSource('geocode',retry.url,retry);
          locationSelection = `chose ${selected.name} at ${selected.latitude},${selected.longitude}; rank 1 among ${matches.length} country-matching results for "${hint}" (${hits.length} total upstream matches; provider order within country filter; not confirmed unique)`;
          geoUrl = retry.url; geoBody = retry.body;
          resolved = { lat: matches[0].latitude, lon: matches[0].longitude, name: nameOf(matches[0]) };
        }
      }
    }
    if (!resolved) throw notFound ?? new Error("geocode resolution failed");
    lat = resolved.lat; lon = resolved.lon; resolvedName = resolved.name;
  }

  // One extra day beyond the bare window: forecast_days=1 returns only
  // today's 24 local hours (00:00-23:00), so a window starting at any
  // local hour after 00:00 needs hours from the following day(s).
  const forecastDays = Math.min(16, Math.ceil(windowHours / 24) + 1);
  const fcUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation_probability,weather_code,precipitation,wind_speed_10m,wind_gusts_10m,cloud_cover,relative_humidity_2m&forecast_days=${forecastDays}&timezone=auto`;
  let fcEntry: {body:string;fetchedAt:string};
  try { fcEntry=await readForecastSource('forecast',fcUrl); }
  catch { throw upstreamUnavailable('UPSTREAM_UNREACHABLE','Open-Meteo forecast source unavailable'); }
  const fcBody=fcEntry.body;

  interface FcBody { utc_offset_seconds?: number; timezone?: string; timezone_abbreviation?: string; latitude?: number; longitude?: number;
    hourly_units?: {time?:string;temperature_2m?:string;precipitation_probability?:string;weather_code?:string};
    hourly?: { time?: string[]; temperature_2m?: (number | null)[]; precipitation_probability?: (number | null)[]; weather_code?: (number | null)[] } }
  let fc: FcBody;
  try {
    fc = JSON.parse(fcBody);
  } catch {
    throw upstreamUnavailable("FORECAST_MALFORMED", "the forecast API returned a body that is not JSON; refusing to answer");
  }
  const h = fc.hourly as (NonNullable<FcBody["hourly"]>&Record<string,unknown>)|undefined;
  if (!h?.time?.length || !h.temperature_2m || h.time.length !== h.temperature_2m.length) {
    throw upstreamUnavailable("FORECAST_MALFORMED", "the forecast body is missing aligned hourly arrays; refusing to answer from a partial view");
  }
  if(fc.hourly_units?.time!=='iso8601'||fc.hourly_units.temperature_2m!=='°C'||fc.hourly_units.precipitation_probability!=='%'||fc.hourly_units.weather_code!=='wmo code')
    throw upstreamUnavailable('FORECAST_MALFORMED','forecast units do not match the requested Celsius, percentage and WMO hourly fields');
  if(typeof fc.utc_offset_seconds!=='number'||!Number.isInteger(fc.utc_offset_seconds)||Math.abs(fc.utc_offset_seconds)>14*3600)
    throw upstreamUnavailable('FORECAST_MALFORMED','forecast UTC offset is missing or invalid');
  const offsetSec = fc.utc_offset_seconds;
  const tzName = fc.timezone ?? "UTC", tzAbbr = fc.timezone_abbreviation ?? "UTC";
  // Current local hour at the place, as the upstream formats it.
  const localNow = new Date(Date.now() + offsetSec * 1000);
  const localHour = localNow.toISOString().slice(0, 13) + ":00";
  const startIdx = h.time.findIndex((t) => t === localHour);
  if (startIdx < 0) {
    throw unprocessable("FORECAST_WINDOW_UNCOVERED", `the forecast starts after the window or the place's current hour (${localHour} ${tzAbbr}) is beyond the retrieved range; nothing is extrapolated`);
  }
  const endIdx = startIdx + windowHours;
  if (endIdx > h.time.length) {
    throw unprocessable("FORECAST_WINDOW_UNCOVERED",
      `only ${h.time.length - startIdx} of the requested ${windowHours} hours are covered by the retrieved forecast (${h.time[startIdx]} to ${h.time[h.time.length - 1]} ${tzAbbr}); the window is refused, not extrapolated`);
  }
  const times = h.time.slice(startIdx, endIdx);
  const localStart=Date.parse(localHour+':00Z');
  if(times.some((t,i)=>typeof t!=='string'||t!==new Date(localStart+i*3600000).toISOString().slice(0,16)))
    throw upstreamUnavailable('FORECAST_MALFORMED','requested hourly window has gaps, duplicates or invalid local times');
  const temps = h.temperature_2m.slice(startIdx,endIdx);
  if(temps.length!==windowHours||temps.some(t=>typeof t!=='number'||!Number.isFinite(t)||t< -90||t>60))
    throw upstreamUnavailable('FORECAST_MALFORMED','requested hourly temperature window is incomplete or invalid; full-window extrema are not inferred');
  const tempMax = Math.max(...temps as number[]), tempMin = Math.min(...temps as number[]);
  const precipRaw = (h.precipitation_probability ?? []).slice(startIdx,endIdx);
  if(precipRaw.length!==windowHours||precipRaw.some(p=>typeof p!=='number'||!Number.isFinite(p)||p<0||p>100))
    throw upstreamUnavailable('FORECAST_MALFORMED','requested precipitation-probability window is incomplete or invalid');
  const precipVals=precipRaw as number[];
  const precipPeak=Math.max(...precipVals);
  const codesRaw=(h.weather_code ?? []).slice(startIdx,endIdx);
  if(codesRaw.length!==windowHours||codesRaw.some(c=>typeof c!=='number'||!Number.isInteger(c)||!Object.hasOwn(WMO_CONDITIONS,c)))
    throw upstreamUnavailable('FORECAST_MALFORMED','requested WMO weather-code window is incomplete or invalid');
  const codes=codesRaw as number[];
  const condition=dominantCondition(codes);
  rememberForecastSource('forecast',fcUrl,fcEntry);
  const extras=forecastExtras(h,fc.hourly_units as Record<string,unknown>,startIdx,times,temps as number[],precipVals);
  let second:{url:string;body:string;fetchedAt:string}|undefined;let comparison:Record<string,unknown>;
  try{second=await readMetForecast(lat,lon);const utcHours=times.map(t=>new Date(Date.parse(t+':00Z')-offsetSec*1000).toISOString());comparison=compareMetForecast(second.body,lat,lon,utcHours,temps as number[]);}catch{comparison={status:'unavailable',models:['Open-Meteo best-match'],note:'Met.no independent forecast unavailable or unaligned; primary model only, no two-model agreement claimed'};}
  const asOf = fcEntry.fetchedAt;
  const when = `${times[0]} to ${times[times.length - 1]} ${tzAbbr} (${windowHours}h window)`;

  const evidence = JSON.stringify({
    location_queried: location, resolved: resolvedName, location_selection: locationSelection, grid_point: { latitude: fc.latitude, longitude: fc.longitude },
    window_hours: windowHours, when, timezone: tzName,
    temp_max_c: tempMax, temp_min_c: tempMin,
    precipitation_probability_pct: precipPeak, precip_hours_reporting: precipVals.length,
    condition,extras,model_comparison:comparison,secondary_upstream:second??null,
    method: "Open-Meteo best-match NWP model forecast (primary model, no ensemble spread), hourly values sliced from the current local hour; NOT a measurement",
    geocode_upstream: geoUrl ? { url: geoUrl, raw_body: geoBody, sha256: sha256Hex(Buffer.from(geoBody!, "utf8")) } : "not used (coordinates given directly)",
    forecast_upstream: { url: fcUrl, raw_body: fcBody, sha256: sha256Hex(Buffer.from(fcBody, "utf8")) },
    fetched_at: asOf,
  });
  const receipt = makeReceipt(INTENT, fcUrl, evidence, "primary model hourly arrays and independent secondary-model comparison when available; exact bodies and geocoder retained");
  receipt.fetched_at = asOf;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer =
    `Forecast for ${resolvedName}, ${when}: high ${tempMax}°C, low ${tempMin}°C, ` +
    (precipPeak !== null ? `peak precipitation chance ${precipPeak}%, ` : "no precipitation-probability data in the window, ") +
    `dominant condition: ${condition}. ` +
    `Peak precipitation probability hour: ${extras.precipitation_probability_peak_hour} ${tzAbbr}. Additional weather extrema and first/next/last12h buckets are in the structured fields; absent fields are null. ${comparison.status==='available'?`Two models compared (Open-Meteo best-match and Met.no Locationforecast): ${comparison.compared_hours}/${comparison.requested_hours} aligned hours, maximum hourly temperature difference ${comparison.max_hourly_temperature_difference_c}°C; ${comparison.temperature_agreement}. Primary values remain Open-Meteo, not an average.`:`This is a single-model numerical forecast (Open-Meteo best-match); Met.no independent forecast unavailable or unaligned.`} Numerical forecast for ${tzName}, not a measurement, and carries no ensemble spread.${locationSelection ? " Location selection: " + locationSelection + ". Geocoding: Open-Meteo / GeoNames (CC BY 4.0)." : ""}`;
  return envelope(INTENT, {
    location: resolvedName,
    when,
    temp_max_c: tempMax,
    temp_min_c: tempMin,
    precipitation_probability_pct: precipPeak,
    condition,...extras,model_comparison:comparison,
    timezone: tzName,
    summary: `${resolvedName}: ${tempMin}–${tempMax}°C, ${condition}${precipPeak !== null ? `, ${precipPeak}% peak precip chance` : ""} over the next ${windowHours}h (model forecast, not measured).`,
  }, receipt, { answer, verdict: "verified", confidence: 0.85,
    source: `${geoUrl ? `Open-Meteo geocoder ${geoUrl}; ` : "coordinates given directly; "}Open-Meteo forecast ${fcUrl} (fetched ${asOf}, model forecast, not a measurement)` });
}
