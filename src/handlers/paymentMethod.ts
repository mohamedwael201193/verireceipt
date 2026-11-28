// PAYMENT_METHOD_VERIFY_GENERAL — GET /v1/payment-method?bin=<digits>
//
// Zero-LLM. Verifies a card BIN (bank identification number, the first
// 6-8 digits of a card number) against a public BIN database, with a
// SHA-256 receipt over the exact upstream body.
//
// Prefix inputs retain allocation/network-range semantics and never imply a
// checksum.12+digit inputs use local Luhn only; no prefix/provider lookup,
// application evidence/cache/diagnostic retention or number hash. The 256-digit bound limits processing, not card
// validity. Checksum success does not establish that a card exists or works.
// Never use real card numbers in URLs: callers/proxies may retain URL history.
// Application request logging is disabled; diagnostics record key names only.
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
/** Local checksum test utility. GET URL retention outside this application is not controlled. */
export function luhnValid(digits:string):boolean {
 let sum=0,double=false;
 for(let i=digits.length-1;i>=0;i--){let n=digits.charCodeAt(i)-48;if(double){n*=2;if(n>9)n-=9;}sum+=n;double=!double;}
 return sum%10===0;
}
async function checksumOnly(digits:string):Promise<Record<string,unknown>>{
 const luhn=luhnValid(digits),now=new Date().toISOString();
 const scope='Local Luhn checksum only, not issuer allocation, card existence, activity, ownership, available funds or payment authorization. Checksum-only test-number utility: do not submit real card numbers. No number retention applies only to application evidence, cache and diagnostics; no number is sent to a BIN provider. Input arrived in a GET URL: caller, browser, proxy or ingress retention is not controlled.';
 const evidence=JSON.stringify({kind:'local_checksum',checksum_assessed:true,luhn_valid:luhn,valid:luhn,validity_scope:scope,assessed_at:now});
 const receipt=makeReceipt(INTENT,'urn:verireceipt:local-luhn',evidence,'local arithmetic checksum; no card number retained');receipt.fetched_at=now;
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','checksum receipt evidence could not be stored');}
 return envelope(INTENT,{valid:luhn,checksum_assessed:true,luhn_valid:luhn,validity_scope:scope,allocation_known:null,bin:null,network:null,issuing_bank:null,issuing_country:null,card_type:null},receipt,{answer:`Local Luhn checksum ${luhn?'passes':'fails'}. ${scope}`,verdict:'verified',confidence:1,source:'Local checksum arithmetic only; no external card lookup'});
}

/** A digit string with no usable prefix lookup: too short to identify an issuer, or a prefix starting with 0, which the card networks do not use as an issuer prefix.
 * The digits are kept as typed (a leading zero lost to integer typing is not restored). Only a prefix of at most 8 digits is stored. */
async function noLookup(prefix:string,reason:'too_short'|'leading_zero',inputDigits:number):Promise<Record<string,unknown>>{
 const now=new Date().toISOString();
 const note=reason==='too_short'?`${prefix.length} digit${prefix.length===1?'':'s'} is too short to identify an issuer: a card prefix needs at least 6 digits.`:`The prefix ${prefix} starts with 0, which the card networks do not use as an issuer prefix, so no issuer can be identified. If a leading zero was lost to integer typing, send the digits as text.`;
 const scope='Digit-count and first-digit check only; no BIN reference was queried. No card validity, existence, issuer, activity or funds are assessed.';
 const evidence=JSON.stringify({kind:'bin_no_lookup',reason,bin_prefix:prefix,input_digits:inputDigits,valid:false,checksum_assessed:false,luhn_valid:null,validity_scope:scope,assessed_at:now});
 const receipt=makeReceipt(INTENT,'urn:verireceipt:bin-format',evidence,'local digit-count and first-digit check; no BIN reference queried');receipt.fetched_at=now;
 try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
 return envelope(INTENT,{valid:false,bin:prefix,allocation_known:null,network_range_candidates:[],checksum_assessed:false,luhn_valid:null,validity_scope:scope,network:null,issuing_bank:null,issuing_country:null,card_type:null,no_lookup_reason:reason,input_digits:inputDigits},receipt,{answer:`${note} valid=false: no issuer, network, bank, country or card type is reported, and nothing was looked up. ${scope}`,verdict:'verified',confidence:0.9,source:'local digit-count and first-digit check; no external source queried'});
}

export async function handlePaymentMethod(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const input = query.bin?.trim();
  if (!input) throw badRequest("MISSING_PARAM", "bin is required: digits of a card prefix, or 12 or more digits for local checksum only");
  if(/^\d{12,256}$/.test(input))return checksumOnly(input);
  if (!/^\d{1,11}$/.test(input)) throw badRequest("INVALID_BIN", "bin must be digits only: 6 to 8 prefix digits, or 12 to 256 digits for local checksum only");
  if (input.length <= 5) return noLookup(input, "too_short", input.length);
  // 9 to 11 digits: only the first 8 are used, and the rest is discarded and never stored.
  const truncated = input.length >= 9;
  const raw = truncated ? input.slice(0, 8) : input;
  if (raw.startsWith("0")) return noLookup(raw, "leading_zero", input.length);
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
  // A truncated input only counts as valid on a real reference hit, never on a structural network range.
  const valid = truncated ? allocationKnown : (allocationKnown || networkCandidates.length>0);
  // One source has no record and the other failed. A prefix inside a published network range (not truncated from a longer input) still
  // gets a range-only answer; anything else stays a refusal, since no-record cannot be confirmed.
  const partialRange = !allocationKnown && successful.length !== 2;
  if (partialRange && (truncated || networkCandidates.length === 0)) throw upstreamUnavailable("BIN_COVERAGE_INCOMPLETE", "one source has no record and the other is unavailable; cannot confirm no-record");
  const unavailableSources = partialRange ? sources.filter(s => s.error).map(s => s.name) : [];
  const partialExtra = partialRange ? { coverage: "partial_range_only", unavailable_sources: unavailableSources } : {};
  const fields = { network: (i: BinlistReply) => i.scheme, issuing_bank: (i: BinlistReply) => i.bank?.name, issuing_country: (i: BinlistReply) => i.country?.name ?? i.country?.alpha2, card_type: (i: BinlistReply) => i.type };
  const values: Record<string, string | null> = {};
  const fieldSources: Record<string, string | null> = {};
  const conflicts: string[] = [];
  for (const [field, pick] of Object.entries(fields)) {
    const candidates = successful.map(s => ({ s, v: text(pick(s.info)) })).filter(c => c.v);
    values[field] = candidates[0]?.v ?? null; fieldSources[field] = candidates[0]?.s.name ?? null;
    if (new Set(candidates.map(c => field==='network'?c.v!.split('/')[0].trim().toLowerCase():c.v!.toLowerCase())).size > 1) conflicts.push(field);
  }
  const networkCoBrands=successful.flatMap(s=>{const label=text(s.info.scheme);return label?.includes('/')?[{source:s.name,label}]:[];});
  const parentCoverage=successful.filter(s=>s.found&&s.allocationPrefix&&s.allocationPrefix!==raw).map(s=>({source:s.name,requested_bin:raw,allocation_prefix:s.allocationPrefix,scope:raw.length===7?'six-digit parent only; not an exact seven-digit allocation':'six-digit parent only; not an exact eight-digit allocation'}));
  const truncationNote = truncated ? ` The input had ${input.length} digits; only its first 8 were used for the lookup and the remaining digits were discarded, not stored. valid reflects a reference hit only, not a structural network range.` : "";
  const asOf = new Date().toISOString();
  const fetchedAt = successful.map(s => s.fetchedAt).sort()[0];
  const validityScope = "BIN-prefix only: request format/range plus published network range or allocation reference; no checksum assessed; Luhn cannot be assessed from a prefix, not full-card validity";
  const evidence = JSON.stringify({ bin: raw, input_digits: input.length, input_truncated_to_8: truncated, valid,allocation_known:allocationKnown,network_range_candidates:networkCandidates,network_range_source:NETWORK_RANGE_SOURCE,...partialExtra,checksum_assessed:false,luhn_valid:null,validity_scope:validityScope, ...values, network_co_brand_labels:networkCoBrands, field_sources: fieldSources, conflicts, sources, allocation_scope:parentCoverage, attribution: credit, scope: validityScope, as_of: asOf });
  const receipt = makeReceipt(INTENT, sources[0].url, evidence, "two keyless BIN references; exact raw bodies, field provenance, conflicts and original acquisition times; up to24h cache");
  receipt.fetched_at = fetchedAt;
  try { await saveReceipt(receipt, evidence); } catch { throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable"); }
  if (partialRange) values.network = networkCandidates.length === 1 ? networkCandidates[0] : null;
  const { network, issuing_bank, issuing_country, card_type } = values;
  const partialAnswer = `No issuer record available (one reference source unavailable, the other has no record). Prefix matches the published ${networkCandidates.join(", ")} range; valid=true reflects the range only, issuer and country not identified.`;
  const answer = partialRange ? partialAnswer : (allocationKnown ? `Yes, BIN ${raw}${parentCoverage.length ? " has a known six-digit parent allocation reference" : " is an allocated, known card prefix"}: ${network ?? "unknown network"}${card_type ? " " + card_type : ""}${issuing_bank ? ", issued by " + issuing_bank : ""}${issuing_country ? ", " + issuing_country : ""}. ` : `No record for BIN ${raw} in either reference. That is not proof the prefix is unallocated. `) +
    `Prefix valid=${valid}: ${allocationKnown?"allocation reference found":networkCandidates.length?"format and published network range match ("+networkCandidates.join(", ")+"); allocation unknown":"no covered network range or allocation reference; this is not proof of structural invalidity or non-allocation"}. BIN format and allocation-only reference check, no checksum, no guarantee a card is real, active or safe. Sources fetched ${fetchedAt}${sources.some(s => s.cached) ? ", up to24h cache" : ""}.` +
    (sources.some(s => s.error) ? " One source unavailable; partial coverage." : "") + (conflicts.length ? ` Sources disagree on ${conflicts.join(", ")}; binlist.net non-empty fields take precedence.` : "") + truncationNote + (parentCoverage.length?` Parent-prefix coverage only from ${parentCoverage.map(s=>s.source+': '+s.allocation_prefix).join('; ')}; no exact ${raw.length===7?"seven":"eight"}-digit allocation is asserted.`:"") + " " + credit;
  return envelope(INTENT, { bin: raw, input_digits: input.length, input_truncated_to_8: truncated, valid,allocation_known:allocationKnown,network_range_candidates:networkCandidates,checksum_assessed:false,luhn_valid:null,validity_scope:validityScope, ...values, network_co_brand_labels:networkCoBrands, field_sources: fieldSources, source_conflicts: conflicts, allocation_scope:parentCoverage, ...partialExtra, attribution: credit, summary: `${raw}: ${allocationKnown ? parentCoverage.length ? `known parent-prefix reference, no exact ${raw.length===7?"seven":"eight"}-digit allocation asserted` : "known prefix" : "no record"}; prefix-format/network and allocation reference check, no checksum.` }, receipt, { answer, verdict: "verified", confidence: conflicts.length || sources.some(s => s.error) ? 0.6 : 0.9, source: successful.map(s => `${s.name} ${s.url} fetched ${s.fetchedAt}`).join("; ") });
}
