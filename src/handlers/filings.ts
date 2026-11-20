// REGULATORY_FILING_MONITOR_GENERAL handler.
// Zero-LLM. No mocks/fakes in handler logic. Every answer is derived from a
// live upstream response (SEC EDGAR Submissions API for entities that resolve
// to a CIK; Federal Register API v1 ONLY for entities that do not resolve to
// a CIK, i.e. agency / rule-topic queries) and carries a SHA-256 receipt over
// the raw response.
//
// Failover rule: Federal Register is a full-text term search whose hits are
// never checked against the entity, so it must NEVER stand in for a resolved
// company's filings. When a CIK resolved and EDGAR is down, the handler fails
// CLOSED with 502 SEC_UNAVAILABLE instead of misattributing FedReg hits.
//
// Quorum note: quorum_votes is "1/1 primary source" — a single authoritative
// source (SEC EDGAR, or Federal Register on failover). The multi-source
// quorum layer used by other intents does not apply here; there is exactly
// one authoritative registry per entity, so one primary source is the whole
// verification.

import { ApiError, badRequest, unprocessable, upstreamUnavailable } from '../core/errors';
import { envelope, makeReceipt } from '../core/receipt';

export const INTENT = 'REGULATORY_FILING_MONITOR_GENERAL';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const EDGAR_SUBMISSIONS_URL = (cik10: string): string =>
  `https://data.sec.gov/submissions/CIK${cik10}.json`;
const FEDREG_URL = (entity: string): string =>
  `https://www.federalregister.gov/api/v1/documents.json?conditions%5Bterm%5D=${encodeURIComponent(
    entity,
  )}&conditions%5Btype%5D%5B%5D=RULE&per_page=20`;

const TICKERS_TTL_MS = 24 * 60 * 60 * 1000;

export interface Filing {
  form: string;
  accession: string;
  filing_date: string;
  url: string;
}

export interface Period {
  /** Inclusive start, YYYY-MM-DD. */
  start: string;
  /** Inclusive end, YYYY-MM-DD. */
  end: string;
  /** The period string as requested, for the answer sentence. */
  label: string;
}

/** Optional transport override — used only by tests to inject fixtures. */
export interface FilingsDeps {
  fetchImpl?: typeof fetch;
}

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

type TickersMap = Record<string, TickerEntry>;

// ---------------------------------------------------------------------------
// Period parsing
// ---------------------------------------------------------------------------

function isValidDateString(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  );
}

function formatUtcDate(dt: Date): string {
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * Parse the requested period into an inclusive [start, end] date range.
 * Accepted forms: "last N months", "YYYY", "YYYY-MM-DD..YYYY-MM-DD".
 * Throws a 400 ApiError for anything else.
 */
export function parsePeriod(periodRaw: string): Period {
  const period = periodRaw.trim();

  const lastMonths = /^last\s+(\d+)\s+months?$/i.exec(period);
  if (lastMonths) {
    const n = Number(lastMonths[1]);
    if (!Number.isInteger(n) || n < 1 || n > 1200) {
      throw badRequest('INVALID_PERIOD', `Unparseable period: "${periodRaw}"`);
    }
    const now = new Date();
    const end = formatUtcDate(now);
    // Clamp the day: setUTCMonth overflows (Mar 31 minus 1 month -> Mar 3),
    // silently dropping late-Feb / early-Mar filings. Compute the target
    // year/month first, then clamp to the target month's last day.
    const targetMonthIndex = now.getUTCMonth() - n;
    const targetYear = now.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
    const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const day = Math.min(now.getUTCDate(), daysInTargetMonth);
    const startDt = new Date(Date.UTC(targetYear, targetMonth, day));
    return { start: formatUtcDate(startDt), end, label: period };
  }

  const yearOnly = /^(\d{4})$/.exec(period);
  if (yearOnly) {
    const y = yearOnly[1];
    const yNum = Number(y);
    // EDGAR submissions data effectively starts ~1993; a year outside
    // 1993..current year can never hold filings, so reject it instead of
    // answering a "verified" zero.
    const currentYear = new Date().getUTCFullYear();
    if (yNum < 1993 || yNum > currentYear) {
      throw badRequest('INVALID_PERIOD', `Unparseable period: "${periodRaw}"`);
    }
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: period };
  }

  const range = /^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/.exec(period);
  if (range) {
    const start = range[1];
    const end = range[2];
    if (!isValidDateString(start) || !isValidDateString(end) || start > end) {
      throw badRequest('INVALID_PERIOD', `Unparseable period: "${periodRaw}"`);
    }
    return { start, end, label: period };
  }

  throw badRequest('INVALID_PERIOD', `Unparseable period: "${periodRaw}"`);
}

/** Keep only filings whose filing_date falls inside the period (inclusive). */
export function filterFilingsByPeriod(filings: Filing[], period: Period): Filing[] {
  return filings.filter((f) => f.filing_date >= period.start && f.filing_date <= period.end);
}

// ---------------------------------------------------------------------------
// CIK resolution
// ---------------------------------------------------------------------------

export interface CikMatch {
  cik: number;
  /** 10-digit zero-padded CIK string. */
  cik10: string;
  /** "ticker" | "cik" | "name" — how the entity resolved. */
  matchKind: 'ticker' | 'cik' | 'name';
}

function padCik(cik: number): string {
  return String(cik).padStart(10, '0');
}

/**
 * Single-token queries too generic to identify a company: bare articles,
 * corporate suffixes and other stopwords. As a whole-entity query they match
 * arbitrary companies ("a" -> Apple Inc., "the" -> The9 Ltd, "co" -> 3M,
 * "inc" -> HP Inc.) and must never resolve by name substring. Exact-ticker
 * and bare-CIK matches are checked before this set applies, so a real 1-2
 * letter ticker still resolves.
 */
const GENERIC_ENTITY_TOKENS = new Set([
  'a',
  'an',
  'the',
  'and',
  'of',
  'co',
  'inc',
  'corp',
  'corporation',
  'ltd',
  'llc',
  'lp',
  'llp',
  'plc',
  'company',
  'group',
  'holdings',
]);

/**
 * True when the entity, as a whole query, is too generic to identify a
 * company: shorter than 3 characters, or a single generic token.
 */
export function isTooGenericEntity(entity: string): boolean {
  const trimmed = entity.trim();
  if (trimmed.length < 3) return true;
  const token = trimmed.toLowerCase().replace(/\.+$/, '');
  return !/\s/.test(token) && GENERIC_ENTITY_TOKENS.has(token);
}

/**
 * Resolve an entity against a company_tickers.json map.
 * Priority: (1) all-digit entity = CIK directly; (2) case-insensitive exact
 * ticker; (3) case-insensitive company-name substring (shortest title wins,
 * ties broken by lowest CIK, so the result is deterministic).
 * Name matching requires minimum specificity: queries shorter than 3
 * characters, or a single generic token, never match by name, and a match
 * must start on a word/token boundary (so "pple" does not resolve to Apple).
 * Returns null when nothing matches.
 */
export function resolveCikFromTickers(entity: string, tickers: TickersMap): CikMatch | null {
  const trimmed = entity.trim();

  if (/^\d{1,10}$/.test(trimmed)) {
    const cik = Number(trimmed);
    if (cik > 0) return { cik, cik10: padCik(cik), matchKind: 'cik' };
    return null;
  }

  const entries = Object.values(tickers);
  const upper = trimmed.toUpperCase();

  for (const e of entries) {
    if (typeof e.ticker === 'string' && e.ticker.toUpperCase() === upper) {
      return { cik: e.cik_str, cik10: padCik(e.cik_str), matchKind: 'ticker' };
    }
  }

  // Name-substring matching needs minimum specificity: queries shorter than
  // 3 characters, or a single generic token ("the", "inc", ...), never match
  // by name (exact tickers and bare CIKs above are unaffected). The match
  // must also start on a word/token boundary, so mid-word fragments such as
  // "pple" do not silently resolve to an arbitrary company.
  if (isTooGenericEntity(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundaryRe = new RegExp(`\\b${escaped}`);
  let best: TickerEntry | null = null;
  for (const e of entries) {
    if (typeof e.title !== 'string') continue;
    if (!boundaryRe.test(e.title.toLowerCase())) continue;
    if (
      best === null ||
      e.title.length < best.title.length ||
      (e.title.length === best.title.length && e.cik_str < best.cik_str)
    ) {
      best = e;
    }
  }
  if (best) {
    return { cik: best.cik_str, cik10: padCik(best.cik_str), matchKind: 'name' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// SEC company_tickers.json cache (in-memory, 24h TTL)
// ---------------------------------------------------------------------------

let tickersCache: { data: TickersMap; fetchedAt: number } | null = null;

/** Test hook: clear the in-memory tickers cache. */
export function __clearTickersCacheForTests(): void {
  tickersCache = null;
}

/** Test hook: seed the in-memory tickers cache (avoids a live fetch). */
export function __seedTickersCacheForTests(data: TickersMap): void {
  tickersCache = { data, fetchedAt: Date.now() };
}

async function loadTickers(fetchImpl: typeof fetch): Promise<TickersMap> {
  const now = Date.now();
  if (tickersCache && now - tickersCache.fetchedAt < TICKERS_TTL_MS) {
    return tickersCache.data;
  }
  let res: Response;
  try {
    res = await fetchImpl(TICKERS_URL, {
      headers: { 'User-Agent': requireUserAgent(), Accept: 'application/json' },
    });
  } catch (err) {
    if (tickersCache) return tickersCache.data; // stale cache beats no data
    throw upstreamUnavailable(
      'SEC_UNAVAILABLE',
      `SEC company_tickers.json fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    // Any non-OK fetch reuses the last cached copy when one exists (a 403
    // with a usable cache is no reason to fail the request); 502 only when
    // there is no cache at all.
    if (tickersCache) return tickersCache.data;
    throw upstreamUnavailable(
      'SEC_UNAVAILABLE',
      `SEC company_tickers.json returned HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as TickersMap;
  tickersCache = { data, fetchedAt: now };
  return data;
}

// ---------------------------------------------------------------------------
// Upstream parsing
// ---------------------------------------------------------------------------

interface EdgarSubmissions {
  cik?: string | number;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      form?: string[];
      primaryDocument?: string[];
    };
  };
}

/**
 * Validate an EDGAR submissions payload before answering from it. A 200
 * with `cik` missing (or a malformed filingDate) is an upstream data error,
 * not a verified zero-filings answer. Throws a 502 ApiError on malformed
 * payloads.
 */
function validateSubmissionsPayload(payload: unknown): asserts payload is EdgarSubmissions {
  if (!payload || typeof payload !== 'object') {
    throw upstreamUnavailable(
      'SEC_UNAVAILABLE',
      'SEC EDGAR Submissions API returned a malformed payload',
    );
  }
  const p = payload as EdgarSubmissions;
  const cikNum = typeof p.cik === 'string' ? Number(p.cik) : p.cik;
  if (typeof cikNum !== 'number' || !Number.isFinite(cikNum) || cikNum <= 0) {
    throw upstreamUnavailable(
      'SEC_UNAVAILABLE',
      'SEC EDGAR Submissions API returned a payload without a CIK',
    );
  }
  const dates = p.filings?.recent?.filingDate;
  if (Array.isArray(dates)) {
    for (const d of dates) {
      if (typeof d !== 'string' || !isValidDateString(d)) {
        throw upstreamUnavailable(
          'SEC_UNAVAILABLE',
          `SEC EDGAR Submissions API returned a malformed filingDate: ${String(d)}`,
        );
      }
    }
  }
}

/**
 * Build the filings list from an EDGAR submissions JSON payload.
 * url = https://www.sec.gov/Archives/edgar/data/<cik>/<accession-no-dashes>/<primary-document>
 * Entries without a primary document are skipped (no URL can be built).
 */
export function buildFilingsFromSubmissions(payload: EdgarSubmissions): Filing[] {
  const cikRaw = payload.cik;
  const cikNum = typeof cikRaw === 'string' ? Number(cikRaw) : cikRaw;
  if (typeof cikNum !== 'number' || !Number.isFinite(cikNum) || cikNum <= 0) return [];
  const recent = payload.filings?.recent;
  if (!recent) return [];
  const n = Math.min(
    recent.accessionNumber?.length ?? 0,
    recent.filingDate?.length ?? 0,
    recent.form?.length ?? 0,
    recent.primaryDocument?.length ?? 0,
  );
  const out: Filing[] = [];
  for (let i = 0; i < n; i++) {
    const accession = recent.accessionNumber?.[i] ?? '';
    const filingDate = recent.filingDate?.[i] ?? '';
    const form = recent.form?.[i] ?? '';
    const doc = recent.primaryDocument?.[i] ?? '';
    if (!accession || !filingDate || !form || !doc) continue;
    out.push({
      form,
      accession,
      filing_date: filingDate,
      url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession.replace(/-/g, '')}/${doc}`,
    });
  }
  return out;
}

interface FedRegDocument {
  document_number?: string;
  publication_date?: string;
  html_url?: string;
}

function buildFilingsFromFedReg(payload: { results?: FedRegDocument[] }): Filing[] {
  const out: Filing[] = [];
  for (const doc of payload.results ?? []) {
    if (!doc.document_number || !doc.publication_date || !doc.html_url) continue;
    out.push({
      form: 'Federal Register',
      accession: doc.document_number,
      filing_date: doc.publication_date,
      url: doc.html_url,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function requireUserAgent(): string {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua || ua.trim() === '') {
    throw upstreamUnavailable(
      'SEC_USER_AGENT_MISSING',
      'SEC_USER_AGENT environment variable is required for SEC EDGAR requests',
    );
  }
  return ua;
}

export async function handleFilings(
  query: Record<string, string | undefined>,
  deps: FilingsDeps = {},
): Promise<Record<string, unknown>> {
  const fetchImpl: typeof fetch = deps.fetchImpl ?? fetch;

  const entityRaw = query.entity;
  const periodRaw = query.period;
  if (entityRaw === undefined || entityRaw.trim() === '') {
    throw badRequest('MISSING_ENTITY', 'Query parameter "entity" is required');
  }
  if (periodRaw === undefined || periodRaw.trim() === '') {
    throw badRequest('MISSING_PERIOD', 'Query parameter "period" is required');
  }
  const entity = entityRaw.trim();
  if (entity.length > 512) {
    throw badRequest('ENTITY_TOO_LONG', 'Query parameter "entity" must not exceed 512 characters');
  }
  const period = parsePeriod(periodRaw);

  // SEC requires a User-Agent on every request; fail closed if unset.
  const userAgent = requireUserAgent();

  // --- Resolve entity -> CIK (unless it is already a bare CIK). ---
  let cikMatch: CikMatch | null = null;
  if (/^\d{1,10}$/.test(entity)) {
    cikMatch = { cik: Number(entity), cik10: padCik(Number(entity)), matchKind: 'cik' };
  } else {
    const tickers = await loadTickers(fetchImpl);
    // Exact-ticker matches are checked inside resolveCikFromTickers first
    // in priority, but a generic query must never reach the FedReg term
    // search as a supposed company either: it cannot identify a company.
    const upper = entity.toUpperCase();
    const exactTicker = Object.values(tickers).some(
      (e) => typeof e.ticker === 'string' && e.ticker.toUpperCase() === upper,
    );
    if (!exactTicker && isTooGenericEntity(entity)) {
      throw unprocessable(
        'AMBIGUOUS_ENTITY',
        `Entity "${entity}" is too generic to identify a company; use a ticker, CIK, or fuller company name`,
      );
    }
    cikMatch = resolveCikFromTickers(entity, tickers);
  }

  // --- Primary: SEC EDGAR Submissions API. ---
  // Failover rule: Federal Register is a full-text term search whose hits
  // are never checked against the entity, so it must NEVER stand in for a
  // resolved company's filings. When a CIK resolved and EDGAR is down
  // (429/5xx/network error), fail CLOSED with 502 SEC_UNAVAILABLE. FedReg
  // is used only on the no-CIK path (agency / rule-topic entities).
  if (cikMatch) {
    const upstreamUrl = EDGAR_SUBMISSIONS_URL(cikMatch.cik10);
    let res: Response;
    try {
      res = await fetchImpl(upstreamUrl, {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      });
    } catch (err) {
      throw upstreamUnavailable(
        'SEC_UNAVAILABLE',
        `SEC EDGAR Submissions API fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 429) {
      throw new ApiError(
        502,
        'SEC_UNAVAILABLE',
        'SEC EDGAR Submissions API returned HTTP 429 (rate limited)',
        60,
      );
    }
    if (res.status >= 500) {
      throw upstreamUnavailable(
        'SEC_UNAVAILABLE',
        `SEC EDGAR Submissions API returned HTTP ${res.status}`,
      );
    }
    if (res.status === 404) {
      throw unprocessable(
        'ENTITY_NOT_FOUND',
        `No SEC EDGAR submissions found for entity "${entity}"`,
      );
    }
    if (!res.ok) {
      throw upstreamUnavailable(
        'SEC_UNAVAILABLE',
        `SEC EDGAR Submissions API returned HTTP ${res.status}`,
      );
    }
    const rawBody = await res.text();
    let payload: EdgarSubmissions;
    try {
      payload = JSON.parse(rawBody) as EdgarSubmissions;
    } catch {
      throw upstreamUnavailable(
        'SEC_UNAVAILABLE',
        'SEC EDGAR Submissions API returned malformed JSON',
      );
    }
    validateSubmissionsPayload(payload);
    const all = buildFilingsFromSubmissions(payload);
    const filings = filterFilingsByPeriod(all, period);
    const confidence = cikMatch.matchKind === 'name' ? 0.9 : 1.0;
    const receipt = makeReceipt(INTENT, upstreamUrl, rawBody, '1/1 primary source');
    return envelope(
      INTENT,
      {
        entity,
        filing_count: filings.length,
        filings,
        urls: filings.map((f) => f.url),
      },
      receipt,
      {
        answer: `Found ${filings.length} filing${filings.length === 1 ? '' : 's'} for ${entity} in ${period.label}.`,
        verdict: 'verified',
        confidence,
        source: 'SEC EDGAR Submissions API',
      },
    );
  }

  // --- No CIK match: entity looks like an agency / rule topic -> FedReg. ---
  return await fedRegOrFail(entity, period, fetchImpl);
}

async function fedRegOrFail(
  entity: string,
  period: Period,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const upstreamUrl = FEDREG_URL(entity);
  let res: Response;
  try {
    res = await fetchImpl(upstreamUrl, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw upstreamUnavailable(
      'FEDREG_UNAVAILABLE',
      `Federal Register API fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 429 || res.status >= 500) {
    throw upstreamUnavailable(
      'FEDREG_UNAVAILABLE',
      `Federal Register API returned HTTP ${res.status}`,
    );
  }
  if (!res.ok) {
    throw upstreamUnavailable(
      'FEDREG_UNAVAILABLE',
      `Federal Register API returned HTTP ${res.status}`,
    );
  }
  const rawBody = await res.text();
  let payload: { results?: FedRegDocument[] };
  try {
    payload = JSON.parse(rawBody) as { results?: FedRegDocument[] };
  } catch {
    throw upstreamUnavailable(
      'FEDREG_UNAVAILABLE',
      'Federal Register API returned malformed JSON',
    );
  }
  const all = buildFilingsFromFedReg(payload);
  const filings = filterFilingsByPeriod(all, period);
  if (filings.length === 0 && all.length === 0) {
    throw unprocessable(
      'ENTITY_NOT_FOUND',
      `No SEC EDGAR entry and no Federal Register documents found for entity "${entity}"`,
    );
  }
  const receipt = makeReceipt(INTENT, upstreamUrl, rawBody, '1/1 primary source');
  return envelope(
    INTENT,
    {
      entity,
      filing_count: filings.length,
      filings,
      urls: filings.map((f) => f.url),
    },
    receipt,
    {
      answer: `Found ${filings.length} filing${filings.length === 1 ? '' : 's'} for ${entity} in ${period.label}.`,
      verdict: 'verified',
      confidence: 0.9,
      source: 'Federal Register API',
    },
  );
}
