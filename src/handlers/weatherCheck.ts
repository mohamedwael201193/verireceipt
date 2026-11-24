// WEATHER_CHECK_TEMPERATURE — GET /v1/weather-check?location=<ICAO>
//
// Zero-LLM. Current measured air temperature at an explicit ICAO
// station, with a SHA-256 receipt over the exact upstream body.
//
// Intent contract (read 2026-11-22): request location (string); scored
// temperature_c in [-90, 60].
//
// SOURCE: aviationweather.gov (NOAA) METAR station observations,
// keyless, the same measured pipeline /v1/weather uses, probed live
// 2026-11-23. Measured-only: the observation must be a METAR from the
// named station, at most 90 minutes old, never a forecast or model
// value (parseMetar enforces all three).
//
// INPUT: the intent contract reads "City or place name, or
// latitude,longitude". location may therefore be an explicit ICAO
// station code, "lat,lon" coordinates, or a place name.
// W1b: a purely alphabetic 4-letter token is tried as an ICAO station
// first and falls through to the geocoder when no such station reports.
// An EXACTLY-uppercase token is station-first with fall-through only;
// a Titlecase/lowercase token matching BOTH a reporting station and a
// geocoder place (Lima vs LIMA/Turin) refuses as ambiguous naming both
// sides, unless the geocoder hit sits within about 5 km of the station;
// "icao:XXXX" forces the station reading.
// Place names are geocoded with the same Open-Meteo geocoder and the
// same fail-closed rules as /v1/weather-forecast (named resolution,
// ambiguity refused, never a silent first hit); the nearest reporting
// station is then found through the aviationweather.gov stationinfo
// bounding box (the METAR endpoint itself has no working bbox) and the
// observation still comes from that station's own verified METAR. The
// answer always names the resolved place, the actual observing station
// and its distance caveat (an airport station is not the whole city).
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, sha256Hex } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { parseMetar } from "./weatherObservations";
import { haversineKm, resolveGeocode } from "./weatherForecast";

const SOURCE_TIMEOUT_MS = 10000;
const UA = "VeriReceipt/2.0 weather-check observer (+https://verireceipt.vercel.app)";

export const INTENT = "WEATHER_CHECK_TEMPERATURE";

// Per-origin ownership survives a caller timeout. No queue or duplicate hung reads.
const activeWeatherSources = new Map<string,number>();
export function resetWeatherSourcesForTests() { activeWeatherSources.clear(); }
async function readWeatherText(url: string, deadline: number): Promise<string> {
  const host=new URL(url).origin;
  if(Date.now()>=deadline || (activeWeatherSources.get(host)??0)>=4) throw upstreamUnavailable("UPSTREAM_UNREACHABLE","weather source unavailable within budget");
  activeWeatherSources.set(host,(activeWeatherSources.get(host)??0)+1);
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const io=(async()=>{
    try {
      const res=await fetch(url,{redirect:"error",signal:controller.signal,headers:{"User-Agent":UA,Accept:"application/json"}});
      if(!res.ok||!res.body)throw Error("weather source unavailable");
      const reader=res.body.getReader();const parts:Uint8Array[]=[];let size=0;
      while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2097152){void reader.cancel().catch(()=>{});throw Error("weather body limit");}parts.push(part.value);}
      return Buffer.concat(parts).toString("utf8");
    }finally{const left=(activeWeatherSources.get(host)??1)-1;if(left)activeWeatherSources.set(host,left);else activeWeatherSources.delete(host);}
  })();
  try {return await Promise.race([io,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error("weather source deadline"));},Math.max(0,Math.min(SOURCE_TIMEOUT_MS,deadline-Date.now())));})]);}
  catch {throw upstreamUnavailable("UPSTREAM_UNREACHABLE","weather source unavailable within budget");}
  finally{clearTimeout(timer);}
}

const LATLON_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

interface StationInfo { icaoId?: string; lat?: number; lon?: number; site?: string; siteType?: string[] }

/** Nearest METAR-reporting station to the coordinates, via the
 * stationinfo bounding box (widened until a station appears). Exported
 * for tests. */
export function nearestMetarStations(body: string, lat: number, lon: number, limit = 5): { icaoId: string; distanceKm: number }[] {
  let stations: StationInfo[];
  try {
    stations = JSON.parse(body);
  } catch {
    throw upstreamUnavailable("STATIONINFO_MALFORMED", "the station directory returned a body that is not JSON; refusing to guess a station");
  }
  if (!Array.isArray(stations)) {
    throw upstreamUnavailable("STATIONINFO_MALFORMED", "the station directory returned a non-array body; refusing to guess a station");
  }
  const hits: { icaoId: string; distanceKm: number }[] = [];
  for (const s of stations) {
    if (typeof s.icaoId !== "string" || typeof s.lat !== "number" || typeof s.lon !== "number") continue;
    if (!Array.isArray(s.siteType) || !s.siteType.includes("METAR")) continue;
    hits.push({ icaoId: s.icaoId, distanceKm: Math.round(haversineKm(lat, lon, s.lat, s.lon) * 10) / 10 });
  }
  hits.sort((a, b) => a.distanceKm - b.distanceKm);
  if (hits.length === 0) throw unprocessable("STATION_NOT_FOUND", `no METAR-reporting station found near ${lat.toFixed(3)}, ${lon.toFixed(3)}; no temperature is guessed`);
  return hits.slice(0, limit);
}

export async function handleWeatherCheck(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const rawLocation = query.location?.trim();
  if (!rawLocation) throw badRequest("MISSING_PARAM", "location is required: an ICAO station code, \"lat,lon\", or a place name");
  const sourceDeadline=Date.now()+9000;
  const fetchText=(url:string)=>readWeatherText(url,sourceDeadline);
  const locationText: string = rawLocation;
  let station = "";
  let candidates: { icaoId: string; distanceKm: number }[] = [];
  let resolved: { place: string; lat: number; lon: number; distanceKm: number; geocoder: { url: string; bodySha256: string } | null } | null = null;
  // W1b(b): every stationinfo bbox body fetched on a resolution path is
  // receipted by hash alongside the observation body.
  const stationInfoReceipts: { url: string; sha256: string }[] = [];
  const coordMatch = LATLON_RE.exec(rawLocation);
  // A 4-character alphanumeric token reads as an explicit ICAO station.
  // W1b(a): a purely ALPHABETIC 4-letter token is tried as a station
  // first and, when no such station reports, falls through to the
  // geocoder as a place name — "Rome", "Oslo" and "Lima" are places,
  // not stations. A station that EXISTS but serves an unusable
  // observation never falls through; that is an honest refusal.
  // W1c: an "icao:XXXX" prefix is the clearly-station form — it forces
  // the station path and skips the place-conflict check, because the
  // caller has already said which side they mean.
  const icaoPrefix = /^icao:([A-Za-z][A-Za-z0-9]{3})$/i.exec(rawLocation);
  const icaoForm = !!icaoPrefix || (/^[A-Za-z][A-Za-z0-9]{3}$/.test(rawLocation) && !coordMatch);
  const icaoFallthrough = !icaoPrefix && icaoForm && /^[A-Za-z]{4}$/.test(rawLocation);
  if (icaoForm) station = (icaoPrefix ? icaoPrefix[1] : rawLocation).toUpperCase();
  // Case rule: an EXACTLY-uppercase 4-letter token reads station-first
  // and falls through to a place name only when no station reports — no
  // dual-match check (KJFK, HECA serve their stations). A Titlecase or
  // lowercase token that matches both sides refuses as ambiguous.
  const exactUpper = /^[A-Z]{4}$/.test(rawLocation) && !icaoPrefix;
  let fellThroughFrom: string | null = null;

  interface Resolution {
    candidates: { icaoId: string; distanceKm: number }[];
    resolved: { place: string; lat: number; lon: number; distanceKm: number; geocoder: { url: string; bodySha256: string } | null };
  }
  // Coordinates directly, or a place name through the geocoder (same
  // fail-closed rules as the forecast slice: ambiguity refuses).
  async function resolveByPlaceOrCoords(): Promise<Resolution> {
    let lat: number, lon: number, place: string;
    let geocoder: { url: string; bodySha256: string } | null = null;
    if (coordMatch) {
      lat = Number(coordMatch[1]); lon = Number(coordMatch[2]);
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw badRequest("BAD_LOCATION", "latitude must be in [-90, 90], longitude in [-180, 180]");
      place = `${lat.toFixed(4)}, ${lon.toFixed(4)} (coordinates given directly, not geocoded)`;
    } else {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationText)}&count=10&language=en&format=json`;
      const geoBody = await fetchText(geoUrl);
      const hit = resolveGeocode(geoBody, locationText);
      lat = hit.latitude; lon = hit.longitude;
      place = `${hit.name}${hit.admin1 ? `, ${hit.admin1}` : ""}${hit.country ? `, ${hit.country}` : ""} (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
      geocoder = { url: geoUrl, bodySha256: sha256Hex(Buffer.from(geoBody, "utf8")) };
    }
    // stationinfo bbox, widened 0.75 -> 2 -> 4 degrees until a METAR
    // station appears (the METAR endpoint's own bbox returns nothing).
    let found: { icaoId: string; distanceKm: number }[] | null = null;
    for (const half of [0.75, 2, 4]) {
      const boxUrl = `https://aviationweather.gov/api/data/stationinfo?bbox=${(lat - half).toFixed(3)},${(lon - half).toFixed(3)},${(lat + half).toFixed(3)},${(lon + half).toFixed(3)}&format=json`;
      const boxBody = await fetchText(boxUrl);
      stationInfoReceipts.push({ url: boxUrl, sha256: sha256Hex(Buffer.from(boxBody, "utf8")) });
      try {
        found = nearestMetarStations(boxBody, lat, lon);
        break;
      } catch (e) {
        if (e instanceof Error && "code" in e && (e as { code?: string }).code === "STATION_NOT_FOUND") continue;
        throw e;
      }
    }
    if (found === null) throw unprocessable("STATION_NOT_FOUND", `no METAR-reporting station found within about 4 degrees of ${place}; no temperature is guessed`);
    return { candidates: found, resolved: { place, lat, lon, distanceKm: found[0].distanceKm, geocoder } };
  }

  if (!icaoForm) {
    const r = await resolveByPlaceOrCoords();
    candidates = r.candidates;
    resolved = r.resolved;
  }

  // Fetch the observation. An explicit ICAO station is queried once, as
  // before. A resolved place tries the nearest METAR-flagged stations in
  // distance order (a directory entry can list METAR yet not report —
  // live: EGRB near London) and serves the first fresh parseable one.
  // W1b(c): a parse failure keeps the parser's own reason string.
  interface Attempt {
    winner: string | null;
    obs: ReturnType<typeof parseMetar> | undefined;
    body: string;
    tried: string[];
    lastError: { code?: string; reason?: string } | null;
  }
  async function attempt(ids: string[]): Promise<Attempt> {
    const tried: string[] = [];
    let obs: ReturnType<typeof parseMetar> | undefined;
    let body = "";
    let lastError: { code?: string; reason?: string } | null = null;
    let winner: string | null = null;
    for (const id of ids) {
      tried.push(id);
      const metarUrl = `https://aviationweather.gov/api/data/metar?ids=${id}&format=json`;
      let text: string;
      try {
        text = await fetchText(metarUrl);
      } catch (e) {
        lastError = e as { code?: string };
        continue;
      }
      if (text.trim() === "" || text.trim() === "[]") {
        lastError = { code: "STATION_NOT_FOUND" };
        continue;
      }
      try {
        obs = parseMetar(text, id);
        body = text;
        winner = id;
        lastError = null;
        break;
      } catch (e) {
        lastError = { code: "NO_USABLE_OBSERVATION", reason: e instanceof Error ? e.message : String(e) };
        continue;
      }
    }
    return { winner, obs, body, tried, lastError };
  }

  let run = await attempt(candidates.length > 0 ? candidates.map((c) => c.icaoId) : [station]);
  if (run.winner !== null && icaoFallthrough && !exactUpper) {
    // Dual-match check (Titlecase/lowercase tokens only): the token
    // matched a reporting ICAO station. If a geocoder place also
    // matches (Lima, Peru vs station LIMA in Turin), serving either
    // side silently risks the wrong place — refuse and name both, with
    // the unambiguous forms the caller can use instead. Exception: a
    // geocoder hit within about 5 km of the station is the same place,
    // so the station serves.
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationText)}&count=10&language=en&format=json`;
    const geoBody = await fetchText(geoUrl);
    let placeLabel: string | null = null;
    let placeHit: { latitude: number; longitude: number } | null = null;
    let placeAmbiguous = false;
    try {
      const hit = resolveGeocode(geoBody, locationText);
      placeHit = hit;
      placeLabel = `${hit.name}${hit.admin1 ? `, ${hit.admin1}` : ""}${hit.country ? `, ${hit.country}` : ""} (${hit.latitude}, ${hit.longitude})`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "PLACE_NOT_FOUND") {
        placeLabel = null; // No place by that name: the station reading is unambiguous.
      } else if (code === "AMBIGUOUS_LOCATION") {
        placeAmbiguous = true;
      } else {
        throw e;
      }
    }
    if (placeLabel !== null && placeHit && haversineKm(run.obs!.latitude, run.obs!.longitude, placeHit.latitude, placeHit.longitude) <= 5) {
      placeLabel = null; // The geocoder hit is the station's own place.
    }
    if (placeLabel !== null) {
      throw unprocessable("AMBIGUOUS_LOCATION",
        `"${locationText}" matches both a reporting ICAO station (${run.obs!.station} — ${run.obs!.name}, ${run.obs!.latitude}, ${run.obs!.longitude}) and the place ${placeLabel}; no temperature is guessed. For the station pass "icao:${station}"; for the place pass "place, country"`);
    }
    if (placeAmbiguous) {
      throw unprocessable("AMBIGUOUS_LOCATION",
        `"${locationText}" matches both a reporting ICAO station (${run.obs!.station} — ${run.obs!.name}) and several places by that name; no temperature is guessed. For the station pass "icao:${station}"; for a place pass "place, country"`);
    }
  }
  if (run.winner === null && icaoFallthrough && run.lastError && run.lastError.code === "STATION_NOT_FOUND") {
    // No station by that code reports: read the token as a place name.
    fellThroughFrom = station;
    const r = await resolveByPlaceOrCoords();
    candidates = r.candidates;
    resolved = r.resolved;
    run = await attempt(candidates.map((c) => c.icaoId));
  }

  const { winner, tried, lastError } = run;
  let obs = run.obs;
  let body = run.body;
  if (winner === null) {
    if (lastError && lastError.code === "UPSTREAM_UNREACHABLE") {
      throw upstreamUnavailable("METAR_UNREACHABLE", "the aviationweather.gov METAR feed could not be reached");
    }
    if (candidates.length > 0) {
      throw unprocessable("NO_USABLE_OBSERVATION",
        `none of the ${tried.length} nearest METAR-flagged stations for ${resolved!.place} served a fresh usable observation (tried in order: ${tried.join(", ")}); no temperature is guessed`);
    }
    if (lastError && lastError.code === "STATION_NOT_FOUND") {
      throw unprocessable("STATION_NOT_FOUND", `no METAR for ${station}; the station may not exist or may not report — no temperature is guessed`);
    }
    throw unprocessable("NO_USABLE_OBSERVATION", `${station}: unusable observation (${lastError?.reason ?? "unknown reason"})`);
  }
  station = winner;
  const observation = obs!;
  if (resolved) resolved.distanceKm = candidates.find((c) => c.icaoId === winner)!.distanceKm;
  const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json`;
  const fetchedAt = new Date().toISOString();
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ station, as_of: asOf, observation,
    resolved: resolved ? { place: resolved.place, latitude: resolved.lat, longitude: resolved.lon,
      station_distance_km: resolved.distanceKm,
      geocoder: resolved.geocoder ? { url: resolved.geocoder.url, sha256: resolved.geocoder.bodySha256 } : "not used (coordinates given directly)",
      station_directory: stationInfoReceipts.length > 0 ? stationInfoReceipts : "not fetched" } : "not used (explicit ICAO station)",
    icao_fallthrough: fellThroughFrom ? `no reporting station ${fellThroughFrom}; the token was then read as a place name` : "not used",
    source_policy: "NOAA aviationweather.gov measured METAR only; max age 90 minutes; station identity verified against the raw observation; never a forecast or model value",
    raw_bodies: { metar: body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, url, evidence, "NOAA measured METAR, station-verified, 90-minute freshness");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const prefix = resolved
    ? `${fellThroughFrom ? `No reporting station ${fellThroughFrom} — reading it as a place name. ` : ""}For ${resolved.place}, the nearest reporting station is ${observation.station} (${observation.name}), ${resolved.distanceKm} km away. `
    : "";
  const answer =
    prefix +
    `Measured temperature ${observation.temperatureC} C at ${observation.station} (${observation.name}, ${observation.latitude}, ${observation.longitude}), observed ${observation.observedAt}. ` +
    `This is a measured METAR station observation (raw: ${observation.rawObservation}), at most 90 minutes old — an airport station's reading, not a city-wide value, and never a forecast.`;
  return envelope(INTENT, {
    temperature_c: observation.temperatureC,
    location: station,
    station_name: observation.name,
    latitude: observation.latitude,
    longitude: observation.longitude,
    observed_at: observation.observedAt,
    ...(resolved ? { resolved_place: resolved.place, station_distance_km: resolved.distanceKm } : {}),
  }, receipt, { answer, verdict: "verified", confidence: 0.95,
    source: `${url}; NOAA measured METAR, station-verified; fetched ${fetchedAt}` });
}
