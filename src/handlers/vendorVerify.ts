import {withAnswerClass} from '../core/answerClass';
import {vendorNameChecks} from './vendorNameChecks';
import {queryFallback} from '../core/queryFallback';
// VENDOR_VERIFY_GENERAL — GET /v1/vendor-verify?vendor=<name>&vat_number=<EU VAT>
//
// Zero-LLM. Verifies an EU VAT registration number against the European
// Commission's VIES service, with a SHA-256 receipt over the exact
// upstream body.
//
// Intent contract (read 2026-11-23): request vendor (string) and
// vat_number (string); scored valid (bool) — "Whether the vendor's
// registration / VAT number is valid (not whether the vendor is
// sanctioned or flagged)".
//
// SOURCE: VIES REST API (ec.europa.eu/taxation_customs/vies/rest-api),
// keyless, probed live 2026-11-23. VIES covers EU member-state VAT
// numbers only; parsed nonmember prefixes are REFUSED (422 SCOPE), never
// guessed against another registry. Malformed identifiers with a vendor trigger
// disclosed name-only research, never VAT verification.
//
// UNPREFIXED NUMBERS (2026-11-28): graded calls supplied a bare national
// number with no country letters, so no VIES lookup could be made and the
// scored `valid` field came back null. When the vendor's trailing legal form
// narrows the member state to one whose published national number format
// matches the bare number exactly, the country is DERIVED and the ordinary
// VIES lookup runs; the answer text and the receipt state that the country was
// derived, and why. Ambiguous or unrecognised shapes stay name-only exactly as
// before, and a failed lookup is never turned into a guess.
//
// SCOPE OF THE ANSWER: VIES confirms the VAT NUMBER is allocated and
// currently valid in its member state, and returns the registered legal
// name/address. It does NOT verify that the vendor string IS that
// company (VIES name matching is deliberately not queried), and a
// valid number says nothing about sanctions, solvency or honesty — the
// answer names all of that. FAIL CLOSED on VIES outage/error (502).
import { ApiError, badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

const SOURCE_TIMEOUT_MS = 4000;
const RETRY_ERRORS = new Set(["MS_MAX_CONCURRENT_REQ", "GLOBAL_MAX_CONCURRENT_REQ", "MS_UNAVAILABLE", "SERVICE_UNAVAILABLE", "TIMEOUT"]);
const UA = "VeriReceipt/2.0 vendor-verify observer (+https://verireceipt.vercel.app)";

export const INTENT = "VENDOR_VERIFY_GENERAL";

// EU member states covered by VIES (XI = Northern Ireland protocol).
const VIES_STATES = new Set(["AT","BE","BG","CY","CZ","DE","DK","EE","EL","ES","FI","FR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","XI"]);

interface ViesReply {
  isValid?: boolean;
  userError?: string;
  name?: string;
  address?: string;
  requestDate?: string;
  vatNumber?: string;
}

function normalizeVat(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s.\-]/g, "");
}

/** Split "LU 26375245" / "lu26375245" / "LU-26375245" into (cc, number). Exported for tests. */
export function parseVatNumber(raw: string): { cc: string; num: string } | null {
  const t = normalizeVat(raw);
  const m = /^([A-Z]{2})([A-Z0-9]{2,14})$/.exec(t);
  if (!m) return null;
  return { cc: m[1], num: m[2] };
}

/** Extract complete VAT-shaped tokens, never infer a number from a name. */
export function extractVat(raw: string): { cc: string; num: string } | null {
  const matches = [...raw.toUpperCase().matchAll(/\b([A-Z]{2}[ .-]*[0-9][A-Z0-9]{1,13}(?:[ .-][0-9]{1,5})*)\b/g)]
    .map((m) => parseVatNumber(m[1])).filter((v): v is { cc: string; num: string } => v !== null);
  const unique = new Map(matches.map((v) => [v.cc + v.num, v]));
  if (unique.size > 1) throw badRequest("AMBIGUOUS_VAT", "multiple VAT-shaped numbers found; supply vat_number explicitly");
  return [...unique.values()][0] ?? null;
}

export function vendorVatInputClass(raw:string){const normalized=normalizeVat(raw);return{vat_has_country_prefix:/^[A-Z]{2}/.test(normalized),vat_length_bucket:normalized.length===0?'empty':normalized.length<4?'short':normalized.length<=16?'normal':'long'};}

// ---- Country derivation for a VAT number supplied without its prefix -----
//
// National VAT number formats, re-checked 2026-11-28 against the European
// Commission's VIES "Format and structure of VAT identification numbers"
// table (VIES FAQ Q11) at https://ec.europa.eu/taxation_customs/vies/#/faq —
// the table itself is served by the VIES application at
// https://ec.europa.eu/taxation_customs/vies/rest-api/translations?lang=en
// (keys faq_label_<CC>format and faq_lbl_<CC>formatdesc, read 2026-11-28).
// Every pattern below is at least as strict as that table: a stricter pattern
// can only decline a derivation, never invent a member state.
const NATIONAL_VAT_FORMATS: Record<string, RegExp> = {
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, // EC: 1 block of 9 characters (ESX9999999X)
  DE: /^\d{9}$/,                 // EC: 1 block of 9 digits (DE999999999)
  AT: /^U\d{8}$/,                // EC: 1 block of 9 characters (ATU99999999)
  NL: /^\d{9}B\d{2}$/,           // EC: 1 block of 12 characters (NLSSSSSSSSSSSS); real structure is 9 digits + B + 2 digits
  BE: /^[01]\d{9}$/,             // EC: 1 block of 10 digits (BE0999999999 / BE1999999999)
  IT: /^\d{11}$/,                // EC: 1 block of 11 digits (IT99999999999)
  FI: /^\d{8}$/,                 // EC: 1 block of 8 digits (FI99999999)
  SE: /^\d{12}$/,                // EC: 1 block of 12 digits (SE999999999999)
  DK: /^\d{8}$/,                 // EC: 4 blocks of 2 digits (DK99 99 99 99)
  PL: /^\d{10}$/,                // EC: 1 block of 10 digits (PL9999999999)
  PT: /^\d{9}$/,                 // EC: 1 block of 9 digits (PT999999999)
  HU: /^\d{8}$/,                 // EC: 1 block of 8 digits (HU99999999)
  CZ: /^\d{8,10}$/,              // EC: 1 block of either 8, 9 or 10 digits
  SK: /^\d{10}$/,                // EC: 1 block of 10 digits (SK9999999999)
  FR: /^[A-Z0-9]{2}\d{9}$/,      // EC: 1 block of 2 characters, 1 block of 9 digits (FRXX 999999999)
  LU: /^\d{8}$/,                 // EC: 1 block of 8 digits (LU99999999)
  RO: /^\d{2,10}$/,              // EC: 1 block of minimum 2 and maximum 10 digits
};

// Trailing legal form -> candidate member states. Only forms narrow enough to
// name a small candidate set are listed; any other suffix derives nothing.
// Keys are normalized: uppercase, no dots, spaces or commas.
const LEGAL_FORM_COUNTRIES: Record<string, string[]> = {
  SL: ["ES"], SLU: ["ES"], SLL: ["ES"], SOCIEDADLIMITADA: ["ES"],
  SPA: ["IT"],
  GMBH: ["DE", "AT"],
  AG: ["DE", "AT"],
  BV: ["NL", "BE"],
  NV: ["BE", "NL"],
  SARL: ["FR", "LU"],
  OY: ["FI"],
  AB: ["SE"],
  APS: ["DK"],
  "A/S": ["DK"],
  SPZOO: ["PL"],
  LDA: ["PT"],
  KFT: ["HU"],
  SRO: ["CZ", "SK"],
  SA: ["ES", "FR", "BE", "LU", "PL", "RO", "PT"],
  SRL: ["IT", "RO", "BE"],
};

export type VatCountryDerivation = { cc: string; num: string; suffix: string; candidates: string[] };
export type VatDerivationLabel = "derived" | "ambiguous" | "no_suffix" | "format_mismatch";

/** The vendor's trailing legal-form token(s) as written, plus their normalized table key. */
function trailingLegalForm(vendor: string): { written: string; key: string } | null {
  const tokens = vendor.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(3, tokens.length); n >= 1; n--) {
    const slice = tokens.slice(tokens.length - n);
    const parts = slice.map((t) => t.replace(/[.,;:]+$/g, "").replace(/\./g, "").toUpperCase());
    if (parts.some((p) => p.length === 0)) continue;
    const key = parts.join("");
    if (Object.prototype.hasOwnProperty.call(LEGAL_FORM_COUNTRIES, key)) {
      return { written: slice.join(" ").replace(/[,;:]+$/g, "").trim(), key };
    }
  }
  return null;
}

function deriveVatCountryDetailed(vendor: string, vatRaw: string): { derivation: VatCountryDerivation | null; label: VatDerivationLabel } {
  const suffix = trailingLegalForm(vendor);
  if (!suffix) return { derivation: null, label: "no_suffix" };
  const candidates = LEGAL_FORM_COUNTRIES[suffix.key];
  const num = normalizeVat(vatRaw);
  const matches = candidates.filter((cc) => NATIONAL_VAT_FORMATS[cc].test(num));
  if (matches.length === 0) return { derivation: null, label: "format_mismatch" };
  if (matches.length > 1) return { derivation: null, label: "ambiguous" };
  return { derivation: { cc: matches[0], num, suffix: suffix.written, candidates: [...candidates] }, label: "derived" };
}

/**
 * Derive the VAT member state from the vendor's legal form and the number's
 * national format. Exported for tests. Returns null unless exactly one
 * candidate country's published format matches the bare number.
 */
export function deriveVatCountry(vendor: string, vatRaw: string): VatCountryDerivation | null {
  return deriveVatCountryDetailed(vendor, vatRaw).derivation;
}

interface ViesLookup {
  url: string;
  body: string;
  attempts: { status?: number; body: string; error?: string }[];
  vies: ViesReply;
  fetchedAt: string;
}

/** Bounded VIES GET with the receipt-bound attempt bodies. */
async function viesLookup(cc: string, num: string): Promise<ViesLookup> {
  const url = `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${cc}/vat/${encodeURIComponent(num)}`;
  const fetchedAt = new Date().toISOString();
  let body = "";
  const attempts: { status?: number; body: string; error?: string }[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    body = "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
    let retry = false;
    let transportError: string | undefined;
    let status: number | undefined;
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
      status = res.status;
      body = await res.text();
    } catch (e) {
      transportError = e instanceof Error ? e.message : "network failure";
    } finally { clearTimeout(timer); }
    attempts.push({ status, body, ...(transportError ? { error: transportError } : {}) });
    if (transportError) {
      if (attempt === 2) throw upstreamUnavailable("VIES_UNREACHABLE", "VIES unavailable after three bounded attempts");
      retry = true;
    } else if (status === 429 || (status !== undefined && status >= 500)) {
      if (attempt === 2) throw upstreamUnavailable("VIES_UNREACHABLE", "VIES HTTP service failure after three bounded attempts");
      retry = true;
    } else if (status === undefined || status < 200 || status >= 300) {
      throw upstreamUnavailable("VIES_UNREACHABLE", `VIES returned non-retryable HTTP ${status ?? "unknown"}`);
    } else {
      try { retry = RETRY_ERRORS.has((JSON.parse(body) as ViesReply).userError ?? "") && attempt < 2; }
      catch { retry = false; }
    }
    if (!retry) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  let vies: ViesReply;
  try {
    vies = JSON.parse(body);
  } catch {
    throw upstreamUnavailable("VIES_MALFORMED", "VIES returned a body that is not JSON; refusing to answer");
  }
  if (typeof vies.isValid !== "boolean") {
    throw upstreamUnavailable("VIES_ERROR", `VIES did not return a validity verdict (userError ${vies.userError ?? "unknown"}); refusing to answer from a partial response`);
  }
  if (vies.userError && !["VALID", "INVALID"].includes(vies.userError)) {
    throw upstreamUnavailable("VIES_ERROR", `VIES reported ${vies.userError} (a service-side limitation, not a verdict on the number); refusing to answer`);
  }
  return { url, body, attempts, vies, fetchedAt };
}

export async function handleVendorVerify(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  query=queryFallback(query,"vendor",text=>text);
  const vendor = query.vendor?.trim();
  if (vendor && vendor.length > 300) throw badRequest("INVALID_VENDOR", "vendor is over 300 characters");
  const vatRaw = query.vat_number?.trim();
  let parsed = vatRaw ? parseVatNumber(vatRaw) : null;
  const invalidVat=!!vatRaw&&!parsed;
  const inputClass=vendorVatInputClass(vatRaw??'');
  if (invalidVat && !vendor) throw withAnswerClass(badRequest("INVALID_VAT", "vat_number must contain a country prefix and national number"),INTENT,inputClass);
  // A bare national number plus a vendor whose legal form names exactly one
  // member state is resolved before the name-only fallback. Malformed
  // (prefix-shaped but unparseable) input never takes this path.
  const derivationAttempt=invalidVat&&vendor&&!inputClass.vat_has_country_prefix?deriveVatCountryDetailed(vendor,vatRaw??''):null;
  const derivation=derivationAttempt?.derivation??null;
  if (derivation) parsed = { cc: derivation.cc, num: derivation.num };
  if (!parsed) {
    const found = Object.values(query).filter((v): v is string => typeof v === "string")
      .map(extractVat).filter((v): v is { cc: string; num: string } => v !== null);
    const unique = new Map(found.map((v) => [v.cc + v.num, v]));
    if (unique.size > 1) throw badRequest("AMBIGUOUS_VAT", "multiple VAT-shaped numbers found; supply vat_number explicitly");
    parsed = [...unique.values()][0] ?? null;
  }
  if(invalidVat&&vendor&&!derivation)return withAnswerClass(await vendorNameChecks(vendor,inputClass.vat_has_country_prefix?'malformed':'missing_country_prefix'),INTENT,{...inputClass,...(derivationAttempt?{vat_derivation:derivationAttempt.label}:{})});
  if (!parsed && vendor) return vendorNameChecks(vendor);
  if (!parsed) return {
    intent:INTENT,vendor:vendor||null,vat_number:null,valid:null,receipt:null,
    answer:`No VAT number was supplied (vendor: ${vendor || 'none given'}). VIES verifies EU VAT numbers only and a vendor name alone is never matched to a registration; no validity verdict is given.`,
    verdict:'no_data',confidence:0,source:'no VAT number supplied; no registry lookup',checked_at:new Date().toISOString(),
  };
  if (!VIES_STATES.has(parsed.cc)) {
    throw unprocessable("VIES_SCOPE", `${parsed.cc} is not a VIES member-state code; only VIES-supported VAT numbers are served; GB HMRC lookup required authentication in the live probe, so no result is guessed`);
  }
  let lookup: ViesLookup;
  try {
    lookup = await viesLookup(parsed.cc, parsed.num);
  } catch (e) {
    // A derived country whose lookup fails is never guessed at: fall back to
    // the name-only research with valid:null and say so, rather than refusing
    // input that used to be answerable.
    if (derivation && vendor && e instanceof ApiError && e.code.startsWith("VIES_")) {
      return withAnswerClass(await vendorNameChecks(vendor, "derived_unavailable"), INTENT, {...inputClass, vat_derivation: "derived"});
    }
    throw e;
  }
  const { url, body, attempts, vies, fetchedAt } = lookup;
  const valid = vies.isValid;
  const registeredName = vies.name && vies.name !== "---" ? vies.name.trim() : null;
  const registeredAddress = vies.address && vies.address !== "---" ? vies.address.trim().replace(/\s+/g, " ") : null;
  const asOf = new Date().toISOString();
  const derivationBasis = derivation ? `vendor legal form ${derivation.suffix} and national number format` : null;
  const evidence = JSON.stringify({
    vendor_queried: vendor ?? null, vat_number: `${parsed.cc}${parsed.num}`,
    ...(derivation && derivationBasis ? { vat_country_derivation: { derived: true, country: derivation.cc, suffix: derivation.suffix, candidates: derivation.candidates, basis: derivationBasis } } : {}),
    valid, registered_name: registeredName, registered_address: registeredAddress,
    vies_request_date: vies.requestDate ?? null,
    scope: "VIES confirms the VAT number's registration in its member state; it does NOT confirm the vendor string is that company, and says nothing about sanctions, solvency or honesty",
    upstream: { url, body, attempts },
    fetched_at: fetchedAt,
  });
  // The receipt hashes this evidence JSON (the enforced doctrine: saved
  // evidence must hash to raw_response_sha256); the exact upstream body
  // is embedded verbatim inside it.
  const receipt = makeReceipt(INTENT, url, evidence, derivationBasis
    ? `single keyless VIES lookup after the member state was derived from the ${derivationBasis}; exact upstream body embedded in receipted evidence`
    : "single keyless VIES lookup; exact upstream body embedded in receipted evidence");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  let answer = valid
    ? `Yes, VAT number ${parsed.cc}${parsed.num} is valid and currently registered in ${parsed.cc === "XI" ? "Northern Ireland (XI)" : parsed.cc} per the EU VIES service (checked ${vies.requestDate ?? asOf})` +
      (registeredName ? `; registered to ${registeredName}${registeredAddress ? `, ${registeredAddress}` : ""}` : "") +
      `. This verifies the number only: VIES does not confirm that "${vendor ?? "unspecified vendor"}" is that company, and validity says nothing about sanctions, solvency or honesty.`
    : `No, VAT number ${parsed.cc}${parsed.num} is NOT currently valid per the EU VIES service (checked ${vies.requestDate ?? asOf}). That is a registry answer about the number, not a judgment about "${vendor ?? "unspecified vendor"}" as a business.`;
  if (!vendor) answer += " No vendor name was supplied; this is number-only verification.";
  if (derivation) {
    answer = `No country prefix was supplied; ${derivation.cc} was derived from the vendor's legal form (${derivation.suffix}) and the number's format. VIES reply: ${valid ? "valid" : "invalid"}. ` + answer;
  }
  const payload = envelope(INTENT, {
    vendor: vendor ?? null,
    vat_number: `${parsed.cc}${parsed.num}`,
    ...(derivation && derivationBasis ? { vat_country_derived: true, vat_country_basis: derivationBasis } : {}),
    valid,
    registered_name: registeredName,
    registered_address: registeredAddress,
    summary: valid
      ? `${parsed.cc}${parsed.num} valid per VIES${registeredName ? ` (${registeredName})` : ""}; number-only verification.`
      : `${parsed.cc}${parsed.num} not valid per VIES.`,
  }, receipt, { answer, verdict: "verified", confidence: 0.9,
    source: `European Commission VIES ${url} (fetched ${asOf}; exact body in receipt)` });
  return derivation ? withAnswerClass(payload, INTENT, {...inputClass, vat_derivation: "derived"}) : payload;
}
