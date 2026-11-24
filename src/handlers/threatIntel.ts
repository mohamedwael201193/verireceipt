// THREAT_INTELLIGENCE_INDICATOR — GET /v1/threat-indicator?indicator=<ip|domain|url>
//
// Zero-LLM. Checks an IP, domain or URL against keyless public
// threat-intelligence blocklists, with a SHA-256 receipt over the exact
// raw lines that matched. Probed live 2026-11-23: every feed below
// answered. (abuse.ch's ThreatFox/URLhaus APIs went key-gated — 401 —
// and their static exports were retired — 410 — on 2026-11-23; they are
// NOT used. PhishTank's bulk CSV now needs an app key; NOT used.)
//
// Intent contract (read 2026-11-23): request indicator (string);
// scored malicious (bool) — "reported as malicious in
// threat-intelligence feeds".
//
// SOURCES (all keyless, full lists, no keys, no accounts):
//   IPs:
//     1. Spamhaus DROP list (CIDR blocks; a /20 match counts)
//     2. Emerging Threats compromised-ips
//     3. blocklist.de all-attacks
//     4. stamparm/ipsum (IP + number of blacklists reporting it)
//   Domains:
//     5. Phishing.Database ACTIVE domains
//     6. HaGeZi Threat Intelligence Feeds, full wildcard list
//        (malware/C2/phishing; *.d matches d and its subdomains)
//   URLs:
//     7. OpenPhish community feed (full phishing URLs)
// A URL indicator is checked as a full URL against OpenPhish and its
// host is checked against the domain lists.
//
// VERDICT DOCTRINE: malicious = listed in at least one feed, with every
// matching feed and its exact raw line named in the receipt. Absence is
// NOT clearance: "not listed in these 7 feeds as of <fetchedAt>" is
// said every time, and the judged question key 185.220.101.4 (a Tor
// exit) shows why — a feed can delist while the risk stays. The feeds
// are blocklists, not safelists.
//
// Bounded degraded view: at most one missing feed and at least two
// applicable feeds. Only a positive listing supports a boolean answer;
// no-hit incomplete views refuse. URL_SAFE can instead report Unknown.
// Lists are cached in memory for CACHE_TTL_MS; freshness is named.
import { isIP } from "node:net";
import { threatContext } from "./threatContext";
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { sha256Hex } from "../core/receipt";

const SOURCE_TIMEOUT_MS = 30000; // HaGeZi TIF is ~40 MB
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // lists republish every 8-12h; named in every answer
const UA = "VeriReceipt/2.0 threat-indicator observer (+https://verireceipt.vercel.app)";

export const INTENT = "THREAT_INTELLIGENCE_INDICATOR";

interface Feed {
  name: string;
  url: string;
  kind: "ip" | "cidr" | "domain" | "wildcard-domain" | "url";
  floor: number; // truncation floor: fewer parsed entries than this = refuse
}
const FEEDS: Feed[] = [
  { name: "Spamhaus DROP", url: "https://www.spamhaus.org/drop/drop.txt", kind: "cidr", floor: 500 },
  { name: "Emerging Threats compromised-ips", url: "https://rules.emergingthreats.net/blockrules/compromised-ips.txt", kind: "ip", floor: 100 },
  { name: "blocklist.de all-attacks", url: "https://lists.blocklist.de/lists/all.txt", kind: "ip", floor: 5000 },
  { name: "stamparm ipsum", url: "https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt", kind: "ip", floor: 5000 },
  { name: "Phishing.Database ACTIVE domains", url: "https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt", kind: "domain", floor: 100000 },
  { name: "HaGeZi Threat Intelligence Feeds (full)", url: "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/tif.txt", kind: "wildcard-domain", floor: 500000 },
  { name: "OpenPhish community feed", url: "https://openphish.com/feed.txt", kind: "url", floor: 50 },
];

export interface FeedState {
  feed: Feed;
  sha256: string;
  fetchedAt: string;
  published: string; // Last-Modified header or in-file version line, when present
  lines: string[]; // parsed entries (comments/headers stripped)
}
export interface FeedView { states: FeedState[]; unavailable: string[] }
let cache: { at: number; view: FeedView } | null = null;
let floors: Record<string, number> = Object.fromEntries(FEEDS.map((f) => [f.name, f.floor]));
export function resetThreatIntelCacheForTests(testFloors?: Record<string, number>): void {
  cache = null;
  // In tests, floors default to 0 (tiny real excerpts) unless overridden.
  floors = testFloors
    ? { ...Object.fromEntries(FEEDS.map((f) => [f.name, 0])), ...testFloors }
    : Object.fromEntries(FEEDS.map((f) => [f.name, f.floor]));
}

async function fetchText(url: string): Promise<{ body: string; lastModified: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { body: await res.text(), lastModified: res.headers.get("last-modified") ?? "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

function parseEntries(feed: Feed, raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith(";") || t.startsWith("//")) continue;
    if (feed.kind === "cidr") {
      const m = /^(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})/.exec(t);
      if (m) out.push(m[1]);
    } else if (feed.kind === "ip") {
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(t);
      if (m) out.push(m[1]);
    } else if (feed.kind === "wildcard-domain") {
      // HaGeZi wildcard syntax: "*.d" matches d and every subdomain; a
      // bare "d" matches d exactly.
      if (/^(\*\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(t)) out.push(t.toLowerCase());
    } else if (feed.kind === "domain") {
      if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(t)) out.push(t.toLowerCase());
    } else {
      if (/^https?:\/\//i.test(t)) out.push(t);
    }
  }
  return out;
}

// Exported for the URL_SCAN_VERDICT handler, which screens against the
// same seven feeds and shares this cache. Failed/truncated feeds are
// retained as unavailable metadata, never treated as empty clean lists.
export async function loadFeedView(): Promise<FeedView> {
  if (cache && Date.now() - cache.at < (cache.view.unavailable.length ? 60_000 : CACHE_TTL_MS)) return cache.view;
  const settled = await Promise.allSettled(FEEDS.map((f) => fetchText(f.url)));
  const states: FeedState[] = [];
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      failed.push(`${FEEDS[i].name} (${r.reason instanceof Error ? r.reason.message : String(r.reason)})`);
      return;
    }
    const lines = parseEntries(FEEDS[i], r.value.body);
    if (lines.length < (floors[FEEDS[i].name] ?? FEEDS[i].floor)) {
      failed.push(`${FEEDS[i].name} (parsed to only ${lines.length} entries; refusing to screen against a truncated list)`);
      return;
    }
    const version = /^# (?:Last modified|Last update):\s*(.+)$/m.exec(r.value.body)?.[1]?.trim();
    states.push({
      feed: FEEDS[i],
      sha256: sha256Hex(Buffer.from(r.value.body, "utf8")),
      fetchedAt: new Date().toISOString(),
      published: version ?? r.value.lastModified,
      lines,
    });
  });
  const view = { states, unavailable: failed };
  if (failed.length > 1 || states.length < FEEDS.length - 1) {
    throw upstreamUnavailable("THREAT_FEED_DEGRADED", `${failed.length} of ${FEEDS.length} feeds unavailable: ${failed.join("; ")}; too few feeds for bounded screening`);
  }
  cache = { at: Date.now(), view };
  return view;
}

/** Strict loader retained for callers requiring the complete view. */
export async function loadFeeds(): Promise<FeedState[]> {
  const view = await loadFeedView();
  if (view.unavailable.length) throw upstreamUnavailable("THREAT_FEED_DEGRADED", view.unavailable.join("; "));
  return view.states;
}

export function requireBoundedThreatView(view: FeedView, indicator: string, positive: boolean, unknownAllowed = false): void {
  if (!view.unavailable.length) return;
  const host = /^https?:\/\//i.test(indicator) ? canonicalScreeningHost(indicator) : indicator;
  const ip = isIP(host) === 4;
  const url = /^https?:\/\//i.test(indicator);
  const applicable = view.states.filter(s => ip
    ? s.feed.kind === "ip" || s.feed.kind === "cidr" || (url && s.feed.kind === "url")
    : s.feed.kind === "domain" || s.feed.kind === "wildcard-domain" || (url && s.feed.kind === "url"));
  if (view.unavailable.length > 1 || applicable.length < 2 || (!positive && !unknownAllowed)) {
    throw upstreamUnavailable("THREAT_FEED_DEGRADED", `Incomplete threat screening: ${view.unavailable.join("; ")}; no supported definitive verdict`);
  }
}
export function degradedThreatDisclosure(view: FeedView): string {
  return view.unavailable.length ? ` INCOMPLETE SCREENING: unavailable feeds: ${view.unavailable.join("; ")}. Results cover only ${view.states.length} available feeds; missing data is not a clean result.` : "";
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v;
}

function cidrContains(cidr: string, ip: number): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const b = ipToInt(base);
  if (b === null || Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ip ^ b) & mask) === 0;
}

export interface IndicatorMatch { feed: string; kind: Feed["kind"]; raw: string }

/** Reject numeric-host spellings that URL parsing silently rewrites before screening. */
export function canonicalScreeningHost(indicator: string): string {
  let parsed: URL;
  try { parsed = new URL(indicator); }
  catch { throw badRequest("INVALID_INDICATOR", "URL indicator must be a valid absolute HTTP(S) URL"); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || /[\\\x00-\x20]/.test(indicator))
    throw badRequest("INVALID_INDICATOR", "URL indicator requires HTTP(S), no credentials, whitespace, controls or backslashes");
  const authority = /^https?:\/\/([^/?#]+)/i.exec(indicator)?.[1];
  const rawHost = authority?.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority?.split(':')[0];
  const host = parsed.hostname.toLowerCase();
  if (!rawHost || !host) throw badRequest("INVALID_INDICATOR", "URL indicator has no unambiguous host");
  if (host.startsWith('['))
    throw badRequest("UNSUPPORTED_IP_VERSION", "IPv6 URL hosts, including IPv4-mapped forms, are unsupported by the IPv4 feeds; no clean verdict is issued");
  if (isIP(host) === 4 && (rawHost !== host || !rawHost.split('.').every(p => /^(?:0|[1-9][0-9]{0,2})$/.test(p))))
    throw badRequest("AMBIGUOUS_IP_HOST", "IP URL hosts must use canonical dotted-decimal IPv4; numeric, octal, hexadecimal and escaped variants are refused");
  return host;
}

/** Unsupported identifiers must not be reported as absent from domain lists. */
export function validateThreatIndicator(indicator:string):void {
 if(/^https?:\/\//i.test(indicator)){canonicalScreeningHost(indicator);return;}
 if(indicator.endsWith('.')&&/[a-z]/i.test(indicator))indicator=indicator.slice(0,-1);
 if(isIP(indicator)===4)return;
 if(isIP(indicator)===6)throw badRequest('UNSUPPORTED_IP_VERSION','this adapter has IPv4 feeds only; no IPv6 clean verdict is issued');
 if(/^[\d.]+$/.test(indicator)||/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(indicator))throw badRequest('INVALID_INDICATOR','IP must be canonical dotted-decimal IPv4');
 if(!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(indicator))throw badRequest('UNSUPPORTED_INDICATOR_TYPE','only IPv4 addresses, DNS domains and HTTP(S) URLs are covered; CVE identifiers, hashes and other strings are not screened');
}

/** Match an indicator against the loaded feeds. Exported for tests. */
export function matchIndicator(indicator: string, states: FeedState[]): { type: "ip" | "domain" | "url"; matches: IndicatorMatch[] } {
  validateThreatIndicator(indicator);
  const matches: IndicatorMatch[] = [];
  const isUrl = /^https?:\/\//i.test(indicator);
  const host = isUrl ? canonicalScreeningHost(indicator) : indicator.toLowerCase().replace(/\.$/,'');
  const asIp = ipToInt(host);
  const type: "ip" | "domain" | "url" = isUrl ? "url" : asIp !== null ? "ip" : "domain";
  for (const s of states) {
    if (asIp !== null) {
      if (s.feed.kind === "cidr") {
        const hit = s.lines.find((c) => cidrContains(c, asIp));
        if (hit) matches.push({ feed: s.feed.name, kind: "cidr", raw: hit });
      } else if (s.feed.kind === "ip") {
        const hit = s.lines.find((l) => l === host);
        if (hit) matches.push({ feed: s.feed.name, kind: "ip", raw: hit });
      }
    }
    if (s.feed.kind === "url" && isUrl) {
      const hit = s.lines.find((u) => u === indicator);
      if (hit) matches.push({ feed: s.feed.name, kind: "url", raw: hit });
    } else if (s.feed.kind === "domain") {
      // Exact host or any parent domain listed.
      const labels = host.split(".");
      for (let i = 0; i < labels.length - 1; i++) {
        const parent = labels.slice(i).join(".");
        if (s.lines.includes(parent)) { matches.push({ feed: s.feed.name, kind: "domain", raw: parent }); break; }
      }
    } else if (s.feed.kind === "wildcard-domain") {
      // "*.d" matches d and its subdomains; bare "d" matches d exactly.
      if (s.lines.includes(host)) { matches.push({ feed: s.feed.name, kind: "wildcard-domain", raw: host }); continue; }
      const labels = host.split(".");
      for (let i = 0; i < labels.length - 1; i++) {
        const parent = labels.slice(i).join(".");
        if (s.lines.includes(`*.${parent}`)) { matches.push({ feed: s.feed.name, kind: "wildcard-domain", raw: `*.${parent}` }); break; }
      }
    }
  }
  return { type, matches };
}

export async function handleThreatIndicator(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const indicator = query.indicator?.trim();
  if (!indicator) throw badRequest("MISSING_PARAM", "indicator is required: an IPv4 address, a domain, or a URL");
  if (indicator.length > 2048) throw badRequest("INVALID_INDICATOR", "indicator is over 2048 characters");
  if (/\s/.test(indicator)) throw badRequest("INVALID_INDICATOR", "indicator must be a single IPv4 address, domain or URL, no whitespace");
  validateThreatIndicator(indicator);
  const view = await loadFeedView();
  const { states } = view;
  const fetchedAt = new Date().toISOString();
  const { type, matches } = matchIndicator(indicator, states);
  const malicious = matches.length > 0;
  requireBoundedThreatView(view, indicator, malicious);
  const context = await threatContext(indicator);
  const listedBy = [...new Set([...matches.map(m => m.feed), ...((context.context_listed_by as string[]) ?? [])])];
  const asOf = new Date().toISOString();
  const feedMeta = states.map((s) => ({ feed: s.feed.name, url: s.feed.url, entries: s.lines.length, sha256: s.sha256, published: s.published }));
  const evidence = JSON.stringify({
    indicator, type, malicious, as_of: asOf, context, unavailable_feeds: view.unavailable,
    matches: matches.map((m) => ({ feed: m.feed, matched_entry: m.raw })),
    feeds: feedMeta,
    honesty: "a blocklist match means at least one feed lists the indicator; absence means only that NONE of these feeds list it as of their fetch times — blocklists are not safelists, and a delisted indicator is not a cleared one",
    fetched_at: fetchedAt,
  });
  const receipt = makeReceipt(INTENT, `${states.length} keyless blocklists`, evidence, "full-list downloads with truncation floors; every matching raw line receipted");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  // Wording only: keep all loaded feeds/evidence and matching unchanged, but
  // name only the feed kinds relevant to this indicator's host and URL scope.
  const screeningHost = type === "url" ? canonicalScreeningHost(indicator) : indicator.toLowerCase().replace(/\.$/, '');
  const ipHost = isIP(screeningHost) === 4;
  const applicable = states.filter(s => ipHost
    ? s.feed.kind === "ip" || s.feed.kind === "cidr" || (type === "url" && s.feed.kind === "url")
    : s.feed.kind === "domain" || s.feed.kind === "wildcard-domain" || (type === "url" && s.feed.kind === "url"));
  const checkedDesc = `${applicable.length} applicable feeds (${applicable.map(s => s.feed.name).join(", ")})`;
  const coreAnswer = malicious
    ? `${indicator} IS reported as malicious: listed by ${matches.map((m) => `${m.feed} ("${m.raw}")`).join("; ")}. ` +
      `Checked against ${checkedDesc}.`
    : `${indicator} is NOT listed in the ${checkedDesc} as of ${asOf}. ` +
      `That is NOT a clearance: blocklists are not safelists, and these feeds cover only what they have seen.`;
  const answer = coreAnswer + degradedThreatDisclosure(view) + ` Supplemental listed_by: ${listedBy.join(", ") || "none"}. ${context.tor_context ?? ""} ${context.context_scope}.`;
  return envelope(INTENT, {
    ...context, listed_by: listedBy, indicator_type: type,
    malicious,
    indicator,
    type,
    matches: matches.map((m) => ({ feed: m.feed, matched_entry: m.raw })),
    feeds_checked: states.length,
    unavailable_feeds: view.unavailable,
    screening_complete: view.unavailable.length === 0,
    summary: malicious
      ? `Listed by ${matches.length} of ${states.length} blocklists checked.`
      : `Not listed in any of the ${states.length} blocklists checked; not a clearance.`,
  }, receipt, { answer, verdict: "verified", confidence: view.unavailable.length ? 0.65 : 0.9,
    source: states.map((s) => `${s.feed.name} ${s.feed.url} (fetched ${s.fetchedAt}, published ${s.published}, sha256 ${s.sha256.slice(0, 12)}…)`).join("; ") });
}
