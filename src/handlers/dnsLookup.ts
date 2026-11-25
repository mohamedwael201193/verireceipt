// DNS_RECORD_LOOKUP_GENERAL — GET /v1/dns?name=&record_type=
//
// Zero-LLM. Answers whether a domain carries at least one DNS record of
// a requested type using three real, keyless public DNS-over-HTTPS
// resolvers, with a SHA-256 receipt over the exact evidence bytes
// (every answering resolver's raw response body) and the VeriReceipt
// envelope (answer/verdict/confidence/source). How this fits the
// VeriReceipt story: same receipt model, same envelope, same honesty
// language as every other intent — the verdict is only ever what named
// public resolvers actually returned, and the receipt lets any judge
// recompute it.
//
// Intent contract
// (https://devnode.telegraphprotocol.com/engine/v1/intents/DNS_RECORD_LOOKUP_GENERAL,
// read 2026-11-22): inputs name (string, required), record_type (enum
// A/AAAA/CNAME/MX/NS/TXT/SOA/CAA/SRV/PTR, required); scored output
// has_record (bool). Judgment class — the answer text carries the real
// record values and per-resolver verdicts.
//
// RESOLVERS (all keyless, no accounts, identical JSON schema):
//   1. Google Public DNS (dns.google/resolve)
//   2. Cloudflare (cloudflare-dns.com/dns-query, Accept: application/dns-json)
//   3. AdGuard (dns.adguard-dns.com/resolve)
//
// FAILOVER DOCTRINE (owner requirement 2026-11-22): all three fire in
// PARALLEL with a 4 s per-resolver budget plus an 800 ms straggler grace
// once two have answered, so a dead resolver never stalls an answer.
// CORRECTNESS OVER AVAILABILITY: has_record is served only from what
// answering resolvers returned. All answering resolvers agreeing (with
// none failed) is confidence 1.0. A disagreement about record existence
// is refused with DNS_RESOLVERS_DISAGREE, never resolved by an arbitrary
// tie-break or a silent majority. Different record values may reflect
// geo/propagation and are disclosed per resolver. A single answering
// resolver serves its verdict at 0.9 with the failed resolvers named.
// Every resolver erroring with none answering is 502
// DNS_RESOLVERS_DOWN. No record is ever invented.

import {withAnswerClass} from "../core/answerClass";
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, type Receipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { settleWithStragglerGrace } from "./currencyConvert";

export const INTENT = "DNS_RECORD_LOOKUP_GENERAL";

/** Per-resolver hard budget (also the all-hung wall). */
const RESOLVER_TIMEOUT_MS = 4000;
/** Straggler grace once two resolvers have answered. */
const STRAGGLER_GRACE_MS = 800;

/** DoH numeric type codes for the contract's record_type enum. */
const TYPE_CODES: Record<string, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  CAA: 257,
};
export const RECORD_TYPES = Object.keys(TYPE_CODES);

/** Hostname validation: labels of 1-63 chars ([a-z0-9-], not leading/
 * trailing hyphen; a leading underscore is allowed for SRV-style
 * owner names), at least two labels, alphabetic final label, total
 * length <= 253 after stripping one optional trailing dot. */
const LABEL_RE = /^_?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
export function isValidDnsName(raw: string): boolean {
  const name = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (name.length === 0 || name.length > 253) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  if (!/^[a-z]{2,}$/i.test(labels[labels.length - 1])) return false;
  return labels.every((l) => l.length <= 63 && LABEL_RE.test(l));
}

interface ResolverVerdict {
  resolver: string;
  url: string;
  rawBody: string;
  hasRecord: boolean;
  status: number; // DoH Status: 0 NOERROR, 3 NXDOMAIN
  ttl: number | null; // minimum matching-record TTL, null if any is unavailable
  dnssecValidated: boolean | null; // resolver AD assertion, not independent validation
  cnameChain: string[];
  records: string[]; // data fields of answers matching the requested type
}

interface DohAnswer {
  Status?: unknown;
  TC?: unknown;
  AD?: unknown;
  Answer?: Array<{ name?: unknown; type?: unknown; TTL?: unknown; data?: unknown }>;
}

/** Local fetch with a hard per-call timeout and optional headers. The
 * URLs are built from a validated hostname and an enum type code on
 * three fixed public hosts, so there is no SSRF surface (the grid
 * ingester's fetchText is allowlist-bound to grid hosts and cannot be
 * reused here). */
async function fetchText(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers, redirect: "error" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Parse only conclusive NOERROR or NXDOMAIN responses. SERVFAIL,
 * REFUSED, missing status, truncated or malformed bodies are resolver
 * failures, never evidence that a record does not exist. */
export function parseDohVerdict(
  resolver: string,
  url: string,
  rawBody: string,
  typeCode: number,
  requestedName?: string,
): ResolverVerdict {
  const parsed = JSON.parse(rawBody) as DohAnswer;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid DoH response");
  const status = parsed.Status;
  if (status !== 0 && status !== 3) throw new Error(`inconclusive DNS status ${String(status)}`);
  if (parsed.TC === true) throw new Error("truncated DNS response");
  if (parsed.Answer !== undefined && !Array.isArray(parsed.Answer)) throw new Error("invalid DNS Answer list");
  const answers = parsed.Answer ?? [];
  if (answers.some((a) => !a || typeof a.type !== "number" || typeof a.data !== "string" || !a.data.trim())) {
    throw new Error("malformed DNS record");
  }
  if (status === 3 && answers.length > 0) throw new Error("NXDOMAIN conflicts with answer records");
  const normalize = (value: string) => value.replace(/\.$/, "").toLowerCase();
  const cnameChain: string[] = [];
  let owner = requestedName ? normalize(requestedName) : undefined;
  if (owner) {
    const seen = new Set<string>();
    while (true) {
      if (seen.has(owner)) throw new Error("cyclic DNS alias chain");
      seen.add(owner);
      const aliases = answers.filter(a => a.type === 5 && typeof a.name === "string" && normalize(a.name) === owner);
      if (!aliases.length || typeCode === 5) break;
      const targets = [...new Set(aliases.map(a => normalize(String(a.data))))];
      if (targets.length !== 1 || !isValidDnsName(targets[0])) throw new Error("invalid DNS alias chain");
      owner = targets[0];
      cnameChain.push(owner);
    }
  }
  const matching = answers.filter((a) => a.type === typeCode && (!owner ||
    (typeof a.name === "string" && normalize(a.name) === owner)));
  if (owner && typeCode !== 5 && answers.some(a => a.type === typeCode && !matching.includes(a))) {
    throw new Error("DNS answer owner is outside requested alias chain");
  }
  const ttl = matching.length && matching.every(a => typeof a.TTL === "number" && Number.isInteger(a.TTL) && a.TTL >= 0 && a.TTL <= 2147483647)
    ? Math.min(...matching.map(a => a.TTL as number)) : null;
  return {
    resolver,
    url,
    rawBody,
    ttl,
    dnssecValidated: typeof parsed.AD === "boolean" ? parsed.AD : null,
    cnameChain,
    hasRecord: matching.length > 0,
    status,
    records: matching.map((a) => String(a.data ?? "")),
  };
}

const RESOLVERS: Array<{
  name: string;
  query: (name: string, typeCode: number) => Promise<ResolverVerdict>;
}> = [
  {
    name: "Google Public DNS",
    query: async (name, typeCode) => {
      const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${typeCode}`;
      const rawBody = await fetchText(url, RESOLVER_TIMEOUT_MS);
      return parseDohVerdict("Google Public DNS", url, rawBody, typeCode, name);
    },
  },
  {
    name: "Cloudflare",
    query: async (name, typeCode) => {
      const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${typeCode}`;
      const rawBody = await fetchText(url, RESOLVER_TIMEOUT_MS, { accept: "application/dns-json" });
      return parseDohVerdict("Cloudflare", url, rawBody, typeCode, name);
    },
  },
  {
    name: "AdGuard",
    query: async (name, typeCode) => {
      const url = `https://dns.adguard-dns.com/resolve?name=${encodeURIComponent(name)}&type=${typeCode}`;
      const rawBody = await fetchText(url, RESOLVER_TIMEOUT_MS);
      return parseDohVerdict("AdGuard", url, rawBody, typeCode, name);
    },
  },
];

export async function handleDns(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const nameRaw = query.name?.trim();
  const typeRaw = query.record_type?.trim().toUpperCase();
  if (!nameRaw || !typeRaw) {
    throw badRequest("MISSING_PARAM", "name and record_type are required query parameters");
  }
  if (!isValidDnsName(nameRaw)) {
    throw badRequest("INVALID_NAME", `name must be a valid domain name; got "${nameRaw}"`);
  }
  if (!(typeRaw in TYPE_CODES)) {
    throw badRequest(
      "INVALID_RECORD_TYPE",
      `record_type must be one of ${RECORD_TYPES.join(", ")}; got "${typeRaw}"`,
    );
  }
  const name = (nameRaw.endsWith(".") ? nameRaw.slice(0, -1) : nameRaw).toLowerCase();
  const typeCode = TYPE_CODES[typeRaw];

  // All resolvers in parallel, each on its own 4 s budget; the wait ends
  // when all settle or two have answered and the grace elapses.
  const settled = await settleWithStragglerGrace(
    RESOLVERS.map((r) => r.query(name, typeCode)),
    STRAGGLER_GRACE_MS,
    RESOLVER_TIMEOUT_MS + 500,
  );

  const verdicts: ResolverVerdict[] = [];
  const failedResolvers: string[] = [];
  settled.forEach((outcome, i) => {
    if (outcome?.status === "fulfilled" && outcome.value !== null) {
      verdicts.push(outcome.value);
    } else {
      failedResolvers.push(RESOLVERS[i].name);
    }
  });

  if (verdicts.length === 0) {
    throw upstreamUnavailable(
      "DNS_RESOLVERS_DOWN",
      `every DNS resolver errored for ${name} ${typeRaw} (${failedResolvers.join(", ")}); refusing to invent a record`,
    );
  }

  const hasRecord = verdicts[0].hasRecord;
  const agree = verdicts.every((v) => v.hasRecord === hasRecord);
  if (!agree) {
    throw upstreamUnavailable(
      "DNS_RESOLVERS_DISAGREE",
      `resolvers disagree on ${name} ${typeRaw}: ` +
        verdicts.map((v) => `${v.resolver}=${v.hasRecord ? "has record" : "no record"}`).join("; ") +
        "; refusing an unverified existence verdict",
    );
  }
  const degradedReasons: string[] = [];
  if (failedResolvers.length > 0) {
    degradedReasons.push(`resolvers failed: ${failedResolvers.join(", ")}`);
  }
  const confidence = verdicts.length >= 2 && agree && failedResolvers.length === 0 ? 1.0 : 0.9;

  const serving = verdicts.find((v) => v.hasRecord === hasRecord) ?? verdicts[0];
  const nxdomain = serving.status === 3;
  // Equality of observed data strings only, not an assertion of global DNS consistency.
  const recordKey = (v: ResolverVerdict) => JSON.stringify([...new Set(v.records)].sort());
  const recordValuesAgree = verdicts.length >= 2 ? verdicts.every(v => recordKey(v) === recordKey(serving)) : null;
  const resolverDetails = verdicts.map(v => ({
    resolver: v.resolver, status: v.status, has_record: v.hasRecord,
    records: v.records, ttl: v.ttl, dnssec_validated: v.dnssecValidated, cname_chain: v.cnameChain,
  }));
  const recordsText =
    hasRecord && serving.records.length > 0
      ? `: ${serving.records.slice(0, 10).join(", ")}` +
        (serving.records.length > 10 ? ` (10 of ${serving.records.length} shown)` : "")
      : nxdomain
        ? " (NXDOMAIN — the name itself does not exist)"
        : "";
  const answer =
    `${name} ${hasRecord ? `has ${serving.records.length > 0 ? serving.records.length : "at least one"} ${typeRaw} record${serving.records.length === 1 ? "" : "s"}` : `has no ${typeRaw} record`}` +
    recordsText +
    ` according to ${verdicts.map((v) => v.resolver).join(" + ")} (all answering resolvers agree on existence). ` +
    "Resolver evidence: " + verdicts.map((v) =>
      `${v.resolver} [DNS status ${v.status}]: ${v.records.length ? v.records.slice(0, 10).join(", ") + (v.records.length > 10 ? ` (10 of ${v.records.length} shown)` : "") : "no matching records"}`,
    ).join("; ") + "." +
    (typeRaw === "MX" && serving.records.includes("0 .") ? " Null MX explicitly indicates this domain accepts no email." : "");

  // Receipt over the exact evidence bytes: every answering resolver's
  // raw body and verdict. A judge recomputes has_record from the receipt
  // alone.
  const receiptEvidence = JSON.stringify({
    name,
    record_type: typeRaw,
    has_record: hasRecord,
    record_values_agree: recordValuesAgree,
    dnssec_scope: "Resolver AD assertion only; no independent DNSSEC validation",
    resolvers: verdicts.map((v) => ({
      resolver: v.resolver,
      url: v.url,
      status: v.status,
      has_record: v.hasRecord,
      records: v.records,
      ttl: v.ttl,
      dnssec_validated: v.dnssecValidated,
      cname_chain: v.cnameChain,
      raw_body: v.rawBody,
    })),
    failed_resolvers: failedResolvers,
  });
  const receiptDoc: Receipt = makeReceipt(
    INTENT,
    serving.url,
    receiptEvidence,
    `${verdicts.length}/${RESOLVERS.length} DNS-over-HTTPS resolvers`,
  );
  try {
    await saveReceipt(receiptDoc, receiptEvidence);
  } catch {
    // A source observation is not a receipted answer until its evidence is stored.
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }

  const fields: Record<string, unknown> = {
    has_record: hasRecord,
    name,
    record_type: typeRaw,
    records: serving.records,
    ttl: serving.ttl,
    cname_chain: serving.cnameChain,
    resolvers: resolverDetails,
    record_values_agree: recordValuesAgree,
    dnssec_scope: "Resolver AD assertion only; no independent DNSSEC validation",
    resolvers_used: verdicts.map((v) => v.resolver),
  };

  return withAnswerClass(envelope(INTENT, fields, receiptDoc, {
    answer,
    verdict: hasRecord ? "verified" : "not_found",
    confidence,
    source:
      `Keyless public DNS-over-HTTPS resolvers (${verdicts.map((v) => v.resolver).join(" + ")}); ` +
      `has_record is served only from conclusive resolver answers; any disagreement about existence ` +
      `or full resolver outage is refused (502), never guessed` +
      (degradedReasons.length ? `; degraded: ${degradedReasons.join("; ")}` : ""),
  }), INTENT, {record_type:typeRaw,record_result:hasRecord?"found":"empty"});
}
