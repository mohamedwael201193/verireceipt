// WEATHER_FORECAST_GENERAL fallback: MET Norway Locationforecast 2.0 compact.
// Used only when the primary Open-Meteo forecast read fails (429 / 5xx / timeout).
// Hourly air_temperature only. A window not fully covered by hourly steps is
// refused (MET goes 6-hourly after about 60 h), nothing is interpolated, and
// no precipitation probability is ever derived from precipitation amounts.
import { upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, sha256Hex } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { readMetForecast, validateMetForecast } from "./metForecast";

const INTENT = "WEATHER_FORECAST_GENERAL";
export const MET_FALLBACK_SOURCE = "met.no locationforecast 2.0 compact (fallback; primary Open-Meteo unavailable)";
export const MET_FALLBACK_NOTE = "no precipitation probability available from this source";

/** Existing condition vocabulary, only for unambiguous MET symbol codes. */
export function metCondition(symbol: unknown): string | null {
  if (typeof symbol !== "string") return null;
  const code = symbol.replace(/_(day|night|polartwilight)$/, "");
  if (code.includes("thunder")) return "thunderstorm";
  const table: Record<string, string> = {
    clearsky: "clear sky", fair: "mainly clear", partlycloudy: "partly cloudy", cloudy: "overcast", fog: "fog",
    lightrain: "slight rain", rain: "moderate rain", heavyrain: "heavy rain",
    lightrainshowers: "slight rain showers", rainshowers: "moderate rain showers", heavyrainshowers: "violent rain showers",
    lightsnow: "slight snow", snow: "moderate snow", heavysnow: "heavy snow",
    lightsnowshowers: "slight snow showers", heavysnowshowers: "heavy snow showers",
  };
  return Object.hasOwn(table, code) ? table[code] : null;
}

function utcOffsetSeconds(timeZone: string, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const local = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
    const off = Math.round((local - Math.floor(at / 1000) * 1000) / 1000);
    return Number.isInteger(off) && Math.abs(off) <= 14 * 3600 ? off : null;
  } catch { return null; }
}

function geocoderTimezone(geoBody: string | null, lat: number, lon: number): string | null {
  if (!geoBody) return null;
  try {
    const hits = (JSON.parse(geoBody) as { results?: { latitude?: number; longitude?: number; timezone?: string }[] }).results ?? [];
    const hit = hits.find((r) => r.latitude === lat && r.longitude === lon);
    return typeof hit?.timezone === "string" && hit.timezone ? hit.timezone : null;
  } catch { return null; }
}

export interface FallbackInput {
  lat: number; lon: number; windowHours: number; location: string; resolvedName: string;
  locationSelection: string | null; geoUrl: string | null; geoBody: string | null;
}

/** Returns the disclosed fallback envelope, or null when the fallback cannot answer honestly. */
export async function metForecastFallback(a: FallbackInput): Promise<Record<string, unknown> | null> {
  const tz = geocoderTimezone(a.geoBody, a.lat, a.lon);
  if (!tz) return null;
  const now = Date.now();
  const offsetSec = utcOffsetSeconds(tz, now);
  if (offsetSec === null) return null;
  let met: { url: string; body: string; fetchedAt: string };
  let rows: Map<string, number>;
  try { met = await readMetForecast(a.lat, a.lon); rows = validateMetForecast(met.body, a.lat, a.lon); }
  catch { return null; }
  const localHour = new Date(now + offsetSec * 1000).toISOString().slice(0, 13) + ":00";
  const localStart = Date.parse(localHour + ":00Z");
  const utcStart = localStart - offsetSec * 1000;
  const utcHours = Array.from({ length: a.windowHours }, (_, i) => new Date(utcStart + i * 3600000).toISOString());
  if (utcHours.some((t) => !rows.has(t))) return null;
  const temps = utcHours.map((t) => rows.get(t)!);
  if (temps.some((t) => !Number.isFinite(t) || t < -90 || t > 60)) return null;
  const tempMax = Math.max(...temps), tempMin = Math.min(...temps);
  const symbols = new Map<string, unknown>();
  try {
    for (const r of JSON.parse(met.body).properties.timeseries) symbols.set(new Date(r.time).toISOString(), r?.data?.next_1_hours?.summary?.symbol_code);
  } catch { return null; }
  const conds = utcHours.map((t) => metCondition(symbols.get(t)));
  let condition: string | null = null;
  if (conds.every((c) => c !== null)) {
    const counts = new Map<string, number>();
    for (const c of conds as string[]) counts.set(c, (counts.get(c) ?? 0) + 1);
    let bestN = 0;
    for (const [c, n] of counts) if (n > bestN) { condition = c; bestN = n; }
  }
  const first = new Date(localStart).toISOString().slice(0, 16), last = new Date(localStart + (a.windowHours - 1) * 3600000).toISOString().slice(0, 16);
  const when = `${first} to ${last} ${tz} (${a.windowHours}h window)`;
  const disclosure = `Fallback source: ${MET_FALLBACK_SOURCE}; ${MET_FALLBACK_NOTE}.`;
  const evidence = JSON.stringify({
    location_queried: a.location, resolved: a.resolvedName, location_selection: a.locationSelection,
    window_hours: a.windowHours, when, timezone: tz,
    temp_max_c: tempMax, temp_min_c: tempMin, precipitation_probability_pct: null, condition, extras: null,
    forecast_source: MET_FALLBACK_SOURCE,
    method: "MET Norway model forecast, fallback; hourly air_temperature over the requested hours, only a window fully covered by hourly steps is answered; NOT a measurement",
    geocode_upstream: { url: a.geoUrl, raw_body: a.geoBody, sha256: sha256Hex(Buffer.from(a.geoBody!, "utf8")) },
    forecast_upstream: { url: met.url, raw_body: met.body, sha256: sha256Hex(Buffer.from(met.body, "utf8")) },
    fetched_at: met.fetchedAt,
  });
  const receipt = makeReceipt(INTENT, met.url, evidence, "MET Norway model forecast, fallback; exact upstream body and geocoder retained");
  receipt.fetched_at = met.fetchedAt;
  try { await saveReceipt(receipt, evidence); }
  catch { throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable"); }
  const answer = `Forecast for ${a.resolvedName}, ${when}: high ${tempMax}°C, low ${tempMin}°C, ` +
    `${condition ? `dominant condition: ${condition}. ` : "condition not determined from this source. "}${disclosure} ` +
    `Numerical forecast for ${tz}, not a measurement.${a.locationSelection ? " Location selection: " + a.locationSelection + ". Geocoding: Open-Meteo / GeoNames (CC BY 4.0)." : ""}`;
  return envelope(INTENT, {
    location: a.resolvedName, when, temp_max_c: tempMax, temp_min_c: tempMin,
    precipitation_probability_pct: null, condition, extras: null,
    forecast_source: MET_FALLBACK_SOURCE, timezone: tz,
    summary: `${a.resolvedName}: ${tempMin}–${tempMax}°C${condition ? `, ${condition}` : ""} over the next ${a.windowHours}h (MET Norway model forecast, not measured). Source: ${MET_FALLBACK_SOURCE}; ${MET_FALLBACK_NOTE}.`,
  }, receipt, { answer, verdict: "verified", confidence: 0.7,
    source: `Open-Meteo geocoder ${a.geoUrl}; MET Norway locationforecast ${met.url} (fetched ${met.fetchedAt}; fallback, model forecast, not a measurement)` });
}
