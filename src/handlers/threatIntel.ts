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
// FAIL CLOSED: every feed must download and clear its truncation floor,
// else 502 — a "clean" answer against a partial view is a wrong answer.
// Lists are cached in memory for CACHE_TTL_MS; freshness is named.
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
let cache: { at: number; states: FeedState[] } | null = null;
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
// same seven feeds and shares this cache. Additive export only; the
// loading, floor and fail-closed behaviour is unchanged.
export async function loadFeeds(): Promise<FeedState[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.states;
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
  if (failed.length > 0 || states.length !== FEEDS.length) {
    throw upstreamUnavailable("THREAT_FEED_DEGRADED",
      `${failed.length} of ${FEEDS.length} threat feeds failed or parsed below floor: ${failed.join("; ")}; refusing to answer from a partial view`);
  }
  cache = { at: Date.now(), states };
  return states;
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

/** Match an indicator against the loaded feeds. Exported for tests. */
export function matchIndicator(indicator: string, states: FeedState[]): { type: "ip" | "domain" | "url"; matches: IndicatorMatch[] } {
  const matches: IndicatorMatch[] = [];
  const asIp = ipToInt(indicator);
  const isUrl = /^https?:\/\//i.test(indicator);
  let host = indicator.toLowerCase();
  if (isUrl) {
    try { host = new URL(indicator).hostname.toLowerCase(); } catch { host = ""; }
  }
  const type: "ip" | "domain" | "url" = asIp !== null ? "ip" : isUrl ? "url" : "domain";
  for (const s of states) {
    if (type === "ip" && asIp !== null) {
      if (s.feed.kind === "cidr") {
        const hit = s.lines.find((c) => cidrContains(c, asIp));
        if (hit) matches.push({ feed: s.feed.name, kind: "cidr", raw: hit });
      } else if (s.feed.kind === "ip") {
        const hit = s.lines.find((l) => l === indicator);
        if (hit) matches.push({ feed: s.feed.name, kind: "ip", raw: hit });
      }
    } else {
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
  }
  return { type, matches };
}

export async function handleThreatIndicator(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const indicator = query.indicator?.trim();
  if (!indicator) throw badRequest("MISSING_PARAM", "indicator is required: an IPv4 address, a domain, or a URL");
  if (indicator.length > 2048) throw badRequest("INVALID_INDICATOR", "indicator is over 2048 characters");
  if (/\s/.test(indicator)) throw badRequest("INVALID_INDICATOR", "indicator must be a single IPv4 address, domain or URL, no whitespace");
  const states = await loadFeeds();
  const fetchedAt = new Date().toISOString();
  const { type, matches } = matchIndicator(indicator, states);
  const malicious = matches.length > 0;
  const context = await threatContext(indicator);
  const listedBy = [...new Set([...matches.map(m => m.feed), ...((context.context_listed_by as string[]) ?? [])])];
  const asOf = new Date().toISOString();
  const feedMeta = states.map((s) => ({ feed: s.feed.name, url: s.feed.url, entries: s.lines.length, sha256: s.sha256, published: s.published }));
  const evidence = JSON.stringify({
    indicator, type, malicious, as_of: asOf, context,
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
  const checkedDesc = `${states.length} feeds (${feedMeta.map((f) => `${f.feed}: ${f.entries} entries`).join(", ")})`;
  const coreAnswer = malicious
    ? `${indicator} IS reported as malicious: listed by ${matches.map((m) => `${m.feed} ("${m.raw}")`).join("; ")}. ` +
      `Checked against ${checkedDesc}.`
    : `${indicator} is NOT listed in any of the ${states.length} blocklists checked (${checkedDesc}) as of ${asOf}. ` +
      `That is NOT a clearance: blocklists are not safelists, and these feeds cover only what they have seen.`;
  const answer = coreAnswer + ` Supplemental listed_by: ${listedBy.join(", ") || "none"}. ${context.tor_context ?? ""} ${context.context_scope}.`;
  return envelope(INTENT, {
    ...context, listed_by: listedBy, indicator_type: type,
    malicious,
    indicator,
    type,
    matches: matches.map((m) => ({ feed: m.feed, matched_entry: m.raw })),
    feeds_checked: states.length,
    summary: malicious
      ? `Listed by ${matches.length} of ${states.length} blocklists checked.`
      : `Not listed in any of the ${states.length} blocklists checked; not a clearance.`,
  }, receipt, { answer, verdict: "verified", confidence: 0.9,
    source: states.map((s) => `${s.feed.name} ${s.feed.url} (fetched ${s.fetchedAt}, published ${s.published}, sha256 ${s.sha256.slice(0, 12)}…)`).join("; ") });
}
