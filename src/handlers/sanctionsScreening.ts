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
// normalized string — with one legal-form rule: when both names reduce
// to the same token set once legal-form tokens (pjsc, llc, ltd, gmbh,
// ...) are dropped, the core is identical and the score is 1; anything
// short of an equal core scores the raw comparison exactly, and a name
// that stripping would empty keeps its tokens. matched = best score >=
// 0.85. Candidates between 0.50 and the threshold are reported as near
// matches with their exact scores, never hidden. This is NAME SIMILARITY
// ONLY.
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

// The parsing/matching primitives live in the pure module ./sanctionsMatch
// (shared with the research desk's independent primary recompute). The
// re-export keeps this module's public surface unchanged.
import { matchScore, normalizeName, parseAlt, parseSdn, parseUn, type ListEntry } from "./sanctionsMatch";
export { matchScore, normalizeName, parseAlt, parseCsvLine, parseSdn, parseUn } from "./sanctionsMatch";
export type { ListEntry } from "./sanctionsMatch";

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
    scoring: "max(Sørensen-Dice on token sets, normalized Levenshtein on the normalized name); names whose token sets are equal once legal-form tokens (pjsc, jsc, llc, ltd, inc, corp, company, gmbh, ...) are dropped score 1; name similarity only, not identity",
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
      `Best name-similarity score ${best} (threshold ${MATCH_THRESHOLD}; scoring: max of token-set Sørensen-Dice and normalized Levenshtein, or 1 when the names' token sets are equal once legal-form tokens are dropped). ` +
      `Candidates: ${matchDesc}. Lists checked: ${listDesc}. ` +
      "A fuzzy name match is NOT identity confirmation — false positives are common, especially for common names. " +
      "A non-match is NOT a legal clearance: only these two lists were screened, as of their published dates; other lists (EU, UK OFSI, national lists) were not checked. This is not legal advice.",
    verdict: "verified",
    confidence: 0.9,
    source: `${SDN_URL} + ${ALT_URL} + ${UN_URL}; lists hashed (SHA-256 in receipt) and cached ${CACHE_TTL_MS / 3600000}h; name similarity only, not identity; checked ${asOf}`,
  });
}
