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
// MEASURED-ONLY DOCTRINE: only the "current" block is served — no
// hourly forecast is ever requested or quoted. Honesty limit, stated in
// every answer: Open-Meteo current values are a MODEL BLEND (CAMS-based)
// at the nearest grid cell on an hourly interval, not a ground-station
// measurement, and the served coordinates are the grid cell the API
// snapped to, which the answer names explicitly.
//
// The scored boolean is `acceptable`: US AQI at or below 100 (US EPA
// "moderate or better" band). The AQI value itself and the pollutant
// concentrations are served as numbers with their units named.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 6000;
const UA = "VeriReceipt/2.0 air-quality observer (+https://verireceipt.vercel.app)";
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

export function parseAirQuality(raw: string): AirQualityReading {
  const d = JSON.parse(raw) as Record<string, unknown>;
  const cur = d.current as Record<string, unknown> | undefined;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const us = num(cur?.us_aqi);
  if (us === null || !cur) {
    throw unprocessable("NO_USABLE_AQI", "the upstream answer carried no current US AQI; never guessed");
  }
  return {
    us_aqi: us,
    european_aqi: num(cur.european_aqi),
    pm2_5: num(cur.pm2_5),
    pm10: num(cur.pm10),
    nitrogen_dioxide: num(cur.nitrogen_dioxide),
    ozone: num(cur.ozone),
    carbon_monoxide: num(cur.carbon_monoxide),
    time: String(cur.time ?? ""),
    interval_seconds: num(cur.interval) ?? 0,
    grid_latitude: num(d.latitude) ?? NaN,
    grid_longitude: num(d.longitude) ?? NaN,
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
    throw upstreamUnavailable("OPEN_METEO_UNREACHABLE", "the Open-Meteo air-quality API could not be reached");
  }
  const r = parseAirQuality(body);
  const acceptable = r.us_aqi <= ACCEPTABLE_US_AQI;
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ lat, lon, as_of: asOf, reading: r, acceptable,
    source_policy: "Open-Meteo air-quality current block only; model blend at nearest grid cell, never a forecast, never a ground-station claim",
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
    ` These are Open-Meteo modelled current conditions (CAMS blend) at the nearest grid cell on an hourly interval, not a ground-station measurement, and never a forecast.`;
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
    source: `${url}; Open-Meteo air-quality current block only, model blend at nearest grid cell, hourly interval, never a forecast; fetched ${fetchedAt}` });
}
