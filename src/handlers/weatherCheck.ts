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
// INPUT (ruling overturned 2026-11-23 via the audit; the contract reads
// "City or place name, or latitude,longitude"): location may be an
// explicit ICAO station code, "lat,lon" coordinates, or a place name.
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

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch {
    throw upstreamUnavailable("UPSTREAM_UNREACHABLE", `an upstream weather source could not be reached (${url.split("?")[0]})`);
  } finally {
    clearTimeout(timer);
  }
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
  let station = "";
  let candidates: { icaoId: string; distanceKm: number }[] = [];
  let resolved: { place: string; lat: number; lon: number; distanceKm: number; geocoder: { url: string; bodySha256: string } | null } | null = null;
  const coordMatch = LATLON_RE.exec(rawLocation);
  if (/^[A-Za-z][A-Za-z0-9]{3}$/.test(rawLocation) && !coordMatch) {
    station = rawLocation.toUpperCase();
  } else {
    // Coordinates directly, or a place name through the geocoder (same
    // fail-closed rules as the forecast slice: ambiguity refuses).
    let lat: number, lon: number, place: string;
    let geocoder: { url: string; bodySha256: string } | null = null;
    if (coordMatch) {
      lat = Number(coordMatch[1]); lon = Number(coordMatch[2]);
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw badRequest("BAD_LOCATION", "latitude must be in [-90, 90], longitude in [-180, 180]");
      place = `${lat.toFixed(4)}, ${lon.toFixed(4)} (coordinates given directly, not geocoded)`;
    } else {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(rawLocation)}&count=10&language=en&format=json`;
      const geoBody = await fetchText(geoUrl);
      const hit = resolveGeocode(geoBody, rawLocation);
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
      try {
        found = nearestMetarStations(boxBody, lat, lon);
        break;
      } catch (e) {
        if (e instanceof Error && "code" in e && (e as { code?: string }).code === "STATION_NOT_FOUND") continue;
        throw e;
      }
    }
    if (found === null) throw unprocessable("STATION_NOT_FOUND", `no METAR-reporting station found within about 4 degrees of ${place}; no temperature is guessed`);
    candidates = found;
    resolved = { place, lat, lon, distanceKm: found[0].distanceKm, geocoder };
  }

  // Fetch the observation. An explicit ICAO station is queried once, as
  // before. A resolved place tries the nearest METAR-flagged stations in
  // distance order (a directory entry can list METAR yet not report —
  // live: EGRB near London) and serves the first fresh parseable one.
  const tried: string[] = [];
  let obs: ReturnType<typeof parseMetar> | undefined;
  let body = "";
  let lastError: { code?: string } | null = null;
  const attemptOrder = candidates.length > 0 ? candidates.map((c) => c.icaoId) : [station];
  let winner: string | null = null;
  for (const id of attemptOrder) {
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
      lastError = { code: "NO_USABLE_OBSERVATION" };
      continue;
    }
  }
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
    throw unprocessable("NO_USABLE_OBSERVATION", `${station}: unusable observation`);
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
      geocoder: resolved.geocoder ? { url: resolved.geocoder.url, sha256: resolved.geocoder.bodySha256 } : "not used (coordinates given directly)" } : "not used (explicit ICAO station)",
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
    ? `For ${resolved.place}, the nearest reporting station is ${observation.station} (${observation.name}), ${resolved.distanceKm} km away. `
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
