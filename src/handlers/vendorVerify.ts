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
// numbers only; any other tax identifier is REFUSED (422 SCOPE), never
// guessed against another registry.
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

const SOURCE_TIMEOUT_MS = 15000;
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

export async function handleVendorVerify(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const vendor = query.vendor?.trim();
  if (!vendor) throw badRequest("MISSING_PARAM", "vendor is required: the vendor or company name");
  if (vendor.length > 300) throw badRequest("INVALID_VENDOR", "vendor is over 300 characters");
  const vatRaw = query.vat_number?.trim();
  if (!vatRaw) throw badRequest("MISSING_PARAM", "vat_number is required, e.g. LU26375245");
  const parsed = parseVatNumber(vatRaw);
  if (!parsed) throw badRequest("INVALID_VAT", "vat_number must be an EU VAT number: two-letter country code plus the national number, e.g. LU26375245");
  if (!VIES_STATES.has(parsed.cc)) {
    throw unprocessable("VIES_SCOPE", `${parsed.cc} is not a VIES member-state code; only EU VAT numbers can be verified keyless — no other registry is guessed`);
  }
  const url = `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${parsed.cc}/vat/${encodeURIComponent(parsed.num)}`;
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
  } catch (e) {
    throw upstreamUnavailable("VIES_UNREACHABLE", `the VIES service could not be reached: ${e instanceof Error ? e.message : String(e)}`);
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
    vendor_queried: vendor, vat_number: `${parsed.cc}${parsed.num}`,
    valid, registered_name: registeredName, registered_address: registeredAddress,
    vies_request_date: vies.requestDate ?? null,
    scope: "VIES confirms the VAT number's registration in its member state; it does NOT confirm the vendor string is that company, and says nothing about sanctions, solvency or honesty",
    upstream: { url, body },
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
  const answer = valid
    ? `Yes, VAT number ${parsed.cc}${parsed.num} is valid and currently registered in ${parsed.cc === "XI" ? "Northern Ireland (XI)" : parsed.cc} per the EU VIES service (checked ${vies.requestDate ?? asOf})` +
      (registeredName ? `; registered to ${registeredName}${registeredAddress ? `, ${registeredAddress}` : ""}` : "") +
      `. This verifies the number only: VIES does not confirm that "${vendor}" is that company, and validity says nothing about sanctions, solvency or honesty.`
    : `No, VAT number ${parsed.cc}${parsed.num} is NOT currently valid per the EU VIES service (checked ${vies.requestDate ?? asOf}). That is a registry answer about the number, not a judgment about "${vendor}" as a business.`;
  return envelope(INTENT, {
    vendor,
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
