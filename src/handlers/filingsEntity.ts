// A1 round 8 — entity resolution by LONGEST MATCH against SEC titles and
// tickers FIRST, then form parsing of the RESIDUE (the complement).
//
// The old order (extract forms from the free text, then resolve what is
// left) misread digits and tickers that are part of a real SEC name
// ("Rice Acquisition Corp 3 filings" served Form 3; "Chubb CB" served
// Form CB). Here every contiguous token span of the entity is tried as
// the filer, longest first:
//   tier 1 — EXACT: the span's canonical key equals an SEC title key, the
//            span is one token equal to an SEC ticker (typed in capitals
//            when the entity has more than one token), or the span is a
//            name + that company's own ticker ("Microsoft MSFT");
//   tier 2 — the pre-existing unique-name resolver (exact ticker / exact
//            title / unique word-boundary prefix; ambiguous -> 422).
// A span only counts when EVERY token outside it (the complement) is a
// filing word, exactly one EDGAR form (closed vocabulary), a CIK claim,
// or the requested year. Anything else in the complement is an
// unconsumed token and the span is rejected — the request then fails
// closed with 422; there is no Federal Register fallback any more.
// Equal-length winners that disagree (different CIK or form) -> 422
// AMBIGUOUS_ENTITY.

import { ApiError, unprocessable } from '../core/errors';
import { foldBasic, isFormShaped, lookupForm, tokenCore } from './filingsForms';

export interface EntityMatch {
  cik: number;
  matchKind: 'ticker' | 'cik' | 'name';
}

export interface ResolveDeps {
  /** Canonical company key (normalizeCompanyName). */
  normalize: (s: string) => string;
  /** Canonical ticker (invisibles stripped, upper-cased). */
  canonicalTicker: (s: string) => string;
  /** Tier-2 resolver (resolveCikFromTickers): null, a match, or throws 422 AMBIGUOUS_ENTITY. */
  resolveName: (s: string) => EntityMatch | null;
  /** "Microsoft MSFT" name + own-ticker pair (resolveNameTickerPair). */
  resolvePair: (s: string) => EntityMatch | null;
  /** company_tickers.json entries as [ticker, title, cik] (cik null when malformed). */
  entries: () => Array<{ ticker: unknown; title: unknown; cik: number | null }>;
}

export interface Complement {
  forms: string[];
  ciks: number[];
  /** A form came from a plain-language phrase ("annual report"), not an EDGAR form string. */
  phraseForm: boolean;
}

export type SpanResult =
  | { kind: 'match'; match: EntityMatch; entity: string; comp: Complement; tier: 1 | 2 }
  | { kind: 'no-name'; comp: Complement }
  | {
      kind: 'none';
      /** Longest span whose complement is valid (the unresolved name), when one exists. */
      name: { entity: string; comp: Complement } | null;
      error: ApiError;
      searchEligible: boolean;
    };

interface Tok {
  start: number;
  end: number;
  raw: string;
  core: string;
  /** raw with wrapping punctuation and a trailing possessive removed — used for name keys. */
  name: string;
}

/** Characters that separate a name from a form ("Apple Inc.—10-K", "Tesla:10-Q", "Inc.\10-K", "Tesla,10-Q"). */
const SEPARATOR_RE = /[\u2013\u2014\u2015:;\\|,_]/g;
/** "/" separates too — except an amendment "/A" (end of token) which stays glued. */
const SLASH_SEP_RE = /\/(?!\s*[Aa](?![\p{L}\p{N}]))/gu;
const DOT_DIGIT_SEP_RE = /(?<=[\p{L}.])\.(?=\d)/gu;

/** 1:1 character replacement (offsets are preserved). */
export function separatorsToSpaces(s: string): string {
  // A "." glued between a name and a digit is a separator too
  // ("Apple Inc..10-K", "Corp.10-K"); "10.Q" (digit before) is a spaced
  // form and is folded by the form parser instead. No SEC title has a
  // letter/period followed by "." and a digit (checked against the full
  // company_tickers.json, 2026-11-21).
  return s.replace(SEPARATOR_RE, ' ').replace(SLASH_SEP_RE, ' ').replace(DOT_DIGIT_SEP_RE, ' ');
}

/** A trailing possessive is not part of the name ("Apple Inc.'s 10-K filings"); nothing else is stripped. */
function nameOf(raw: string): string {
  return raw.replace(/['\u2019]s$/i, '');
}

export function tokenizeEntity(text: string): Tok[] {
  const spaced = separatorsToSpaces(text);
  const out: Tok[] = [];
  // Tokens split on ASCII whitespace only: every other space separator
  // (NBSP, U+2000..U+200A, U+3000 ...) belongs to the closed invisible
  // class and is stripped INSIDE a token, exactly as the ticker / name
  // canonicalisers do ("AA\u00a0PL" is the ticker AAPL).
  for (const m of spaced.matchAll(/[^ \t\r\n\f\v]+/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const prev = out[out.length - 1];
    // Re-glue a detached amendment slash ("10-K / A", "10-K/ A", "10-K /A").
    if (prev && (m[0].startsWith('/') || prev.raw.endsWith('/'))) {
      prev.end = end;
      prev.raw = text.slice(prev.start, end);
      prev.core = tokenCore(foldBasic(prev.raw.replace(/\s+/g, '')));
      prev.name = nameOf(prev.raw);
      continue;
    }
    const raw = text.slice(start, end);
    out.push({ start, end, raw, core: tokenCore(foldBasic(raw)), name: nameOf(raw) });
  }
  return out.filter((t) => t.core !== '' || /[\p{L}\p{N}]/u.test(t.raw));
}

/** Filing scaffolding and question words that never name a filer on their own. */
export const COMPLEMENT_FILLER = new Set([
  'FILINGS', 'FILING', 'FILED', 'FILES', 'REPORTS', 'REPORT', 'BY', 'OF', 'FOR', 'FROM', 'ON', 'THE', 'ALL', 'ANY',
  'NUMBER', 'COUNT', 'TOTAL', 'IN', 'DURING', 'CALENDAR', 'YEAR', 'HOW', 'MANY', 'ARE', 'IS', 'WAS', 'WERE', 'WHAT',
  'SEC', 'EDGAR', 'SUBMITTED', 'MADE', 'WITH', 'HAS', 'HAVE', 'DID', 'TYPE', 'TYPES', 'AND', 'OR', 'TO', 'AN',
]);
const YEAR_LEAD = new Set(['IN', 'DURING', 'CALENDAR', 'YEAR', 'FOR']);
const FILING_WORDS = new Set(['FILINGS', 'FILING', 'FILED', 'FILES', 'REPORTS', 'REPORT']);
/** Digit-only EDGAR forms read next to a resolved filer without "Form" (Forms 3/4/5, 144, 25). */
const ANCHORED_DIGIT_FORMS = new Set(['3', '4', '5', '144', '25']);
const PHRASES: Record<string, string> = { ANNUAL: '10-K', QUARTERLY: '10-Q' };

interface SegBad {
  token: string;
  formShaped: boolean;
}

function parseSegment(toks: Tok[], periodYear: number | null, out: Complement, state: { bareYear: string | null }): SegBad | null {
  const hasFilingWord = toks.some((t) => FILING_WORDS.has(t.core));
  for (let i = 0; i < toks.length; ) {
    const c = toks[i].core;
    if (PHRASES[c] && i + 1 < toks.length && (toks[i + 1].core === 'REPORT' || toks[i + 1].core === 'REPORTS')) {
      out.forms.push(PHRASES[c]);
      out.phraseForm = true;
      i += 2;
      continue;
    }
    const isFormWord = c === 'FORM' || c === 'FORMS';
    const at = isFormWord ? i + 1 : i;
    if (isFormWord && at >= toks.length) return { token: toks[i].raw, formShaped: false };
    if (!isFormWord && COMPLEMENT_FILLER.has(c)) {
      i += 1;
      continue;
    }
    let matched = 0;
    for (let n = Math.min(4, toks.length - at); n >= 1 && matched === 0; n--) {
      const words = toks.slice(at, at + n);
      if (n >= 2 && words[n - 1].core === 'A') continue;
      if (words.some((w) => w.core === '')) continue;
      const joined = words.map((w) => w.core).join(' ');
      const f = lookupForm(joined, { keyword: true, explicit: true }, words.map((w) => w.raw).join(' '));
      if (f === null) continue;
      if (/^\d+(\/A)?$/.test(f) && !isFormWord && !ANCHORED_DIGIT_FORMS.has(f.replace(/\/A$/, ''))) continue;
      out.forms.push(f);
      matched = at - i + n;
    }
    if (matched > 0) {
      i += matched;
      continue;
    }
    if (isFormWord) return { token: toks.slice(i, i + 2).map((t) => t.raw).join(' '), formShaped: isFormShaped(toks[at].core) };
    if (/^(19|20)\d{2}$/.test(c)) {
      const lead = i > 0 ? toks[i - 1].core : '';
      if (periodYear === null || Number(c) !== periodYear) return { token: toks[i].raw, formShaped: false };
      // A bare year needs a form, a filing word, or "in/during/calendar" before it ("AAPL 2023" is refused).
      if (!YEAR_LEAD.has(lead) && !hasFilingWord) state.bareYear = toks[i].raw;
      i += 1;
      continue;
    }
    if (/^\d{5,10}$/.test(c)) {
      out.ciks.push(Number(c));
      i += 1;
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(c)) {
      i += 1;
      continue;
    }
    return { token: toks[i].raw, formShaped: isFormShaped(c) };
  }
  return null;
}

function parseComplement(segments: Tok[][], periodYear: number | null): { comp: Complement | null; bad: SegBad | null } {
  const comp: Complement = { forms: [], ciks: [], phraseForm: false };
  const state = { bareYear: null as string | null };
  for (const seg of segments) {
    const bad = parseSegment(seg, periodYear, comp, state);
    if (bad) return { comp: null, bad };
  }
  if (state.bareYear !== null && comp.forms.length === 0) return { comp: null, bad: { token: state.bareYear, formShaped: false } };
  return { comp, bad: null };
}

interface Index {
  byKey: Map<string, Set<number>>;
  byTicker: Map<string, number>;
}
const INDEX_CACHE = new WeakMap<object, Index>();

function buildIndex(deps: ResolveDeps, cacheKey: object): Index {
  const hit = INDEX_CACHE.get(cacheKey);
  if (hit) return hit;
  const byKey = new Map<string, Set<number>>();
  const byTicker = new Map<string, number>();
  for (const e of deps.entries()) {
    if (e.cik === null) continue;
    if (typeof e.title === 'string') {
      const k = deps.normalize(separatorsToSpaces(e.title));
      if (k !== '') {
        const set = byKey.get(k) ?? new Set<number>();
        set.add(e.cik);
        byKey.set(k, set);
      }
    }
    if (typeof e.ticker === 'string') {
      const t = deps.canonicalTicker(e.ticker);
      if (t !== '' && !byTicker.has(t)) byTicker.set(t, e.cik);
    }
  }
  const idx = { byKey, byTicker };
  INDEX_CACHE.set(cacheKey, idx);
  return idx;
}

function sameAnswer(a: { match: EntityMatch; comp: Complement }, b: { match: EntityMatch; comp: Complement }): boolean {
  return a.match.cik === b.match.cik && [...new Set(a.comp.forms)].join('|') === [...new Set(b.comp.forms)].join('|');
}

/**
 * Resolve `text` (labelled CIK clauses already blanked) by longest match.
 * `periodYear` is the requested calendar year (null for other periods).
 */
export function resolveEntitySpans(
  text: string,
  periodYear: number | null,
  deps: ResolveDeps,
  cacheKey: object,
  opts: { cikClaimed?: boolean } = {},
): SpanResult {
  const toks = tokenizeEntity(text);
  const n = toks.length;
  const whole = parseComplement([toks], periodYear);
  if (n === 0) return { kind: 'no-name', comp: { forms: [], ciks: [], phraseForm: false } };
  // The whole text also reads as pure complement ("CB", "CB filings",
  // "D filings", "10-K filings"). A CIK claim decides it as a form ask
  // ("Form CB (CIK 896159)"); otherwise an exact SEC ticker/title span
  // whose own complement holds no form ("CB" = Chubb Ltd, J2-r7 M3) is
  // the filer and tier 2 (prefix matching) is never tried.
  const wholeIsComplement = whole.comp !== null;
  if (wholeIsComplement && opts.cikClaimed) return { kind: 'no-name', comp: whole.comp as Complement };
  const idx = buildIndex(deps, cacheKey);
  const sliceName = (i: number, j: number): string => toks.slice(i, j).map((t) => t.name).join(' ');
  const sliceRaw = (i: number, j: number): string => nameOf(text.slice(toks[i].start, toks[j - 1].end).trim());
  const complementOf = (i: number, j: number) => parseComplement([toks.slice(0, i), toks.slice(j)], periodYear);

  let anchoredBad: { span: string; bad: SegBad } | null = null;
  let longestValidName: { entity: string; comp: Complement } | null = null;

  // ---- tier 1: exact ----
  for (let len = n; len >= 1; len--) {
    const found: Array<{ match: EntityMatch; comp: Complement; entity: string }> = [];
    for (let i = 0; i + len <= n; i++) {
      const j = i + len;
      const name = sliceName(i, j);
      const matches: EntityMatch[] = [];
      const key = deps.normalize(separatorsToSpaces(name));
      const titleCiks = key !== '' ? idx.byKey.get(key) : undefined;
      if (titleCiks) for (const cik of titleCiks) matches.push({ cik, matchKind: 'name' });
      if (len === 1) {
        const t = toks[i];
        const typedCaps = t.name === t.name.toUpperCase() && /[A-Z]/.test(t.name);
        if (typedCaps || n === 1) {
          const cik = idx.byTicker.get(deps.canonicalTicker(t.name.replace(/\.$/, '')));
          if (cik !== undefined) matches.push({ cik, matchKind: 'ticker' });
        }
      } else if (len <= 8 && toks.slice(i, j).some((t) => idx.byTicker.has(deps.canonicalTicker(t.name.replace(/\.$/, ''))))) {
        const p = deps.resolvePair(sliceRaw(i, j));
        if (p) matches.push(p);
      }
      if (matches.length === 0) continue;
      const { comp, bad } = complementOf(i, j);
      if (!comp) {
        if (bad && (!anchoredBad || bad.formShaped)) anchoredBad = { span: name, bad };
        continue;
      }
      if (wholeIsComplement && (comp.forms.length > 0 || comp.ciks.length > 0)) {
        // Round 9 (J2-r8 m4): when the whole entity reads as TWO OR MORE
        // forms ("C 10-K", "CB Form 4 filings", "Form 8-K filings by D"),
        // that reading is a multi-form request no answer can serve, so an
        // exact ticker token leaving exactly ONE form is the filer. Two
        // such readings ("C D") disagree and are AMBIGUOUS_ENTITY below.
        const wholeForms = new Set((whole.comp as Complement).forms);
        const tickerOnly = matches.filter((m) => m.matchKind === 'ticker');
        if (!(wholeForms.size >= 2 && comp.ciks.length === 0 && comp.forms.length === 1 && tickerOnly.length > 0)) continue;
        for (const m of tickerOnly) found.push({ match: m, comp, entity: sliceRaw(i, j) });
        continue;
      }
      for (const m of matches) found.push({ match: m, comp, entity: sliceRaw(i, j) });
    }
    if (found.length > 0) {
      const first = found[0];
      if (found.some((f) => !sameAnswer(f, first))) {
        throw unprocessable(
          'AMBIGUOUS_ENTITY',
          `Entity "${text.trim()}" reads as more than one SEC filer or form (${found
            .map((f) => `${f.entity} -> CIK ${f.match.cik}${f.comp.forms.length ? ` Form ${f.comp.forms.join('/')}` : ''}`)
            .join('; ')}); use a ticker, CIK, or exact company name`,
        );
      }
      return { kind: 'match', match: first.match, entity: first.entity, comp: first.comp, tier: 1 };
    }
  }

  if (wholeIsComplement) return { kind: 'no-name', comp: whole.comp as Complement };

  // ---- tier 2: unique-name resolver ----
  let ambiguous: ApiError | null = null;
  for (let len = n; len >= 1; len--) {
    const found: Array<{ match: EntityMatch; comp: Complement; entity: string }> = [];
    for (let i = 0; i + len <= n; i++) {
      const j = i + len;
      const spanToks = toks.slice(i, j);
      if (spanToks.every((t) => COMPLEMENT_FILLER.has(t.core) || !/[\p{L}\p{N}]/u.test(t.core))) continue;
      const { comp, bad } = complementOf(i, j);
      if (!comp) {
        if (bad && bad.formShaped && !anchoredBad) anchoredBad = { span: sliceName(i, j), bad };
        if(bad&&!anchoredBad){try{if(deps.resolveName(sliceRaw(i,j)))anchoredBad={span:sliceName(i,j),bad};}catch{/* Existing ambiguous resolution below remains authoritative. */}}
        continue;
      }
      const name = sliceRaw(i, j);
      if (!longestValidName) longestValidName = { entity: name, comp };
      let m: EntityMatch | null = null;
      try {
        m = deps.resolveName(name);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'AMBIGUOUS_ENTITY') {
          if (!ambiguous) ambiguous = err;
          continue;
        }
        throw err;
      }
      if (m) found.push({ match: m, comp, entity: name });
    }
    if (found.length > 0) {
      const first = found[0];
      if (found.some((f) => !sameAnswer(f, first))) {
        throw unprocessable(
          'AMBIGUOUS_ENTITY',
          `Entity "${text.trim()}" reads as more than one SEC filer (${found.map((f) => `${f.entity} -> CIK ${f.match.cik}`).join('; ')}); use a ticker, CIK, or exact company name`,
        );
      }
      return { kind: 'match', match: first.match, entity: first.entity, comp: first.comp, tier: 2 };
    }
    if (ambiguous) break;
  }

  let error: ApiError;
  if (ambiguous) error = ambiguous;
  else if (anchoredBad?.bad.formShaped) {
    error = unprocessable(
      'UNKNOWN_FORM',
      `Entity "${text.trim()}": "${anchoredBad.bad.token}" is not a form SEC EDGAR has ever recorded; use the EDGAR form exactly, e.g. 10-K, 10-Q, 8-K, 144/A`,
    );
  } else if (anchoredBad) {
    error = unprocessable(
      'ENTITY_NOT_FOUND',
      `No SEC EDGAR entry found for entity "${text.trim()}": "${anchoredBad.span}" is an SEC filer but "${anchoredBad.bad.token}" is not an EDGAR form, a filing word or the requested year; Federal Register fallback is not used`,
    );
  } else {
    error = unprocessable(
      'ENTITY_NOT_FOUND',
      `No SEC EDGAR entry found for entity "${text.trim()}"; use a ticker, CIK, or exact company name (Federal Register fallback is not used)`,
    );
  }
  return { kind: 'none', name: longestValidName, error, searchEligible: !ambiguous && !anchoredBad };
}
