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
// SCOPE OF THE ANSWER: VIES confirms the VAT NUMBER is allocated and
// currently valid in its member state, and returns the registered legal
// name/address. It does NOT verify that the vendor string IS that
// company (VIES name matching is deliberately not queried), and a
// valid number says nothing about sanctions, solvency or honesty — the
// answer names all of that. FAIL CLOSED on VIES outage/error (502).
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
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

/** Split "LU 26375245" / "lu26375245" / "LU-26375245" into (cc, number). Exported for tests. */
export function parseVatNumber(raw: string): { cc: string; num: string } | null {
  const t = raw.trim().toUpperCase().replace(/[\s.\-]/g, "");
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

export function vendorVatInputClass(raw:string){const normalized=raw.trim().toUpperCase().replace(/[\s.\-]/g,'');return{vat_has_country_prefix:/^[A-Z]{2}/.test(normalized),vat_length_bucket:normalized.length===0?'empty':normalized.length<4?'short':normalized.length<=16?'normal':'long'};}

export async function handleVendorVerify(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  query=queryFallback(query,"vendor",text=>text);
  const vendor = query.vendor?.trim();
  if (vendor && vendor.length > 300) throw badRequest("INVALID_VENDOR", "vendor is over 300 characters");
  const vatRaw = query.vat_number?.trim();
  let parsed = vatRaw ? parseVatNumber(vatRaw) : null;
  const invalidVat=!!vatRaw&&!parsed;
  const inputClass=vendorVatInputClass(vatRaw??'');
  if (invalidVat && !vendor) throw withAnswerClass(badRequest("INVALID_VAT", "vat_number must contain a country prefix and national number"),INTENT,inputClass);
  if (!parsed) {
    const found = Object.values(query).filter((v): v is string => typeof v === "string")
      .map(extractVat).filter((v): v is { cc: string; num: string } => v !== null);
    const unique = new Map(found.map((v) => [v.cc + v.num, v]));
    if (unique.size > 1) throw badRequest("AMBIGUOUS_VAT", "multiple VAT-shaped numbers found; supply vat_number explicitly");
    parsed = [...unique.values()][0] ?? null;
  }
  if(invalidVat&&vendor)return withAnswerClass(await vendorNameChecks(vendor,inputClass.vat_has_country_prefix?'malformed':'missing_country_prefix'),INTENT,inputClass);
  if (!parsed && vendor) return vendorNameChecks(vendor);
  if (!parsed) return {
    intent:INTENT,vendor:vendor||null,vat_number:null,valid:null,receipt:null,
    answer:`No VAT number was supplied (vendor: ${vendor || 'none given'}). VIES verifies EU VAT numbers only and a vendor name alone is never matched to a registration; no validity verdict is given.`,
    verdict:'no_data',confidence:0,source:'no VAT number supplied; no registry lookup',checked_at:new Date().toISOString(),
  };
  if (!VIES_STATES.has(parsed.cc)) {
    throw unprocessable("VIES_SCOPE", `${parsed.cc} is not a VIES member-state code; only VIES-supported VAT numbers are served; GB HMRC lookup required authentication in the live probe, so no result is guessed`);
  }
  const url = `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${parsed.cc}/vat/${encodeURIComponent(parsed.num)}`;
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
  const valid = vies.isValid;
  const registeredName = vies.name && vies.name !== "---" ? vies.name.trim() : null;
  const registeredAddress = vies.address && vies.address !== "---" ? vies.address.trim().replace(/\s+/g, " ") : null;
  const asOf = new Date().toISOString();
  const evidence = JSON.stringify({
    vendor_queried: vendor ?? null, vat_number: `${parsed.cc}${parsed.num}`,
    valid, registered_name: registeredName, registered_address: registeredAddress,
    vies_request_date: vies.requestDate ?? null,
    scope: "VIES confirms the VAT number's registration in its member state; it does NOT confirm the vendor string is that company, and says nothing about sanctions, solvency or honesty",
    upstream: { url, body, attempts },
    fetched_at: fetchedAt,
  });
  // The receipt hashes this evidence JSON (the enforced doctrine: saved
  // evidence must hash to raw_response_sha256); the exact upstream body
  // is embedded verbatim inside it.
  const receipt = makeReceipt(INTENT, url, evidence, "single keyless VIES lookup; exact upstream body embedded in receipted evidence");
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
  return envelope(INTENT, {
    vendor: vendor ?? null,
    vat_number: `${parsed.cc}${parsed.num}`,
    valid,
    registered_name: registeredName,
    registered_address: registeredAddress,
    summary: valid
      ? `${parsed.cc}${parsed.num} valid per VIES${registeredName ? ` (${registeredName})` : ""}; number-only verification.`
      : `${parsed.cc}${parsed.num} not valid per VIES.`,
  }, receipt, { answer, verdict: "verified", confidence: 0.9,
    source: `European Commission VIES ${url} (fetched ${asOf}; exact body in receipt)` });
}
