// STORM_ALERT_GENERAL — GET /v1/storm-alert?location=<lat,lon>&window_hours=<1-240>
//
// Zero-LLM. Storm/weather-disruption risk for a place from currently
// ISSUED US National Weather Service alert products, with a SHA-256
// receipt over the exact upstream response bodies.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/STORM_ALERT_GENERAL,
// read 2026-11-22): request location (string) + window_hours (integer
// 1..240, default 24); response risk_score (0..1, scored) + risk_level
// (LOW/MODERATE/HIGH/SEVERE); off-chain location, peak_gust_kmh,
// precipitation_mm, window.
//
// SOURCE: NWS api.weather.gov, keyless (User-Agent identification per
// NWS policy), probed live 2026-11-23. Authoritative US issuer, single
// source, honestly named.
//
// SCOPE, stated in every answer:
// - Risk derives ONLY from currently issued alert products (the
//   /alerts/active feed), each named with its event, severity, and
//   issue/expiry times. No forecast model output is scored.
// - US coverage only: the /points lookup 404s outside the NWS grid,
//   which is an honest 422 OUTSIDE_NWS_COVERAGE, never a silent LOW.
// - location may be "lat,lon" decimal degrees or a place name (S1,
//   audit 2026-11-23: the contract reads "The place"). Place names are
//   geocoded with the same Open-Meteo geocoder and fail-closed rules as
//   the forecast slice (named resolution, provider-ranked first result disclosed), and the
//   resolved place and its coordinates are named in every answer.
// - peak_gust_kmh and precipitation_mm are null: issued alert products
//   do not carry those numerics and they are never invented.
//
// RISK MAPPING (deterministic, disclosed in evidence): among alerts
// active now whose expiry falls inside the assessment window, the worst
// severity sets the score — Extreme 1.0, Severe 0.75, Moderate 0.5,
// Minor/Unknown 0.25, none 0.0. Levels: >=0.875 SEVERE, >=0.625 HIGH,
// >=0.375 MODERATE, else LOW.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { parseRankedLocation } from "./routeGeocoder";
import { envelope, makeReceipt, sha256Hex } from "../core/receipt";
import { saveReceipt } from "../core/storage";

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

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/geo+json" } });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

export const INTENT = "STORM_ALERT_GENERAL";

export async function handleStormAlert(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
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
  const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;
  const alertsUrl = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
  const fetchedAt = new Date().toISOString();
  let points: { status: number; body: string };
  let alertsRes: { status: number; body: string };
  try {
    points = await fetchText(pointsUrl);
    if (points.status === 404) {
      throw unprocessable("OUTSIDE_NWS_COVERAGE", `${lat},${lon} is outside the NWS grid (US and territories); this intent covers issued NWS alert products only`);
    }
    if (!points.status || points.status >= 400) throw new Error(`points HTTP ${points.status}`);
    alertsRes = await fetchText(alertsUrl);
    if (alertsRes.status >= 400) throw new Error(`alerts HTTP ${alertsRes.status}`);
  } catch (e) {
    if (e && typeof e === "object" && "status" in e) throw e; // ApiError from the 404 above
    throw upstreamUnavailable("NWS_UNREACHABLE", "the NWS api.weather.gov feed could not be reached");
  }
  const alerts = parseAlerts(alertsRes.body);
  const nowIso = new Date().toISOString();
  const { score, level, counted, excluded } = assessAlerts(alerts, nowIso, windowHours);
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({ location: `${lat},${lon}`, resolved_place: geocoder ? placeLabel : "not geocoded (coordinates given directly)",
    geocoder: geocoder ? { url: geocoder.url, selection: geocoder.selection, raw_body: geocoder.body, sha256: sha256Hex(Buffer.from(geocoder.body, "utf8")) } : "not used",
    window_hours: windowHours, as_of: asOf,
    alerts: alerts.map((a) => ({ ...a, counted: counted.includes(a) })),
    risk_mapping: "worst severity among active alerts expiring inside the window: Extreme 1.0, Severe 0.75, Moderate 0.5, Minor/Unknown 0.25, none 0; levels >=0.875 SEVERE, >=0.625 HIGH, >=0.375 MODERATE, else LOW",
    source_policy: "NWS api.weather.gov issued alert products only; no forecast output scored; US coverage only",
    raw_bodies: { points: points.body, alerts: alertsRes.body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, alertsUrl, evidence, "NWS single authoritative source; issued products only, US only");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const fmt = (a: IssuedAlert) => `${a.event} (${a.severity}), issued ${a.sent}, expires ${a.expires}`;
  const answerCore = counted.length === 0
    ? `Storm risk LOW (score 0) for ${placeLabel} over the next ${windowHours}h: no issued NWS alert products are active at this point expiring inside the window` +
      (excluded.length ? ` (${excluded.length} issued product(s) not counted toward this window: ${excluded.map((a) => `${a.event}, onset ${a.onset}, expires ${a.expires}`).join("; ")})` : "") +
      ". Issued US NWS alert products only; no forecast model output is scored."
    : `Storm risk ${level} (score ${score}) for ${placeLabel} over the next ${windowHours}h from ${counted.length} issued NWS alert product(s): ` +
      counted.map(fmt).join("; ") +
      (excluded.length ? `. Not counted toward this window: ${excluded.map((a) => `${a.event}, onset ${a.onset}, expires ${a.expires}`).join("; ")}` : "") +
      ". Score is the worst severity among these issued products (Extreme 1.0 / Severe 0.75 / Moderate 0.5 / Minor 0.25); no forecast model output is scored. Peak gust and precipitation numerics are not carried by issued alert products.";
  const answer = answerCore + (geocoder ? ` Location selection: ${geocoder.selection}. Geocoding: Open-Meteo / GeoNames (CC BY 4.0).` : "");
  return envelope(INTENT, {
    location: `${lat},${lon}`,
    risk_score: score,
    risk_level: level,
    window_hours: windowHours,
    window: `${nowIso}/${new Date(new Date(nowIso).getTime() + windowHours * 3600_000).toISOString()}`,
    peak_gust_kmh: null,
    precipitation_mm: null,
    alerts: counted.map((a) => ({ event: a.event, severity: a.severity, area: a.area, sent: a.sent, expires: a.expires })),
    alerts_beyond_window: excluded.map((a) => ({ event: a.event, severity: a.severity, expires: a.expires })),
  }, receipt, { answer, verdict: "verified", confidence: 0.9,
    source: `${alertsUrl} (+ ${pointsUrl} coverage check); NWS issued alert products only, US coverage only; fetched ${fetchedAt}` });
}
