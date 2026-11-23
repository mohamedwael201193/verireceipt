// ACADEMIC_SEARCH_GENERAL — GET /v1/academic-search?query=<topic>
//
// Zero-LLM. Searches the Crossref scholarly index for works matching a
// topic and returns the top titles with their DOIs, with a SHA-256
// receipt over the exact upstream response body. Same receipt model,
// same envelope, same honesty language as every other intent.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/ACADEMIC_SEARCH_GENERAL,
// read 2026-11-22): request query (string, required, onchain slot caps
// at 256 bytes); response answer, paper_titles (list), dois (list, same
// order), total_matches (integer [0, 1e8]), brief (<= 80 chars).
//
// SOURCE: Crossref REST API (api.crossref.org) — keyless, public,
// free; the polite pool is joined with a mailto parameter as the
// Crossref docs ask. Probed live 2026-11-23. OpenAlex was evaluated
// first and rejected for now: its anonymous search was rate-limited
// cluster-wide (HTTP 429 "search cluster under elevated load") at probe
// time, so it cannot be the dependable primary.
//
// DOCTRINE: single source, honestly named. A second search engine
// (Semantic Scholar, OpenAlex) indexes a different corpus with a
// different ranking, so two rankings can neither agree nor be averaged
// — the served list is Crossref's own relevance order and says so.
// total_matches is Crossref's index match count, not "all scholarly
// papers on the topic". Items without a title or a DOI are skipped
// (the contract aligns paper_titles with dois) and the skip count is
// recorded in the evidence. Zero matches is a real 200 answer with
// empty lists, never an error. No title, DOI or count is ever invented.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

/** Local fetch with a hard timeout. One fixed public host, query value
 * URL-encoded, so there is no SSRF surface. */
async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export const INTENT = "ACADEMIC_SEARCH_GENERAL";
const SOURCE_TIMEOUT_MS = 5000;
const ROWS = 5;
/** Onchain request slot caps query at 256 bytes. */
const MAX_QUERY_BYTES = 256;
/** Polite-pool contact as the Crossref REST docs request. */
const MAILTO = "verireceipt-dev@proton.me";

export function parseCrossrefWorks(raw: string): { total: number; papers: { title: string; doi: string }[]; skipped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw upstreamUnavailable("CROSSREF_BAD_BODY", "Crossref returned a non-JSON body");
  }
  const message = (parsed as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    throw upstreamUnavailable("CROSSREF_BAD_BODY", "Crossref body has no message object");
  }
  const totalRaw = (message as { "total-results"?: unknown })["total-results"];
  if (typeof totalRaw !== "number" || !Number.isFinite(totalRaw) || totalRaw < 0) {
    throw upstreamUnavailable("CROSSREF_BAD_BODY", "Crossref body has no numeric total-results");
  }
  const items = (message as { items?: unknown }).items;
  const papers: { title: string; doi: string }[] = [];
  let skipped = 0;
  if (Array.isArray(items)) {
    for (const item of items.slice(0, ROWS)) {
      const titles = (item as { title?: unknown }).title;
      const doi = (item as { DOI?: unknown }).DOI;
      const title = Array.isArray(titles) && typeof titles[0] === "string" ? titles[0].trim() : "";
      if (!title || typeof doi !== "string" || !doi.trim()) { skipped++; continue; }
      papers.push({ title, doi: doi.trim() });
    }
  }
  return { total: Math.floor(totalRaw), papers, skipped };
}

export async function handleAcademicSearch(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const q = query.query?.trim();
  if (!q) throw badRequest("MISSING_PARAM", "query is required");
  if (Buffer.byteLength(q, "utf8") > MAX_QUERY_BYTES) {
    throw badRequest("QUERY_TOO_LONG", `query must fit the onchain 256-byte request slot (got ${Buffer.byteLength(q, "utf8")} bytes)`);
  }
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=${ROWS}&mailto=${MAILTO}`;
  const fetchedAt = new Date().toISOString();
  const raw = await fetchText(url, SOURCE_TIMEOUT_MS).catch((err: unknown) => {
    throw upstreamUnavailable("CROSSREF_UNREACHABLE", `Crossref search failed: ${err instanceof Error ? err.message : "unknown error"}`);
  });
  const { total, papers, skipped } = parseCrossrefWorks(raw);
  const asOf = new Date().toISOString();
  const titles = papers.map((p) => p.title);
  const dois = papers.map((p) => p.doi);
  const listing = papers.map((p, i) => `${i + 1}. ${p.title} (DOI ${p.doi})`).join("; ");
  const brief = papers.length
    ? `${papers.length} of ${total} Crossref matches; top: ${papers[0].title}`.slice(0, 80)
    : `No Crossref matches for this query`.slice(0, 80);
  const evidence = JSON.stringify({ query: q, as_of: asOf, total_matches: total,
    papers, skipped_items: skipped,
    source_policy: "Crossref REST API, keyless public polite pool (mailto parameter); single source, Crossref relevance order",
    raw_body: raw, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, url, evidence, "Crossref bibliographic search; relevance order and match count are Crossref's own");
  receipt.fetched_at = fetchedAt;
  await saveReceipt(receipt, evidence);
  // The contract's "answer" response field is the envelope's own
  // answer (meta below); the fields object carries the off-chain lists.
  return envelope(INTENT, {
    paper_titles: titles,
    dois,
    total_matches: total,
    brief,
  }, receipt, {
    answer: papers.length
      ? `Crossref index: ${total} works match "${q}". Top ${papers.length} by Crossref relevance: ${listing}. ` +
        (skipped ? `${skipped} returned item(s) lacked a title or DOI and were skipped. ` : "") +
        "The ranking is Crossref's own relevance order, not a quality judgment; the count is Crossref's index match count, not all scholarly papers on the topic."
      : `Crossref index: no works match "${q}" (0 matches). The Crossref corpus is large but not exhaustive; absence here is not proof no paper exists.`,
    verdict: "verified",
    confidence: 0.9,
    source: `${url}; Crossref REST API single source, Crossref relevance order; fetched ${fetchedAt}; checked ${asOf}`,
  });
}
