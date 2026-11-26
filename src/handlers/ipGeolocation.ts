import {readPublicBody} from "../core/publicSource";
import {queryFallback,firstIp} from '../core/queryFallback';
import {isIP} from 'node:net';
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
// disagreement (compared by ISO code, not by spelling) is disclosed in the
// answer and ipwho.is is served alone, never averaged. City differences between sources are disclosed
// in the answer. One source down serves the other alone at 0.9 with
// the degradation named. Private/reserved addresses have no public
// geolocation: disclosed no_data, without coordinates.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 5000;
const UA = "VeriReceipt/2.0 ip-geolocation observer (+https://verireceipt.vercel.app)";

async function fetchText(url:string):Promise<string>{
 let timer:ReturnType<typeof setTimeout>;
 try{return await Promise.race([readPublicBody(url,64000,SOURCE_TIMEOUT_MS,UA).then(body=>body.raw),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('geolocation source deadline')),5100);})]);}finally{clearTimeout(timer!);}
}
function canonicalIp(value:unknown):string|null{
 if(typeof value!=='string'||!isIP(value))return null;
 if(isIP(value)===4)return value;
 return new URL(`http://[${value}]/`).hostname.toLowerCase();
}
function bindIp(observed:unknown,expected:string){if(!canonicalIp(observed)||canonicalIp(observed)!==canonicalIp(expected))throw upstreamUnavailable('GEO_IP_MISMATCH','source result does not identify requested IP');}
const optionalText=(v:unknown):string|null=>typeof v==='string'&&v.trim()&&v.length<=256?v.trim():null;

const isoCode=(v:unknown):string|null=>typeof v==='string'&&/^[A-Za-z]{2}$/.test(v.trim())?v.trim().toUpperCase():null;
const plainName=(v:string):string=>v.toLowerCase().replace(/^the\s+/,'').trim();

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const V6 = /^[0-9a-fA-F:]+$/;

export function validatePublicIp(ip: string): void {
  if (ip.includes("%") || !isIP(ip)) throw badRequest("INVALID_IP", "ip must be an IPv4 or IPv6 address");
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
  if (isIP(ip) === 6) {
    const normalized = new URL(`http://[${ip}]/`).hostname.slice(1,-1).toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const tail=normalized.slice(7).split(':');
      if(tail.length===2) {
        const n=parseInt(tail[0],16)*65536+parseInt(tail[1],16);
        return validatePublicIp(`${(n>>>24)&255}.${(n>>>16)&255}.${(n>>>8)&255}.${n&255}`);
      }
    }
    const low = normalized;
    if (low.startsWith("2001:db8:") || low.startsWith("ff") || low === "::1" || low === "::" || low.startsWith("fc") || low.startsWith("fd") || /^fe[89ab]/.test(low) || low.startsWith("::ffff:10.") || low.startsWith("::ffff:192.168") || low.startsWith("::ffff:127.") || low.startsWith("::ffff:169.254") || low.startsWith("::ffff:172.1") || low.startsWith("::ffff:172.2") || low.startsWith("::ffff:172.3")) {
      throw unprocessable("PRIVATE_IP", `${ip} is a private, reserved or special-use address; it has no public geolocation`);
    }
    return;
  }
  throw badRequest("INVALID_IP", "ip must be an IPv4 or IPv6 address");
}

export interface GeoResult { country: string; countryCode: string|null; city: string; lat: number; lon: number; isp: string; region:string|null;timezone:string|null;asn:number|null;operator:string|null;source: string; raw: string }

export function parseIpwhois(raw: string,expectedIp?:string): GeoResult {
  const d = JSON.parse(raw) as Record<string, unknown>;
  if (d.success !== true) throw unprocessable("GEO_NO_RESULT", typeof d.message === "string" ? String(d.message) : "ipwho.is has no result for this address");
  if (typeof d.country !== "string" || typeof d.latitude !== "number" || typeof d.longitude !== "number" ||
      !Number.isFinite(d.latitude) || !Number.isFinite(d.longitude) ||
      Math.abs(d.latitude) > 90 || Math.abs(d.longitude) > 180) {
    throw upstreamUnavailable("GEO_BAD_BODY", "ipwho.is body lacks a usable country or coordinates");
  }
  if(expectedIp)bindIp(d.ip,expectedIp);
  const connection=d.connection as Record<string,unknown>|undefined;
  return {region:optionalText(d.region),timezone:optionalText((d.timezone as Record<string,unknown>|undefined)?.id),asn:typeof connection?.asn==='number'&&Number.isSafeInteger(connection.asn)&&connection.asn>0&&connection.asn<=4294967295?connection.asn:null,operator:optionalText(connection?.org), country: d.country, countryCode: isoCode(d.country_code), city: typeof d.city === "string" ? d.city : "",
    lat: d.latitude, lon: d.longitude,
    isp: typeof (d.connection as { isp?: unknown } | undefined)?.isp === "string" ? String((d.connection as { isp: unknown }).isp) : "",
    source: "ipwho.is", raw };
}

export function parseIpApi(raw: string,expectedIp?:string): GeoResult {
  const d = JSON.parse(raw) as Record<string, unknown>;
  if (d.status !== "success") throw unprocessable("GEO_NO_RESULT", typeof d.message === "string" ? String(d.message) : "ip-api.com has no result for this address");
  if (typeof d.country !== "string" || typeof d.lat !== "number" || typeof d.lon !== "number" ||
      !Number.isFinite(d.lat) || !Number.isFinite(d.lon) || Math.abs(d.lat) > 90 || Math.abs(d.lon) > 180) {
    throw upstreamUnavailable("GEO_BAD_BODY", "ip-api.com body lacks a usable country or coordinates");
  }
  if(expectedIp)bindIp(d.query,expectedIp);
  const asnMatch=typeof d.as==='string'?/^AS([0-9]+)(?: |$)/.exec(d.as):null;
  const asn=asnMatch?Number(asnMatch[1]):NaN;
  return {region:optionalText(d.regionName),timezone:optionalText(d.timezone),asn:Number.isSafeInteger(asn)&&asn>0&&asn<=4294967295?asn:null,operator:optionalText(d.org), country: d.country, countryCode: isoCode(d.countryCode), city: typeof d.city === "string" ? d.city : "",
    lat: d.lat, lon: d.lon, isp: typeof d.isp === "string" ? d.isp : "", source: "ip-api.com", raw };
}

export const INTENT = "IP_GEOLOCATION_GENERAL";

export async function handleIpGeolocation(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  query=queryFallback(query,"ip",firstIp);
  const ip = query.ip?.trim();
  if (!ip) throw badRequest("MISSING_PARAM", "ip is required");
  if (ip.length > 45) throw badRequest("INVALID_IP", "ip is too long to be an IP address");
  try { validatePublicIp(ip); } catch (error) {
    if ((error as {code?:string}).code !== 'PRIVATE_IP') throw error;
    return {intent:INTENT,ip,receipt:null,checked_at:new Date().toISOString(),
      answer: `${ip}: PRIVATE_IP, private, reserved or documentation addresses have no public geolocation. No coordinates are available.`,
      verdict: 'no_data', confidence: 0, source: 'local IP address classification',
    };
  }
  const whoUrl = `https://ipwho.is/${encodeURIComponent(ip)}`;
  const apiUrl = `http://ip-api.com/json/${encodeURIComponent(ip)}`;
  const fetchedAt = new Date().toISOString();
  const [whoR, apiR] = await Promise.allSettled([
    fetchText(whoUrl).then(raw=>parseIpwhois(raw,ip)),
    fetchText(apiUrl).then(raw=>parseIpApi(raw,ip)),
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
  let countryDisagreement = "";
  if (who && api) {
    // Compare ISO 3166 codes: the two databases spell country names differently
    // (for example "Netherlands" and "The Netherlands"). Only when a code is missing
    // from either body do the names decide, after dropping a leading "the".
    const sameCountry = who.countryCode && api.countryCode ? who.countryCode === api.countryCode : plainName(who.country) === plainName(api.country);
    if (!sameCountry) {
      countryDisagreement = ` Country DISAGREEMENT between the two databases: ipwho.is says ${who.country}${who.countryCode ? ` (${who.countryCode})` : ""}, ip-api.com says ${api.country}${api.countryCode ? ` (${api.countryCode})` : ""}. The coordinates and country served are ipwho.is's alone and are not confirmed by the second database.`;
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
    source_policy: "ipwho.is serves the coordinates (HTTPS, free 10k/month); ip-api.com (HTTP free tier, non-commercial terms, hackathon testnet) cross-checks country only; coordinates never averaged; a country disagreement is disclosed and ipwho.is is served alone",
    raw_bodies: { "ipwho.is": who?.raw ?? null, "ip-api.com": api?.raw ?? null }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, who ? whoUrl : apiUrl, evidence, "two keyless geolocation databases; country compared by ISO code, coordinates single-source, never averaged");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  return envelope(INTENT, { ip, country: serving.country, city: serving.city,
    latitude: serving.lat, longitude: serving.lon, isp: serving.isp,region:serving.region,timezone:serving.timezone,asn:serving.asn,operator:serving.operator,metadata_source:serving.source,country_cross_check: who && api ? (countryDisagreement ? "disagree" : "agree") : "single_source" }, receipt, {
    answer: `${ip}: ${serving.city ? serving.city + ", " : ""}${serving.country} (${serving.lat}, ${serving.lon})` +
      `${serving.isp ? `, network ${serving.isp}` : ""}. Coordinates: ${serving.source}.` +
      (who && api && !countryDisagreement ? " Country cross-checked across two independent geolocation databases." : "") + countryDisagreement +
      cityNote + (degraded ? ` Degraded: ${degraded}.` : "") +
      " IP geolocation is approximate — it names where the address block is registered or routed, not a device's physical location.",
    verdict: "verified",
    confidence: countryDisagreement ? 0.5 : 0.9,
    source: `${who ? whoUrl : "(ipwho.is failed)"} + ${api ? apiUrl : "(ip-api.com failed)"}; coordinates from ${serving.source}, country ${who && api ? (countryDisagreement ? "DISAGREED between the two" : "cross-checked across both") : "single-source"}; coordinates never averaged; fetched ${fetchedAt}`,
  });
}
