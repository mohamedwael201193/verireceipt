// AIR_QUALITY_INDEX_GENERAL — GET /v1/air-quality?lat=<deg>&lon=<deg>
//
// Zero-LLM. Serves the current air-quality index for coordinates, with a
// SHA-256 receipt over the exact upstream response body.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/AIR_QUALITY_INDEX_GENERAL,
// read 2026-11-22): registered bootstrap intent with no response format
// yet; the family shape is coordinates in, current AQI out.
//
// SOURCE: Open-Meteo air-quality API (air-quality-api.open-meteo.com),
// keyless, non-commercial terms, probed live 2026-11-23. Single source,
// honestly named.
//
// Only the current block is returned. It is a CAMS model-derived current
// estimate, not a measured station observation. Forecast-model data can
// underlie the current estimate. The grid cell and interval are disclosed.
// https://open-meteo.com/en/docs/air-quality-api
// Local validity policy: UTC current interval <=1h, age <=3h, future skew
// <=5min, grid center <=100km from the explicit coordinates. These bounds
// reject stale/mismatched evidence; they are not provider accuracy claims.
//
// The local boolean is `acceptable`: US AQI at or below 100 (US EPA
// "moderate or better" band). The AQI value itself and the pollutant
// concentrations are served as numbers with their units named.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { readPublicBody } from "../core/publicSource";

const SOURCE_TIMEOUT_MS = 6000;

/** US AQI at or below this is EPA "moderate or better". */
const ACCEPTABLE_US_AQI = 100;

function parseCoord(raw: string | undefined, name: "lat" | "lon", min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") throw badRequest("MISSING_PARAM", `${name} is required (decimal degrees)`);
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    throw badRequest("BAD_COORDINATE", `${name} must be a number in [${min}, ${max}]`);
  }
  return v;
}

export interface AirQualityReading {
  us_aqi: number;
  european_aqi: number | null;
  pm2_5: number | null;
  pm10: number | null;
  nitrogen_dioxide: number | null;
  ozone: number | null;
  carbon_monoxide: number | null;
  time: string;
  interval_seconds: number;
  grid_latitude: number;
  grid_longitude: number;
}

export function parseAirQuality(raw: string, expected?: { lat: number; lon: number }): AirQualityReading {
  const d = JSON.parse(raw) as Record<string, unknown>;
  const cur = d.current as Record<string, unknown> | undefined;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const us = num(cur?.us_aqi);
  if (us === null || !cur) {
    throw unprocessable("NO_USABLE_AQI", "the upstream answer carried no current US AQI; never guessed");
  }
  const latitude = num(d.latitude), longitude = num(d.longitude);
  const time = cur.time;
  const stamp = typeof time === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time) ? Date.parse(time + "Z") : NaN;
  const validStamp = Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,16) === time;
  const interval = num(cur.interval);
  const units = d.current_units as Record<string, unknown> | undefined;
  const pollutants = ["pm2_5", "pm10", "nitrogen_dioxide", "ozone", "carbon_monoxide"];
  if (us < 0 || latitude === null || Math.abs(latitude) > 90 || longitude === null || Math.abs(longitude) > 180 ||
      !validStamp || Date.now() - stamp > 3 * 3600_000 || stamp > Date.now() + 300_000 ||
      d.utc_offset_seconds !== 0 || interval === null || interval <= 0 || interval > 3600 || units?.us_aqi !== "USAQI" ||
      (cur.european_aqi != null && (num(cur.european_aqi) === null || Number(cur.european_aqi) < 0)) ||
      pollutants.some(key => cur[key] != null && (num(cur[key]) === null || Number(cur[key]) < 0 || units?.[key] !== "μg/m³"))) {
    throw unprocessable("INVALID_AQI_OBSERVATION", "invalid, stale, future-dated or wrong-unit current model observation");
  }
  if (expected) {
    const radians = (n: number) => n * Math.PI / 180;
    const deltaLat = radians(latitude - expected.lat), deltaLon = radians(longitude - expected.lon);
    const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(expected.lat)) * Math.cos(radians(latitude)) * Math.sin(deltaLon / 2) ** 2;
    if (6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))) > 100)
      throw unprocessable("AQI_GRID_MISMATCH", "returned model grid cell is over 100 km from requested coordinates");
  }
  return {
    us_aqi: us,
    european_aqi: num(cur.european_aqi),
    pm2_5: num(cur.pm2_5),
    pm10: num(cur.pm10),
    nitrogen_dioxide: num(cur.nitrogen_dioxide),
    ozone: num(cur.ozone),
    carbon_monoxide: num(cur.carbon_monoxide),
    time: time as string,
    interval_seconds: interval,
    grid_latitude: latitude,
    grid_longitude: longitude,
  };
}

export const INTENT = "AIR_QUALITY_INDEX_GENERAL";

export async function handleAirQuality(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const lat = parseCoord(query.lat, "lat", -90, 90);
  const lon = parseCoord(query.lon, "lon", -180, 180);
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&current=us_aqi,european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone&timezone=UTC`;
  const fetchedAt = new Date().toISOString();
  let body: string;
  try {
    body = (await readPublicBody(url, 64_000, SOURCE_TIMEOUT_MS)).raw;
  } catch {
    throw upstreamUnavailable("OPEN_METEO_UNREACHABLE", "the Open-Meteo air-quality API could not be reached");
  }
  const r = parseAirQuality(body, { lat, lon });
  const acceptable = r.us_aqi <= ACCEPTABLE_US_AQI;
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ lat, lon, as_of: asOf, reading: r, acceptable,
    source_policy: "Open-Meteo air-quality current block only; model blend at nearest grid cell, model-derived current estimate, not a measured station value, never a ground-station claim",
    raw_bodies: { current: body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, url, evidence, "Open-Meteo single source; current block only");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer =
    `Current US AQI ${r.us_aqi} (EPA scale) at grid cell ${r.grid_latitude}, ${r.grid_longitude}` +
    ` (nearest cell to ${lat}, ${lon}), upstream hour ${r.time}Z — ${acceptable ? "acceptable (at or below 100, EPA moderate or better)" : "above 100 (unhealthy for sensitive groups or worse)"}.` +
    ` PM2.5 ${r.pm2_5 ?? "n/a"} µg/m³, PM10 ${r.pm10 ?? "n/a"} µg/m³, NO2 ${r.nitrogen_dioxide ?? "n/a"} µg/m³, O3 ${r.ozone ?? "n/a"} µg/m³.` +
    ` These are Open-Meteo modelled current conditions (CAMS blend) at the returned grid cell, interval ${r.interval_seconds} seconds, not a ground-station measurement. This current estimate may be derived from model output.`;
  return envelope(INTENT, {
    aqi: r.us_aqi,
    aqi_scale: "US EPA",
    acceptable,
    european_aqi: r.european_aqi,
    pm2_5_ugm3: r.pm2_5,
    pm10_ugm3: r.pm10,
    nitrogen_dioxide_ugm3: r.nitrogen_dioxide,
    ozone_ugm3: r.ozone,
    carbon_monoxide_ugm3: r.carbon_monoxide,
    latitude: r.grid_latitude,
    longitude: r.grid_longitude,
    upstream_hour: r.time,
  }, receipt, { answer, verdict: "verified", confidence: 0.8,
    source: `${url}; Open-Meteo air-quality current block only, model blend at nearest grid cell, interval ${r.interval_seconds} seconds, model-derived current estimate, not a measured station value; fetched ${fetchedAt}` });
}
