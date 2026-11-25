// PAYMENT_METHOD_VERIFY_GENERAL — GET /v1/payment-method?bin=<6-8 digits>
//
// Zero-LLM. Verifies a card BIN (bank identification number, the first
// 6-8 digits of a card number) against a public BIN database, with a
// SHA-256 receipt over the exact upstream body.
//
// Intent contract (read 2026-11-23): request bin (integer 100000..
// 99999999 — a PREFIX, never a full card number); scored valid (bool),
// described as "structurally valid (checksum passes)".
//
// HONEST SCOPE: a bare BIN carries NO checksum — Luhn needs the full
// card number, which this intent deliberately never receives. So
// valid describes the request prefix only: in-range format plus a known
// network range OR a source allocation reference. allocation_known is separate.
// No Luhn/checksum result, card activity or exact allocation is inferred.
//
// SOURCES: binlist.net plus api.dharun.dev's CC BY4.0 open BIN list.
// Results cached up to24h with original acquisition time and raw bytes.
// Allocation references only; disagreement and source failures are disclosed.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // BIN allocations change rarely; named in every answer
const UA = "VeriReceipt/2.0 payment-method observer (+https://verireceipt.vercel.app)";

export const INTENT = "PAYMENT_METHOD_VERIFY_GENERAL";
const NETWORK_RANGE_SOURCE = "https://design.visa.com/patterns/card-input/";
/** Published network ranges, checked 2026-11-25. May overlap (e.g. Maestro);
 * candidates identify structural prefix coverage, never issuer allocation. */
export function binNetworkCandidates(bin:string):string[]{
 const six=Number(bin.slice(0,6)),two=Number(bin.slice(0,2)),three=Number(bin.slice(0,3));
 const networks:string[]=[];
 if(bin.startsWith('4'))networks.push('visa');
 if((two>=51&&two<=55)||(six>=222100&&six<=272099))networks.push('mastercard');
 if(two===34||two===37)networks.push('american express');
 if(bin.startsWith('6011')||(six>=622126&&six<=622925)||(three>=644&&three<=649)||two===65)networks.push('discover');
 if((six>=500000&&six<=509999)||(six>=560000&&six<=589999)||(six>=600000&&six<=699999))networks.push('maestro');
 return networks;
}

interface BinlistReply {
  scheme?: string;
  type?: string;
  brand?: string;
  country?: { alpha2?: string; name?: string };
  bank?: { name?: string };
}

interface CacheEntry { at: number; found: boolean; body: string; fetchedAt:string }
const cache = new Map<string, CacheEntry>();
export function resetBinCacheForTests(): void { cache.clear(); openCache.clear(); }

async function lookupBin(bin: string): Promise<{ found: boolean; body: string; cached: boolean; fetchedAt: string }> {
  const hit = cache.get(bin);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { found: hit.found, body: hit.body, cached: true, fetchedAt: hit.fetchedAt };
  }
  const url = `https://lookup.binlist.net/${bin}`;
  const fetchedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  let res: Response;
  let body: string;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, "Accept-Version": "3", Accept: "application/json" } });
    body = await res.text();
  } catch (e) {
    throw upstreamUnavailable("BINLIST_UNREACHABLE", `the BIN database could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) {
    cache.set(bin, { at: Date.now(), found: false, body, fetchedAt });
    return { found: false, body, cached: false, fetchedAt };
  }
  if (!res.ok) {
    throw upstreamUnavailable("BINLIST_DEGRADED", `the BIN database answered HTTP ${res.status} (rate limit or outage); refusing to guess`);
  }
  let parsed: BinlistReply;
  try { parsed = JSON.parse(body); } catch { throw upstreamUnavailable("BINLIST_MALFORMED", "BIN database returned invalid JSON"); }
  const present = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  const found = parsed !== null && typeof parsed === "object" && (present(parsed.scheme) || present(parsed.country?.name) || present(parsed.country?.alpha2));
  cache.set(bin, { at: Date.now(), found, body, fetchedAt });
  return { found, body, cached: false, fetchedAt };
}

interface SourceResult { name: string; url: string; body: string; found: boolean; cached: boolean; fetchedAt: string; info: BinlistReply; allocationPrefix?:string; error?: string }
const openCache = new Map<string, SourceResult>();
const credit = "Card prefixes from BIN List Data by Venelin Kochev (binlookup.io), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), via api.dharun.dev; fields normalized and merged.";
const text = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v.trim() : undefined;
async function openLookup(bin: string): Promise<SourceResult> {
  const hit = openCache.get(bin);
  if (hit && Date.now() - Date.parse(hit.fetchedAt) < CACHE_TTL_MS) return { ...hit, cached: true };
  const url = `https://api.dharun.dev/v1/bin/${bin}`;
  const fetchedAt = new Date().toISOString();
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { Accept: "application/json" } });
  const body = await response.text();
  if (response.status !== 404 && !response.ok) throw new Error(`HTTP ${response.status}`);
  const data = response.status === 404 ? {} : JSON.parse(body)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid data object");
  if(response.status!==404 && (typeof data.bin!=="string" ||
    !(data.bin===bin || ((bin.length===7 || bin.length===8) && data.bin.length===6 && /^\d{6}$/.test(data.bin) && bin.startsWith(data.bin)))))throw new Error("BIN identity mismatch");
  const info: BinlistReply = { scheme: text(data.network)?.toLowerCase(), type: text(data.type)?.toLowerCase(), bank: { name: text(data.issuer) }, country: { alpha2: text(data.country), name: text(data.country_name) } };
  const result = { name: "open BIN list", url, body, found: !!(info.scheme || info.country?.alpha2 || info.country?.name), cached: false, fetchedAt, info, ...(response.status!==404?{allocationPrefix:data.bin}:{}) };
  openCache.set(bin, result); return result;
}
export async function handlePaymentMethod(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const raw = query.bin?.trim();
  if (!raw) throw badRequest("MISSING_PARAM", "bin is required: first6 to8 digits, never a full card number");
  if (!/^[1-9]\d{5,7}$/.test(raw)) throw badRequest("INVALID_BIN", "bin must be6 to8 digits in100000..99999999; never the full number");
  const binlist = async (): Promise<SourceResult> => {
    const r = await lookupBin(raw);
    return { ...r, name: "binlist.net", url: `https://lookup.binlist.net/${raw}`, info: r.found ? JSON.parse(r.body) : {} };
  };
  const settled = await Promise.allSettled([binlist(), openLookup(raw)]);
  const sources: SourceResult[] = settled.map((r, i) => r.status === "fulfilled" ? r.value : ({ name: i === 0 ? "binlist.net" : "open BIN list", url: i === 0 ? `https://lookup.binlist.net/${raw}` : `https://api.dharun.dev/v1/bin/${raw}`, body: "", found: false, cached: false, fetchedAt: new Date().toISOString(), info: {}, error: "source unavailable" }));
  const successful = sources.filter(s => !s.error);
  if (!successful.length) throw upstreamUnavailable("BIN_SOURCES_UNAVAILABLE", "both BIN sources unavailable; refusing to guess");
  const allocationKnown = sources.some(s => s.found);
  const networkCandidates = binNetworkCandidates(raw);
  const valid = allocationKnown || networkCandidates.length>0;
  if (!allocationKnown && successful.length !== 2) throw upstreamUnavailable("BIN_COVERAGE_INCOMPLETE", "one source has no record and the other is unavailable; cannot confirm no-record");
  const fields = { network: (i: BinlistReply) => i.scheme, issuing_bank: (i: BinlistReply) => i.bank?.name, issuing_country: (i: BinlistReply) => i.country?.name ?? i.country?.alpha2, card_type: (i: BinlistReply) => i.type };
  const values: Record<string, string | null> = {};
  const fieldSources: Record<string, string | null> = {};
  const conflicts: string[] = [];
  for (const [field, pick] of Object.entries(fields)) {
    const candidates = successful.map(s => ({ s, v: text(pick(s.info)) })).filter(c => c.v);
    values[field] = candidates[0]?.v ?? null; fieldSources[field] = candidates[0]?.s.name ?? null;
    if (new Set(candidates.map(c => c.v!.toLowerCase())).size > 1) conflicts.push(field);
  }
  const parentCoverage=successful.filter(s=>s.found&&s.allocationPrefix&&s.allocationPrefix!==raw).map(s=>({source:s.name,requested_bin:raw,allocation_prefix:s.allocationPrefix,scope:raw.length===7?'six-digit parent only; not an exact seven-digit allocation':'six-digit parent only; not an exact eight-digit allocation'}));
  const asOf = new Date().toISOString();
  const fetchedAt = successful.map(s => s.fetchedAt).sort()[0];
  const validityScope = "BIN-prefix only: request format/range plus published network range or allocation reference; no checksum assessed; Luhn cannot be assessed from a prefix, not full-card validity";
  const evidence = JSON.stringify({ bin: raw, valid,allocation_known:allocationKnown,network_range_candidates:networkCandidates,network_range_source:NETWORK_RANGE_SOURCE,checksum_assessed:false,validity_scope:validityScope, ...values, field_sources: fieldSources, conflicts, sources, allocation_scope:parentCoverage, attribution: credit, scope: validityScope, as_of: asOf });
  const receipt = makeReceipt(INTENT, sources[0].url, evidence, "two keyless BIN references; exact raw bodies, field provenance, conflicts and original acquisition times; up to24h cache");
  receipt.fetched_at = fetchedAt;
  try { await saveReceipt(receipt, evidence); } catch { throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable"); }
  const { network, issuing_bank, issuing_country, card_type } = values;
  const answer = (allocationKnown ? `Yes, BIN ${raw}${parentCoverage.length ? " has a known six-digit parent allocation reference" : " is an allocated, known card prefix"}: ${network ?? "unknown network"}${card_type ? " " + card_type : ""}${issuing_bank ? ", issued by " + issuing_bank : ""}${issuing_country ? ", " + issuing_country : ""}. ` : `No record for BIN ${raw} in either reference. That is not proof the prefix is unallocated. `) +
    `Prefix valid=${valid}: ${allocationKnown?"allocation reference found":networkCandidates.length?"format and published network range match ("+networkCandidates.join(", ")+"); allocation unknown":"no covered network range or allocation reference; this is not proof of structural invalidity or non-allocation"}. BIN format and allocation-only reference check, no checksum, no guarantee a card is real, active or safe. Sources fetched ${fetchedAt}${sources.some(s => s.cached) ? ", up to24h cache" : ""}.` +
    (sources.some(s => s.error) ? " One source unavailable; partial coverage." : "") + (conflicts.length ? ` Sources disagree on ${conflicts.join(", ")}; binlist.net non-empty fields take precedence.` : "") + (parentCoverage.length?` Parent-prefix coverage only from ${parentCoverage.map(s=>s.source+': '+s.allocation_prefix).join('; ')}; no exact ${raw.length===7?"seven":"eight"}-digit allocation is asserted.`:"") + " " + credit;
  return envelope(INTENT, { bin: raw, valid,allocation_known:allocationKnown,network_range_candidates:networkCandidates,checksum_assessed:false,validity_scope:validityScope, ...values, field_sources: fieldSources, source_conflicts: conflicts, allocation_scope:parentCoverage, attribution: credit, summary: `${raw}: ${allocationKnown ? parentCoverage.length ? `known parent-prefix reference, no exact ${raw.length===7?"seven":"eight"}-digit allocation asserted` : "known prefix" : "no record"}; prefix-format/network and allocation reference check, no checksum.` }, receipt, { answer, verdict: "verified", confidence: conflicts.length || sources.some(s => s.error) ? 0.6 : 0.9, source: successful.map(s => `${s.name} ${s.url} fetched ${s.fetchedAt}`).join("; ") });
}
