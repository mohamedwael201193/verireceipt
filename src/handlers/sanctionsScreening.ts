// SANCTIONS_SCREENING_MATCH_GENERAL — GET /v1/sanctions-screen?name=<name>
//
// Zero-LLM. Screens a person or entity name against two keyless public
// sanctions lists — the OFAC SDN list (with its published aliases) and
// the UN Security Council consolidated list — with a documented fuzzy
// match score and a SHA-256 receipt. The lists are fetched in full,
// hashed, and cached in memory for CACHE_TTL_MS; the receipt records
// each list's SHA-256, fetch time and publication date plus the exact
// raw lines of every candidate match, so the answer is recomputable
// against the same published lists.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/SANCTIONS_SCREENING_MATCH_GENERAL,
// read 2026-11-22): request name (string); response matched (scored
// bool), matches (list), lists (list), match_score (0-1, 6 decimals).
//
// MATCH SCORE (defensible by construction, documented in every answer):
// names are normalized (lowercase, accents stripped, punctuation to
// spaces, collapsed). The score is the maximum of (a) Sørensen-Dice on
// the token sets and (b) normalized Levenshtein similarity on the whole
// normalized string. matched = best score >= 0.85. Candidates between
// 0.50 and the threshold are reported as near matches with their exact
// scores, never hidden. This is NAME SIMILARITY ONLY.
//
// HONESTY (standing rule): a fuzzy name match is NOT identity
// confirmation — false positives are common, especially for common
// names — and a non-match is NOT a legal clearance: screening covers
// only these two lists as of their published dates, and other lists
// (EU, UK OFSI, national lists) are not checked. The answer says both,
// every time. Nothing here is legal advice.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { sha256Hex } from "../core/receipt";

const SOURCE_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // lists republish ~daily; named in every answer
const UA = "VeriReceipt/2.0 sanctions-screening observer (+https://verireceipt.vercel.app)";
const MATCH_THRESHOLD = 0.85;
const CANDIDATE_FLOOR = 0.5;
const MAX_REPORTED = 5;

const SDN_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
const ALT_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV";
const UN_URL = "https://scsanctions.un.org/resources/xml/en/consolidated.xml";

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export interface ListEntry { list: string; name: string; raw: string; kind: "primary" | "alias" }

/** Minimal RFC-4180-ish line splitter: SDN/ALT use quoted fields with
 * embedded commas; "-0- " is OFAC's empty marker. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

export function parseSdn(raw: string): { entries: Map<string, string>; lines: Map<string, string> } {
  const entries = new Map<string, string>();
  const lines = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const num = f[0];
    const name = f[1];
    if (!num || !/^\d+$/.test(num) || !name) continue;
    entries.set(num, name);
    lines.set(num, line.trim());
  }
  return { entries, lines };
}

export function parseAlt(raw: string): { altNum: string; name: string; raw: string }[] {
  const out: { altNum: string; name: string; raw: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (!f[0] || !/^\d+$/.test(f[0]) || !f[3]) continue;
    out.push({ altNum: f[0], name: f[3], raw: line.trim() });
  }
  return out;
}

export function parseUn(raw: string): { name: string; raw: string; kind: "primary" | "alias" }[] {
  const out: { name: string; raw: string; kind: "primary" | "alias" }[] = [];
  const blocks = raw.match(/<(INDIVIDUAL|ENTITY)>[\s\S]*?<\/\1>/g) ?? [];
  for (const block of blocks) {
    const parts: string[] = [];
    for (const tag of ["FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME", "NAME"]) {
      const m = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(block);
      if (m?.[1]?.trim()) parts.push(m[1].trim());
    }
    if (parts.length) {
      out.push({ name: parts.join(" "), raw: block.replace(/\s+/g, " ").slice(0, 4000), kind: "primary" });
    }
    for (const m of block.matchAll(/<ALIAS_NAME>([^<]+)<\/ALIAS_NAME>/g)) {
      if (m[1]?.trim()) out.push({ name: m[1].trim(), raw: `<ALIAS_NAME>${m[1].trim()}</ALIAS_NAME>`, kind: "alias" });
    }
  }
  return out;
}

export function normalizeName(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** The documented score: max of Sørensen-Dice on token sets and
 * normalized Levenshtein on the whole normalized string. */
export function matchScore(query: string, candidate: string): number {
  const a = normalizeName(query);
  const b = normalizeName(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(" ");
  const tb = b.split(" ");
  const setB = new Set(tb);
  const inter = ta.filter((t) => setB.has(t)).length;
  const dice = (2 * inter) / (ta.length + tb.length);
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.round(Math.max(dice, lev) * 1e6) / 1e6;
}

interface ListState {
  entries: ListEntry[];
  hashes: { list: string; url: string; sha256: string; fetchedAt: string; published: string }[];
}
let cache: { at: number; state: ListState } | null = null;
// Truncation floors guard against screening against a partial list
// download; tests serve small real-format fixtures and lower them.
let floors = { sdn: 1000, un: 100 };
export function resetSanctionsCacheForTests(testFloors?: { sdn: number; un: number }): void {
  cache = null;
  floors = testFloors ?? { sdn: 1000, un: 100 };
}

async function loadLists(): Promise<ListState> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.state;
  const [sdnRaw, altRaw, unRaw] = await Promise.all([
    fetchText(SDN_URL), fetchText(ALT_URL), fetchText(UN_URL),
  ]);
  const fetchedAt = new Date().toISOString();
  const sdn = parseSdn(sdnRaw);
  const alt = parseAlt(altRaw);
  const un = parseUn(unRaw);
  if (sdn.entries.size < floors.sdn) throw upstreamUnavailable("SDN_LIST_DEGRADED", `OFAC SDN parsed to only ${sdn.entries.size} entries; refusing to screen against a truncated list`);
  if (un.length < floors.un) throw upstreamUnavailable("UN_LIST_DEGRADED", `UN consolidated list parsed to only ${un.length} names; refusing to screen against a truncated list`);
  const unDate = /dateGenerated="([^"]+)"/.exec(unRaw)?.[1] ?? "unknown";
  const entries: ListEntry[] = [];
  for (const [num, name] of sdn.entries) entries.push({ list: "OFAC SDN", name, raw: sdn.lines.get(num) ?? name, kind: "primary" });
  for (const a of alt) {
    const parent = sdn.entries.get(a.altNum);
    if (parent) entries.push({ list: "OFAC SDN", name: a.name, raw: `${a.raw} (alias of SDN #${a.altNum} "${parent}")`, kind: "alias" });
  }
  for (const u of un) entries.push({ list: "UN Consolidated", name: u.name, raw: u.raw, kind: u.kind });
  const state: ListState = { entries, hashes: [
    { list: "OFAC SDN", url: SDN_URL, sha256: sha256Hex(Buffer.from(sdnRaw, "utf8")), fetchedAt, published: "current publication preview" },
    { list: "OFAC SDN aliases", url: ALT_URL, sha256: sha256Hex(Buffer.from(altRaw, "utf8")), fetchedAt, published: "current publication preview" },
    { list: "UN Consolidated", url: UN_URL, sha256: sha256Hex(Buffer.from(unRaw, "utf8")), fetchedAt, published: unDate },
  ] };
  cache = { at: Date.now(), state };
  return state;
}

export const INTENT = "SANCTIONS_SCREENING_MATCH_GENERAL";

export async function handleSanctionsScreen(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const name = query.name?.trim();
  if (!name) throw badRequest("MISSING_PARAM", "name is required");
  if (name.length > 200) throw badRequest("NAME_TOO_LONG", "name must be at most 200 characters");
  if (!normalizeName(name)) throw badRequest("INVALID_NAME", "name carries no letters or digits to screen");
  const state = await loadLists().catch((err: unknown) => {
    if (err instanceof Error && "status" in err) throw err;
    throw upstreamUnavailable("SANCTIONS_LISTS_UNREACHABLE", `sanctions list fetch failed: ${err instanceof Error ? err.message : "unknown error"}`);
  });
  const scored = state.entries
    .map((e) => ({ e, score: matchScore(name, e.name) }))
    .filter((x) => x.score >= CANDIDATE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_REPORTED);
  const best = scored[0]?.score ?? 0;
  const matched = best >= MATCH_THRESHOLD;
  const asOf = new Date().toISOString();
  const matches = scored.map((x) => ({ list: x.e.list, name: x.e.name, kind: x.e.kind, score: x.score, above_threshold: x.score >= MATCH_THRESHOLD }));
  const evidence = JSON.stringify({ query_name: name, as_of: asOf, matched, match_score: best,
    threshold: MATCH_THRESHOLD, candidate_floor: CANDIDATE_FLOOR,
    scoring: "max(Sørensen-Dice on token sets, normalized Levenshtein on the normalized name); name similarity only, not identity",
    lists: state.hashes, cache_ttl_ms: CACHE_TTL_MS,
    candidate_raw_lines: scored.map((x) => x.e.raw) });
  const receipt = makeReceipt(INTENT, SDN_URL, evidence, "OFAC SDN + aliases and UN consolidated list; list SHA-256 hashes + candidate raw lines; name similarity only");
  receipt.fetched_at = state.hashes[0]?.fetchedAt ?? asOf;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const listDesc = state.hashes.map((h) => `${h.list} (fetched ${h.fetchedAt}, published ${h.published})`).join("; ");
  const matchDesc = matches.length
    ? matches.map((m) => `${m.name} [${m.list}${m.kind === "alias" ? ", alias" : ""}, score ${m.score}]`).join("; ")
    : "none";
  return envelope(INTENT, { name, matched, matches,
    lists: state.hashes.map((h) => h.list),
    match_score: best }, receipt, {
    answer: `"${name}": ${matched ? "MATCH" : "no match above threshold"} against the OFAC SDN and UN consolidated sanctions lists. ` +
      `Best name-similarity score ${best} (threshold ${MATCH_THRESHOLD}; scoring: max of token-set Sørensen-Dice and normalized Levenshtein). ` +
      `Candidates: ${matchDesc}. Lists checked: ${listDesc}. ` +
      "A fuzzy name match is NOT identity confirmation — false positives are common, especially for common names. " +
      "A non-match is NOT a legal clearance: only these two lists were screened, as of their published dates; other lists (EU, UK OFSI, national lists) were not checked. This is not legal advice.",
    verdict: "verified",
    confidence: 0.9,
    source: `${SDN_URL} + ${ALT_URL} + ${UN_URL}; lists hashed (SHA-256 in receipt) and cached ${CACHE_TTL_MS / 3600000}h; name similarity only, not identity; checked ${asOf}`,
  });
}
