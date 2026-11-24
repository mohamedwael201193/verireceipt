// IP_GEOLOCATION_GENERAL — GET /v1/ip-geolocation?ip=8.8.8.8
//
// Zero-LLM. Resolves an IP address to its approximate location from two
// keyless public geolocation services, with a SHA-256 receipt over the
// exact upstream response bodies.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/IP_GEOLOCATION_GENERAL,
// read 2026-11-22): request ip; response country, city, isp (off-chain)
// and scored latitude/longitude (degrees).
//
// SOURCES (both keyless, probed live 2026-11-23):
//   1. ipwho.is — HTTPS, free tier 10k req/month, serves the answer.
//   2. ip-api.com — HTTP only on the free tier (the queried IP crosses
//      the wire in cleartext; named honestly), 45 req/min, free tier
//      terms limit use to non-commercial — this deployment is a
//      hackathon testnet.
// DOCTRINE: the two services run DIFFERENT geolocation databases, so
// their city and coordinate estimates routinely differ (8.8.8.8:
// San Jose vs Ashburn, measured). Coordinates are therefore NEVER
// averaged — ipwho.is serves the scored latitude/longitude, honestly
// named, and ip-api.com cross-checks the COUNTRY only: a country
// disagreement is refused (502 GEO_SOURCES_DISAGREE), never averaged
// into a wrong answer. City differences between sources are disclosed
// in the answer. One source down serves the other alone at 0.9 with
// the degradation named. Private/reserved addresses have no public
// geolocation: 422 PRIVATE_IP.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 5000;
const UA = "VeriReceipt/2.0 ip-geolocation observer (+https://verireceipt.vercel.app)";

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const V6 = /^[0-9a-fA-F:]+$/;

export function validatePublicIp(ip: string): void {
  const m = V4.exec(ip);
  if (m) {
    const oct = m.slice(1).map(Number);
    if (oct.some((o) => o > 255)) throw badRequest("INVALID_IP", "not a valid IPv4 address");
    const [a, b] = oct;
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 ||
        (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
        // RFC 5737 documentation ranges (TEST-NET-1/2/3): no public geolocation.
        (a === 192 && b === 0 && oct[2] === 2) || (a === 198 && b === 51 && oct[2] === 100) || (a === 203 && b === 0 && oct[2] === 113)) {
      throw unprocessable("PRIVATE_IP", `${ip} is a private, reserved or special-use address; it has no public geolocation`);
    }
    return;
  }
  if (V6.test(ip) && ip.includes(":")) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::" || low.startsWith("fc") || low.startsWith("fd") || /^fe[89ab]/.test(low) || low.startsWith("::ffff:10.") || low.startsWith("::ffff:192.168") || low.startsWith("::ffff:127.") || low.startsWith("::ffff:169.254") || low.startsWith("::ffff:172.1") || low.startsWith("::ffff:172.2") || low.startsWith("::ffff:172.3")) {
      throw unprocessable("PRIVATE_IP", `${ip} is a private, reserved or special-use address; it has no public geolocation`);
    }
    return;
  }
  throw badRequest("INVALID_IP", "ip must be an IPv4 or IPv6 address");
}

export interface GeoResult { country: string; city: string; lat: number; lon: number; isp: string; source: string; raw: string }

export function parseIpwhois(raw: string): GeoResult {
  const d = JSON.parse(raw) as Record<string, unknown>;
  if (d.success !== true) throw unprocessable("GEO_NO_RESULT", typeof d.message === "string" ? String(d.message) : "ipwho.is has no result for this address");
  if (typeof d.country !== "string" || typeof d.latitude !== "number" || typeof d.longitude !== "number" ||
      !Number.isFinite(d.latitude) || !Number.isFinite(d.longitude) ||
      Math.abs(d.latitude) > 90 || Math.abs(d.longitude) > 180) {
    throw upstreamUnavailable("GEO_BAD_BODY", "ipwho.is body lacks a usable country or coordinates");
  }
  return { country: d.country, city: typeof d.city === "string" ? d.city : "",
    lat: d.latitude, lon: d.longitude,
    isp: typeof (d.connection as { isp?: unknown } | undefined)?.isp === "string" ? String((d.connection as { isp: unknown }).isp) : "",
    source: "ipwho.is", raw };
}

export function parseIpApi(raw: string): GeoResult {
  const d = JSON.parse(raw) as Record<string, unknown>;
  if (d.status !== "success") throw unprocessable("GEO_NO_RESULT", typeof d.message === "string" ? String(d.message) : "ip-api.com has no result for this address");
  if (typeof d.country !== "string" || typeof d.lat !== "number" || typeof d.lon !== "number" ||
      !Number.isFinite(d.lat) || !Number.isFinite(d.lon) || Math.abs(d.lat) > 90 || Math.abs(d.lon) > 180) {
    throw upstreamUnavailable("GEO_BAD_BODY", "ip-api.com body lacks a usable country or coordinates");
  }
  return { country: d.country, city: typeof d.city === "string" ? d.city : "",
    lat: d.lat, lon: d.lon, isp: typeof d.isp === "string" ? d.isp : "", source: "ip-api.com", raw };
}

export const INTENT = "IP_GEOLOCATION_GENERAL";

export async function handleIpGeolocation(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const ip = query.ip?.trim();
  if (!ip) throw badRequest("MISSING_PARAM", "ip is required");
  if (ip.length > 45) throw badRequest("INVALID_IP", "ip is too long to be an IP address");
  validatePublicIp(ip);
  const whoUrl = `https://ipwho.is/${encodeURIComponent(ip)}`;
  const apiUrl = `http://ip-api.com/json/${encodeURIComponent(ip)}`;
  const fetchedAt = new Date().toISOString();
  const [whoR, apiR] = await Promise.allSettled([
    fetchText(whoUrl).then(parseIpwhois),
    fetchText(apiUrl).then(parseIpApi),
  ]);
  const who = whoR.status === "fulfilled" ? whoR.value : null;
  const api = apiR.status === "fulfilled" ? apiR.value : null;
  if (!who && !api) {
    const codes = [whoR, apiR].map((r) => r.status === "rejected" && r.reason instanceof Error && "code" in r.reason ? String((r.reason as { code: unknown }).code) : "unreachable");
    if (codes.includes("GEO_NO_RESULT")) throw unprocessable("GEO_NO_RESULT", `no geolocation result for ${ip} from either source`);
    throw upstreamUnavailable("GEO_SOURCES_DOWN", `both geolocation sources failed for ${ip}`);
  }
  const asOf = new Date().toISOString();
  let serving: GeoResult;
  let degraded = "";
  let cityNote = "";
  if (who && api) {
    if (who.country.toLowerCase() !== api.country.toLowerCase()) {
      throw upstreamUnavailable("GEO_SOURCES_DISAGREE",
        `geolocation sources disagree on the COUNTRY for ${ip}: ipwho.is=${who.country}, ip-api.com=${api.country}; refusing to serve either`);
    }
    serving = who; // coordinates are never averaged: ipwho.is serves them
    if (who.city && api.city && who.city.toLowerCase() !== api.city.toLowerCase()) {
      cityNote = ` City-level estimates differ between the two databases (ipwho.is: ${who.city}; ip-api.com: ${api.city}) — IP geolocation is approximate, city-level at best.`;
    }
  } else {
    serving = (who ?? api)!;
    degraded = who ? "ip-api.com did not answer; single source" : "ipwho.is did not answer; serving ip-api.com's estimate alone; single source";
  }
  const evidence = JSON.stringify({ ip, as_of: asOf, served: { ...serving, raw: undefined },
    source_policy: "ipwho.is serves the coordinates (HTTPS, free 10k/month); ip-api.com (HTTP free tier, non-commercial terms, hackathon testnet) cross-checks country only; coordinates never averaged; country disagreement refused",
    raw_bodies: { "ipwho.is": who?.raw ?? null, "ip-api.com": api?.raw ?? null }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, who ? whoUrl : apiUrl, evidence, "two keyless geolocation databases; country cross-checked, coordinates single-source, never averaged");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  return envelope(INTENT, { ip, country: serving.country, city: serving.city,
    latitude: serving.lat, longitude: serving.lon, isp: serving.isp }, receipt, {
    answer: `${ip}: ${serving.city ? serving.city + ", " : ""}${serving.country} (${serving.lat}, ${serving.lon})` +
      `${serving.isp ? `, network ${serving.isp}` : ""}. Coordinates: ${serving.source}.` +
      (who && api ? " Country cross-checked across two independent geolocation databases." : "") +
      cityNote + (degraded ? ` Degraded: ${degraded}.` : "") +
      " IP geolocation is approximate — it names where the address block is registered or routed, not a device's physical location.",
    verdict: "verified",
    confidence: 0.9,
    source: `${who ? whoUrl : "(ipwho.is failed)"} + ${api ? apiUrl : "(ip-api.com failed)"}; coordinates from ${serving.source}, country ${who && api ? "cross-checked across both" : "single-source"}; coordinates never averaged; fetched ${fetchedAt}`,
  });
}
