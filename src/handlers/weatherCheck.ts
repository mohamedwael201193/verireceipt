// WEATHER_CHECK_TEMPERATURE — GET /v1/weather-check?location=<ICAO>
//
// Zero-LLM. Current measured air temperature at an explicit ICAO
// station, with a SHA-256 receipt over the exact upstream body.
//
// Intent contract (read 2026-11-22): request location (string); scored
// temp_c in [-90, 60].
//
// SOURCE: aviationweather.gov (NOAA) METAR station observations,
// keyless, the same measured pipeline /v1/weather uses, probed live
// 2026-11-23. Measured-only: the observation must be a METAR from the
// named station, at most 90 minutes old, never a forecast or model
// value (parseMetar enforces all three).
//
// INPUT (maintainer ruling 2026-11-23): location must be an explicit
// ICAO station code; place names are refused, never geocoded. The
// answer always names the actual observing station and its distance
// caveat (an airport station is not the whole city).
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { parseMetar } from "./weatherObservations";

const SOURCE_TIMEOUT_MS = 10000;
const UA = "VeriReceipt/2.0 weather-check observer (+https://verireceipt.vercel.app)";

export const INTENT = "WEATHER_CHECK_TEMPERATURE";

export async function handleWeatherCheck(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const station = query.location?.trim().toUpperCase();
  if (!station) throw badRequest("MISSING_PARAM", "location is required as an explicit ICAO station code, e.g. HECA");
  if (!/^[A-Z][A-Z0-9]{3}$/.test(station)) {
    throw badRequest("ICAO_REQUIRED", "location must be an explicit four-character ICAO station code; place names are never geocoded in this slice");
  }
  const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json`;
  const fetchedAt = new Date().toISOString();
  let body: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw upstreamUnavailable("METAR_UNREACHABLE", "the aviationweather.gov METAR feed could not be reached");
  }
  if (body.trim() === "" || body.trim() === "[]") {
    throw unprocessable("STATION_NOT_FOUND", `no METAR for ${station}; the station may not exist or may not report — no temperature is guessed`);
  }
  let obs;
  try {
    obs = parseMetar(body, station);
  } catch (e) {
    throw unprocessable("NO_USABLE_OBSERVATION", `${station}: ${e instanceof Error ? e.message : "unusable observation"}`);
  }
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ station, as_of: asOf, observation: obs,
    source_policy: "NOAA aviationweather.gov measured METAR only; max age 90 minutes; station identity verified against the raw observation; never a forecast or model value",
    raw_bodies: { metar: body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, url, evidence, "NOAA measured METAR, station-verified, 90-minute freshness");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer =
    `Measured temperature ${obs.temperatureC} C at ${obs.station} (${obs.name}, ${obs.latitude}, ${obs.longitude}), observed ${obs.observedAt}. ` +
    `This is a measured METAR station observation (raw: ${obs.rawObservation}), at most 90 minutes old — an airport station's reading, not a city-wide value, and never a forecast.`;
  return envelope(INTENT, {
    temp_c: obs.temperatureC,
    location: station,
    station_name: obs.name,
    latitude: obs.latitude,
    longitude: obs.longitude,
    observed_at: obs.observedAt,
  }, receipt, { answer, verdict: "verified", confidence: 0.95,
    source: `${url}; NOAA measured METAR, station-verified; fetched ${fetchedAt}` });
}
