// EMAIL_SECURITY_GENERAL means observed DNS status, not email safety or record presence.
// Same source-evidence receipt and envelope as the other VeriReceipt handlers.
import { domainToASCII } from "node:url";
import { DNS_TYPES } from "../core/dnsTypes";
import { badRequest, upstreamUnavailable } from "../core/errors";
import { boundedSourceText, SourceReadError } from "../core/boundedSource";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
export const INTENT = "EMAIL_SECURITY_GENERAL";
const MAX_BODY_BYTES = 256 * 1024;
const SOURCE_TIMEOUT_MS = 900;
export function normalizeEmailDnsName(value: string): string {
  const input = value.trim().replace(/[。．｡]/gu, ".");
  if (input === ".") return ".";
  if (!input || /[\s/@:?#\\%]/u.test(input)) throw badRequest("INVALID_DOMAIN", "domain must be a DNS owner name, not a URL or email address");
  // The sentinel avoids WHATWG IPv4 rewriting of legal numeric DNS owner names.
  const owner = input.endsWith(".") ? input.slice(0, -1) : input;
  const converted = domainToASCII(`${owner}.invalid`).toLowerCase();
  const name = converted.endsWith(".invalid") ? converted.slice(0, -8) : "";
  if (!name || name.length > 253 || !name.split(".").every((label) =>
    label.length <= 63 && /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/i.test(label))) {
    throw badRequest("INVALID_DOMAIN", "domain must be a valid plain DNS owner name (IDNs are converted to ASCII)");
  }
  return name;
}
export function normalizeEmailDnsType(value: string): string {
  const input = value.trim().toUpperCase();
  const numeric = /^(?:TYPE)?(\d+)$/.exec(input);
  if (numeric) {
    const type = Number(numeric[1]);
    if (!Number.isInteger(type) || type < 1 || type > 65535) throw badRequest("INVALID_RECORD_TYPE", "numeric DNS type must be 1-65535");
    return String(type);
  }
  if (input === "*") return "255";
  if (input === "ANY") return "255";
  if (!Object.hasOwn(DNS_TYPES, input)) throw badRequest("INVALID_RECORD_TYPE", "record_type must be an IANA DNS type name or numeric type (1-65535)");
  return input;
}
export function resolveEmailDnsQuery(domain: string, requested: string): { name: string; type: string; mapping: string } {
  const label = requested.trim().toUpperCase();
  const aliases: Record<string, string> = { SPF: "", DMARC: "_dmarc.", DKIM: "", BIMI: "default._bimi.", "MTA-STS": "_mta-sts.", "TLS-RPT": "_smtp._tls." };
  if (Object.hasOwn(aliases, label)) {
    const name = normalizeEmailDnsName(aliases[label] + domain);
    return { name, type: "TXT", mapping: `${label} mapped to TXT at ${name}${label === "DKIM" ? "; no selector supplied or guessed, bare-domain TXT only, not a DKIM selector check" : ""}` };
  }
  try { const type = normalizeEmailDnsType(requested); return { name: domain, type, mapping: `${label} queried as DNS type ${type} at ${domain}` }; }
  catch { return { name: domain, type: "TXT", mapping: `Unrecognized record_type defaulted to TXT at ${domain}; no requested security mechanism inferred` }; }
}
interface DnsObservation { resolver: string; url: string; raw_body: string; fetched_at: string; status: number; truncated: boolean }
export function parseEmailDnsStatus(raw: string, domain: string, type: string): { status: number; truncated: boolean } {
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid DNS object");
  const object = data as Record<string, unknown>;
  const status = object.Status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 4095) throw new Error("missing or invalid DNS status");
  if (object.TC !== undefined && typeof object.TC !== "boolean") throw new Error("invalid DNS truncation flag");
  const questions = object.Question;
  if (!Array.isArray(questions) || questions.length !== 1) throw new Error("missing DNS question binding");
  const question = questions[0] as { name?: unknown; type?: unknown } | null;
  if (!question || typeof question.name !== "string" || typeof question.type !== "number" || !Number.isInteger(question.type)) throw new Error("malformed DNS question");
  const observedName = question.name === "." ? "." : question.name.replace(/\.$/, "").toLowerCase();
  if (observedName !== domain) throw new Error("DNS question name does not match");
  const expectedType = /^\d+$/.test(type) ? Number(type) : DNS_TYPES[type];
  if (question.type < 1 || question.type > 65535 || (expectedType !== undefined && question.type !== expectedType)) throw new Error("DNS question type does not match");
  return { status, truncated: object.TC === true };
}
export async function handleEmailSecurity(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  for (const key of Object.keys(query)) if (!["domain", "record_type"].includes(key)) throw badRequest("UNKNOWN_PARAM", `Unsupported query parameter: ${key}`);
  if (!query.domain?.trim() || !query.record_type?.trim()) throw badRequest("MISSING_PARAM", "domain and record_type are required");
  const domain = normalizeEmailDnsName(query.domain);
  const { name, type, mapping } = resolveEmailDnsQuery(domain, query.record_type);
  // Bounded, structured diagnostic. The prior invalid-label cause is an inference.
  console.info(JSON.stringify({ event: "email_record_type", value: query.record_type.slice(0, 80), truncated: query.record_type.length > 80 }));
  const suffix = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(String(DNS_TYPES[type] ?? type))}`;
  const sources = [
    { resolver: "Google Public DNS", url: `https://dns.google/resolve?${suffix}`, headers: { accept: "application/json" } },
    { resolver: "Cloudflare", url: `https://cloudflare-dns.com/dns-query?${suffix}`, headers: { accept: "application/dns-json" } },
  ];
  const settled = await Promise.allSettled(sources.map(async (source): Promise<DnsObservation> => {
    const fetched = await boundedSourceText(source.url, { timeoutMs: SOURCE_TIMEOUT_MS, maxBytes: MAX_BODY_BYTES, headers: source.headers });
    const status = parseEmailDnsStatus(fetched.raw, name, type);
    return { resolver: source.resolver, url: source.url, raw_body: fetched.raw, fetched_at: fetched.fetchedAt, ...status };
  }));
  const observations = settled.flatMap((row) => row.status === "fulfilled" ? [row.value] : []);
  if (!observations.length) {
    if (settled.every((row) => row.status === "rejected" && row.reason instanceof SourceReadError && row.reason.httpStatus === 400)) {
      throw badRequest("UNSUPPORTED_DNS_QUERY", "Both public resolvers rejected this DNS name/type query");
    }
    throw upstreamUnavailable("EMAIL_DNS_SOURCES_DOWN", "No resolver returned a valid bound DNS response; HTTP errors and timeouts are not DNS false");
  }
  const lookupOk = observations[0].status === 0;
  if (observations.some((row) => (row.status === 0) !== lookupOk)) {
    throw upstreamUnavailable("EMAIL_DNS_STATUS_DISAGREEMENT", "Resolvers disagree on lookup status; refusing to choose a positive or negative result");
  }
  const unavailable = settled.flatMap((row, i) => row.status === "rejected" ? [{ resolver: sources[i].resolver, reason: row.reason instanceof SourceReadError ? row.reason.code : "INVALID_DNS_RESPONSE" }] : []);
  const evidence = JSON.stringify({ domain, queried_name: name, mapping, record_type: type, lookup_ok: lookupOk, rule: "DNS Status 0 is true; other valid DNS statuses are false", observations, unavailable_sources: unavailable });
  const receipt = makeReceipt(INTENT, observations[0].url, evidence, `${observations.length}/2 resolver responses; agreement on DNS lookup status, not email safety`);
  receipt.fetched_at = observations[0].fetched_at;
  await saveReceipt(receipt, evidence);
  const details = observations.map((row) => `${row.resolver}: DNS Status ${row.status}${row.truncated ? " (truncated response)" : ""}`).join("; ");
  return envelope(INTENT, { domain, record_type: type, lookup_ok: lookupOk, dns_statuses: observations.map((row) => ({ resolver: row.resolver, status: row.status, truncated: row.truncated })) }, receipt, {
    answer: `${mapping}. ${name} ${type}: lookup_ok=${lookupOk}. ${details}. This reports DNS lookup status only, not record presence, mailbox delivery, message authenticity or email safety.${unavailable.length ? " Only one resolver returned usable evidence; coverage is degraded." : ""}`,
    verdict: lookupOk ? "verified" : "lookup_failed",
    confidence: unavailable.length ? 0.9 : 1,
    source: `Public DNS-over-HTTPS; exact source responses and query binding are in the receipt. No model or threat-safety inference.`,
  });
}
