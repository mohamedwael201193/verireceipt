import {openAlexAnswer} from './openAlexAcademic';
// ACADEMIC_SEARCH_GENERAL: DOI-bearing scholarly metadata.
// OpenAlex primary, Crossref fallback. Each answer names exactly one index;
// rankings, corpus counts and citation counts are never combined across indexes.
// Both publication year and venue cannot be absent from a returned record.
// Metadata is not proof of quality or peer review. No personal contact is sent.
import { badRequest, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

import {cachedAcademicBody,normalizeAcademicQuery} from './academicSourceCache';
export const INTENT = "ACADEMIC_SEARCH_GENERAL";
const ROWS = 5;
/** Onchain request slot caps query at 256 bytes. */
const MAX_QUERY_BYTES = 256;
/** Public pool, no mailto (maintainer decision 2026-11-23: no
 * personal address in a public repo or third-party logs). The
 * User-Agent identifies the project by its public site instead. */
const UA = "VeriReceipt/2.0 academic-search observer (+https://verireceipt.vercel.app)";

export interface AcademicPaper {
  title: string;
  doi: string;
  authors: string[];
  publication_year: number | null;
  venue: string | null;
  work_type: string | null;
  crossref_citation_count: number | null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function paperMetadata(item: Record<string, unknown>): Omit<AcademicPaper, "title" | "doi"> {
  const authors = Array.isArray(item.author) ? item.author.flatMap((author: unknown) => {
    if (!author || typeof author !== "object" || Array.isArray(author)) return [];
    const a = author as Record<string, unknown>;
    const name = text(a.name) ?? [text(a.given), text(a.family)].filter(Boolean).join(" ");
    return name ? [name] : [];
  }) : [];
  // Only the source's published date. Never substitute deposit/index/create dates.
  const date = item.published as { "date-parts"?: unknown } | null;
  const parts = date && typeof date === "object" ? date["date-parts"] : undefined;
  const year = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : undefined;
  const count = item["is-referenced-by-count"];
  return {
    authors,
    publication_year: typeof year === "number" && Number.isInteger(year) && year >= 1 && year <= 9999 ? year : null,
    venue: Array.isArray(item["container-title"]) ? text(item["container-title"][0]) : null,
    work_type: text(item.type),
    crossref_citation_count: typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null,
  };
}
export function parseCrossrefWorks(raw: string, limit: number = ROWS): { total: number; papers: AcademicPaper[]; skipped: number } {
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
  if (typeof totalRaw !== "number" || !Number.isSafeInteger(totalRaw) || totalRaw < 0 || totalRaw > 1e8) {
    throw upstreamUnavailable("CROSSREF_BAD_BODY", "Crossref body has no numeric total-results");
  }
  const items = (message as { items?: unknown }).items;
  if(!Array.isArray(items))throw upstreamUnavailable("CROSSREF_BAD_BODY","Crossref body has no items array");
  const papers: AcademicPaper[] = [];
  let skipped = 0;
  if (Array.isArray(items)) {
    for (const item of items.slice(0, limit)) {
      if(!item || typeof item!=="object"){skipped++;continue;}
      const titles = (item as { title?: unknown }).title;
      const doi = (item as { DOI?: unknown }).DOI;
      const title = Array.isArray(titles) && typeof titles[0] === "string" ? titles[0].trim() : "";
      if (!title || typeof doi !== "string" || !doi.trim()) { skipped++; continue; }
      papers.push({ title, doi: doi.trim(), ...paperMetadata(item as Record<string, unknown>) });
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
  let year:number|undefined;
  if(query.year!==undefined){year=Number(query.year);if(!/^\d{4}$/.test(query.year)||!Number.isInteger(year)||year<1000||year>new Date().getUTCFullYear())throw badRequest('INVALID_YEAR','year must be a four-digit publication year, not in the future');}
  const currentYear=new Date().getUTCFullYear();
  const recent=/\b(?:recent|latest|new|current|this\s+year)\b/i.test(q)?{minYear:year??currentYear-3,maxYear:year??currentYear}:undefined;
  try{return await openAlexAnswer(q,year,recent);}catch(error){if((error as any)?.code==='RECEIPT_PERSIST_FAILED')throw error;}
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(normalizeAcademicQuery(q))}&rows=${recent?20:ROWS}${recent?`&filter=from-pub-date:${recent.minYear}-01-01,until-pub-date:${recent.maxYear}-12-31&sort=published&order=desc`:year?`&filter=from-pub-date:${year}-01-01,until-pub-date:${year}-12-31`:""}`;
  const observation = await cachedAcademicBody(recent?`${q} recent:${recent.minYear}-${recent.maxYear} citations:1`:year?`${q} year:${year}`:q,url,UA,body=>{parseCrossrefWorks(body);}).catch((err:unknown)=>{
    if(err&&typeof err==='object'&&'code' in err)throw err;
    throw upstreamUnavailable('CROSSREF_UNREACHABLE','Both scholarly sources unavailable');
  });
  const {body:raw,fetchedAt,staleReason}=observation;
  const ageSeconds=Math.floor((Date.now()-Date.parse(fetchedAt))/1000),stale=Boolean(staleReason);
  const parsedWorks=parseCrossrefWorks(raw,recent?20:ROWS);
  const total=parsedWorks.total,eligible=parsedWorks.papers.filter(p=>(p.publication_year!==null||p.venue!==null)&&(year===undefined||p.publication_year===year)&&(!recent||(p.publication_year!==null&&p.publication_year>=recent.minYear&&p.publication_year<=recent.maxYear&&p.crossref_citation_count!==null&&p.crossref_citation_count>=1)));
  if(recent){const items=JSON.parse(raw).message.items;const date=(p:AcademicPaper)=>{const parts=items.find((r:any)=>r.DOI===p.doi)?.published?.['date-parts']?.[0];return Array.isArray(parts)?[parts[0],String(parts[1]??1).padStart(2,'0'),String(parts[2]??1).padStart(2,'0')].join('-'):String(p.publication_year);};eligible.sort((a,b)=>date(b).localeCompare(date(a))||(b.crossref_citation_count??0)-(a.crossref_citation_count??0));}
  const papers=eligible.slice(0,ROWS),skipped=parsedWorks.skipped+parsedWorks.papers.length-eligible.length;
  const asOf = fetchedAt;
  const titles = papers.map((p) => p.title);
  const dois = papers.map((p) => p.doi);
  const listing = papers.map((p, i) => `${i + 1}. ${p.title} (` + [
    p.authors.length ? p.authors.join(", ") : "authors unavailable",
    p.publication_year === null ? "publication year unavailable" : String(p.publication_year),
    p.venue ?? "venue unavailable",
    p.work_type ? `type ${p.work_type}` : "work type unavailable",
    p.crossref_citation_count === null ? "Crossref citation count unavailable" : `${p.crossref_citation_count} Crossref citations`,
    `DOI ${p.doi}`,
  ].join("; ") + ")").join("; ");
  // Code-point-safe 80-cell brief: a naive .slice(0, 80) can split a
  // UTF-16 surrogate pair and emit a lone surrogate.
  const briefRaw = papers.length
    ? `${papers.length} of ${total} Crossref matches; top: ${papers[0].title}`
    : `No Crossref matches for this query`;
  const brief = Array.from((stale ? "STALE cached search; " : "")+briefRaw).slice(0, 80).join("");
  const evidence = JSON.stringify({ query: q, as_of: asOf, total_matches: total,...(recent?{recent_window:recent,citation_floor:1,sort:'publication date descending'}:{}),
    papers, skipped_items: skipped, stale, stale_reason:staleReason, age_seconds:ageSeconds,
    source_policy: "Crossref REST API, keyless public pool (no mailto: maintainer decision 2026-11-23; project User-Agent instead); single source; sorting mode disclosed",
    raw_body: raw, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, url, evidence, recent?'Crossref recent bibliographic search; publication date order with citation floor':"Crossref bibliographic search; relevance order and match count are Crossref's own");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    // A search result is not a receipted answer until its evidence is stored.
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  // The contract's "answer" response field is the envelope's own
  // answer (meta below); the fields object carries the off-chain lists.
  return envelope(INTENT, {
    papers,...(recent?{recent_window:recent,citation_floor:1,sort:'publication date descending'}:{}),
    metadata_scope: "Crossref deposited metadata; work type is not proof of peer review; citation counts are Crossref-only",
    paper_titles: titles,
    dois,
    total_matches: total,
    brief, as_of:asOf, fetched_at:fetchedAt, age_seconds:ageSeconds, stale, ...(stale?{stale_reason:staleReason}:{}),
  }, receipt, {
    answer: (recent?`Recent publication window ${recent.minYear}-${recent.maxYear}; at least 1 Crossref citation; newest publication first. `:'') + (stale ? `STALE CACHED SEARCH, not a current index query. ${staleReason}; exact result acquired ${fetchedAt}, age ${ageSeconds}s, no titles or counts updated. ` : `Crossref observation acquired ${fetchedAt}, age ${ageSeconds}s; may be cached up to15minutes. `) + (papers.length
      ? `Crossref index: ${total} works match "${q}". Top ${papers.length} by ${recent?'publication date':'Crossref relevance'}: ${listing}. ` +
        (skipped ? `${skipped} returned item(s) lacked title/DOI or both publication year and venue, or did not meet the year/citation filter, and were skipped. ` : "") +
        (recent?"The ranking uses publication date after the citation floor, not a quality judgment;":"The ranking is Crossref's own relevance order, not a quality judgment;")+ " the count is Crossref's index match count, not all scholarly papers on the topic. Metadata is as deposited; work type is not proof of peer review, and citation counts are Crossref-only."
      : `Crossref index: ${total} query matches, but no eligible DOI-bearing records in the returned sample${year?` for ${year}`:""}. Records missing both publication year and venue are omitted. Absence in this sample is not proof no paper exists.`),
    verdict: stale ? "stale" : "verified",
    confidence: stale ? 0.5 : 0.9,
    source: `${url}; Crossref REST API single source, ${recent?'publication date order with citation floor':'Crossref relevance order'}; fetched ${fetchedAt}; acquired ${asOf}`,
  });
}
