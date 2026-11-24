// A1 FILINGS — SEC EDGAR form-type parsing, extraction and the
// fail-closed form guard for REGULATORY_FILING_MONITOR_GENERAL.
//
// Contract (A1, 2026-11-21): no parser in this module returns null to
// mean "no form was asked for". Every parser either returns an explicit
// discriminated result or THROWS an ApiError. A form-like token that no
// parser consumed is a 422 (assertNoUnconsumedFormTokens) — it is never
// silently dropped, because dropping it serves the UNFILTERED count of
// all forms as if it answered the form-specific question.
//
// Canonical form strings are EDGAR's own `form` column values: upper
// case, single spaces, amendment suffix "/A" with no spaces ("10-K",
// "10-K/A", "144/A", "SC 13G/A", "DEF 14A"). Filtering is an EXACT match
// on that column (a "10-K" question never counts "10-K/A" amendments).

import { ApiError, unprocessable } from '../core/errors';
import { EDGAR_FORM_TYPES } from './edgarFormTypes';

/** Same closed invisible class as filings.ts (C + M + non-ASCII spaces + blank-rendering code points). */
const INVISIBLE_RE =
  /[\p{C}\p{M}\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\u2800\u3164\uFFA0\u115F\u1160\u{13441}\u{13442}\u303F\u{1DA7F}\u{1DA80}]/gu;
/** Hyphen/dash look-alikes folded to "-" (U+2010..U+2015, minus, small/fullwidth hyphen-minus). */
const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
/** Slash look-alikes folded to "/" (fraction slash, division slash, fullwidth solidus). */
const SLASH_RE = /[\u2044\u2215\uFF0F]/g;

export type FormSpec = { kind: 'none' } | { kind: 'form'; form: string } | { kind: 'forms'; forms: string[] };

// ---------------------------------------------------------------------------
// Form vocabulary — CLOSED (A1 round 8). Every accepted form is a value
// EDGAR itself has recorded (src/data/edgarFormTypes.ts: the union of the
// Form Type column of every full-index quarter 1993Q1..2026Q4). A
// form-shaped token that EDGAR never used ("10-Z", "8-Z", "99-K",
// "S-1ZZZZ", "12-K") is 422 UNKNOWN_FORM — never a verified 0.
// ---------------------------------------------------------------------------

const VOCAB: ReadonlySet<string> = new Set(EDGAR_FORM_TYPES);
const amendBase = (f: string): string => (f.endsWith('/A') ? f.slice(0, -2) : f);
/** Single-token bases that contain a letter AND a digit ("10-K", "S-1", "424B2", "13F-HR"): matched anywhere. */
const STRONG_FORMS = new Set<string>();
/** Digit-only bases ("3", "4", "5", "144", "25", "425" ...): only with a filing keyword, after "Form", or anchored. */
const DIGIT_FORMS = new Set<string>();
/** Letter-only single-token bases ("SD", "D", "CB", "UPLOAD", "EFFECT" ...): only after "Form", via form_type, or anchored. */
const WORD_FORMS = new Set<string>();
/** Multi-word bases ("SC 13G", "DEF 14A", "SEC STAFF LETTER", "DEL AM" ...). */
const MULTIWORD_SET = new Set<string>();
/** Multi-word bases matched in free text without "Form": the ones carrying a digit, plus SEC STAFF LETTER. */
const MULTIWORD_STRONG = new Set<string>();
/** Compact key (no spaces, dashes, dots, underscores, slashes) -> canonical form; null when two forms collide. */
const COMPACT = new Map<string, string | null>();
const compactKey = (s: string): string => s.replace(/[\s\-._/]/g, '');
for (const f of EDGAR_FORM_TYPES) {
  const b = amendBase(f);
  if (b.includes(' ')) {
    MULTIWORD_SET.add(b);
    if (/\d/.test(b) || b === 'SEC STAFF LETTER') MULTIWORD_STRONG.add(b);
  } else if (/^\d+$/.test(b)) DIGIT_FORMS.add(b);
  else if (/\d/.test(b)) STRONG_FORMS.add(b);
  else WORD_FORMS.add(b);
  const k = compactKey(f);
  const prev = COMPACT.get(k);
  COMPACT.set(k, prev === undefined || prev === f ? f : null);
}
const MULTIWORD_MAX_TOKENS = 3;

/** True when `f` (canonical) is a form EDGAR has recorded. */
export function isKnownEdgarForm(f: string): boolean {
  return VOCAB.has(f);
}

/** Undashed spellings folded to EDGAR's dashed form ("10K" -> "10-K"). */
function foldUndashed(core: string): string {
  let m = /^(10|8|6|11)(K|Q)$/.exec(core);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(20|40)F$/.exec(core);
  if (m) return `${m[1]}-F`;
  m = /^10(KSB|QSB|KT|QT)$/.exec(core);
  if (m) return `10-${m[1]}`;
  return core;
}

/** True when `core` (canonical upper-case, no "/A") is a strong (letter+digit) EDGAR form base. */
function isStrongBase(core: string): boolean {
  return STRONG_FORMS.has(core);
}

/** Looks like an EDGAR form even though EDGAR never used it ("10-Z", "99-K", "S-99", "13D", "N-99Q"). */
const FORM_SHAPED_RE =
  /^(?:\d{1,3}-[A-Z]{1,3}\d{0,3}|[A-Z]{1,3}-\d{1,3}[A-Z]{0,5}|\d{2,3}[A-Z]{1,2}\d?|SC ?\d{2}[A-Z]\d?)(?:\/A)?$/;
export function isFormShaped(core: string): boolean {
  return FORM_SHAPED_RE.test(core);
}

/**
 * Cyrillic / Greek letters that render like Latin ones (confusables),
 * folded to Latin BEFORE any form parsing: "1О-K" (Cyrillic О) is not a
 * new form, it is a spoof of a real one. Digit/letter look-alikes
 * (1O-Q, l0-Q) are NOT folded — they are refused (CONFUSABLE_FORM_TYPE).
 */
const CONFUSABLES: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ј: 'J', Ѕ: 'S',
  Ԛ: 'Q', Ԝ: 'W', а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', ԛ: 'q', ԝ: 'w', к: 'k',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  ο: 'o', ρ: 'p', χ: 'x', ι: 'i', κ: 'k',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');
export function foldConfusables(s: string): string {
  return s.replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c);
}

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

/** Remove the closed invisible class outright. */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '');
}

/** NFKC fold (fullwidth -> ASCII) + dash/slash look-alikes folded + confusables folded. Invisible chars are NOT touched here. */
export function foldBasic(s: string): string {
  return foldConfusables(s.normalize('NFKC')).replace(DASH_RE, '-').replace(SLASH_RE, '/');
}

/** Strip wrapping punctuation and a trailing possessive from one token (invisibles removed), upper-case it. */
export function tokenCore(tok: string): string {
  return stripInvisible(tok)
    .replace(/^[("'\[\u2018\u201C:]+/, '')
    .replace(/[)"'\],;:!?\u2019\u201D]+$/, '')
    .replace(/['\u2019]S$/i, '')
    .replace(/\.$/, '')
    .toUpperCase();
}

function splitAmendment(core: string): { base: string; suffix: string | null } {
  const i = core.indexOf('/');
  if (i < 0) return { base: core, suffix: null };
  return { base: core.slice(0, i), suffix: core.slice(i + 1) };
}

function invalidForm(raw: string, why: string): ApiError {
  return unprocessable(
    'INVALID_FORM_TYPE',
    `Form type "${raw}" is not a valid SEC EDGAR form (${why}); use the EDGAR form exactly, e.g. 10-K, 10-Q, 8-K, 144/A`,
  );
}

export function unknownForm(raw: string): ApiError {
  return unprocessable(
    'UNKNOWN_FORM',
    `Form type "${raw}" is not a form SEC EDGAR has ever recorded; use the EDGAR form exactly, e.g. 10-K, 10-Q, 8-K, 144/A`,
  );
}

/** Canonical form for a compact or dashed spelling ("10K", "SC13G", "DEF14A", "10 - Q"), or null. */
function compactLookup(s: string): string | null {
  return COMPACT.get(compactKey(s)) ?? null;
}

/**
 * Longest strong-form prefix of a compact token ("10-KA1" -> "10-K",
 * "13F-HR2" -> "13F-HR"). Only tokens that start like a form (a digit,
 * or a letter followed by "-") are considered, and only amendment-junk
 * remainders count ("A1", "2", ".1", "-1"): "7-ELEVEN" is a name.
 */
function strongPrefix(core: string): string | null {
  if (!/^(\d|[A-Z]{1,2}-)/.test(core)) return null;
  for (let n = core.length - 1; n >= 2; n--) {
    const p = foldUndashed(core.slice(0, n));
    if (isStrongBase(p) && /^(A|\d|[.\-,])/.test(core.slice(n))) return p;
  }
  return null;
}

interface Ctx {
  /** Text carries a filing keyword (FILING/FORM/REPORT/FILED): licenses digit-only forms. */
  keyword: boolean;
  /** Token follows "Form"/"Forms", is a form_type value, or sits next to a resolved filer: licenses word forms too. */
  explicit: boolean;
}

function gated(base: string, ctx: Ctx, amended = false): boolean {
  // An explicit "/A" amendment licenses digit and word forms ("144/A", "D/A", "SD/A").
  if (amended) return true;
  if (DIGIT_FORMS.has(base)) return ctx.keyword || ctx.explicit;
  if (WORD_FORMS.has(base)) return ctx.explicit;
  if (MULTIWORD_SET.has(base) && !MULTIWORD_STRONG.has(base)) return ctx.explicit;
  return true;
}

/**
 * One (possibly multi-word) folded, upper-case candidate -> canonical
 * EDGAR form, null (not a form in this context), or THROW 422:
 *   INVALID_FORM_TYPE — a known base with a bad suffix ("10-K/A-1",
 *     "144/A1", "10-KA1", "13F-HR2");
 *   UNKNOWN_FORM — an amendment EDGAR never recorded ("SD/A" is fine,
 *     "SEC STAFF LETTER/A" is not) or a form-shaped "X/A" with an
 *     unknown base ("13D/A").
 */
export function lookupForm(text: string, ctx: Ctx, raw = text): string | null {
  const s = text.replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  if (VOCAB.has(s)) return gated(amendBase(s), ctx, s.endsWith('/A')) ? s : null;
  if (s.includes('/')) {
    const { base: b0, suffix } = splitAmendment(s);
    const fb = foldUndashed(b0);
    const base = VOCAB.has(fb) ? fb : compactLookup(fb);
    if (base === null || base.endsWith('/A')) {
      if (isFormShaped(compactKey(b0)) || strongPrefix(fb) !== null) {
        if (suffix === 'A') throw unknownForm(raw);
        throw invalidForm(raw, `unrecognised form base "${b0}"`);
      }
      return null; // "AG/ADR", "A/S": slash-joined non-forms
    }
    if (suffix !== 'A') throw invalidForm(raw, `amendment suffix must be exactly "/A", got "/${suffix}"`);
    if (!VOCAB.has(`${base}/A`)) throw unknownForm(raw);
    return gated(base, ctx, true) ? `${base}/A` : null;
  }
  const folded = foldUndashed(s);
  if (VOCAB.has(folded)) return gated(folded, ctx) ? folded : null;
  const c = compactLookup(folded);
  // Compact spellings are only read when the candidate carries a digit
  // ("10K", "SC13G", "DEF14A", "10 - Q"): a letters-only run never
  // compacts into a form ("D EF" is not DEF).
  if (c !== null && /\d/.test(s)) return gated(amendBase(c), ctx) ? c : null;
  // Compact amendment glued to its base ("10-KA", "13F-HRA", "144A",
  // "SC13G/A" is handled above). A lone trailing " A" token is NOT read
  // as an amendment ("10-K A" is refused, never guessed).
  if (/A$/.test(folded) && !/\sA$/.test(s) && /\d/.test(s)) {
    const head = folded.slice(0, -1);
    const b = VOCAB.has(foldUndashed(head)) ? foldUndashed(head) : compactLookup(head);
    if (b !== null && !b.endsWith('/A') && VOCAB.has(`${b}/A`) && gated(b, ctx)) return `${b}/A`;
  }
  if (!s.includes(' ')) {
    const p = strongPrefix(folded);
    if (p !== null) throw invalidForm(raw, `"${p}" followed by "${folded.slice(p.length)}"`);
  }
  return null;
}

/** Digit/letter look-alike spoof of a real form ("1O-Q", "l0-K", "1O-K/A"): refused, never folded. */
function confusableDigitSpoof(s: string): boolean {
  const t = s.replace(/[OoIl](?=[\d-])|(?<=\d)[OoIl]/g, (ch) => (ch === 'O' || ch === 'o' ? '0' : '1'));
  if (t === s) return false;
  try {
    return lookupForm(t.toUpperCase(), { keyword: true, explicit: true }) !== null;
  } catch {
    return false;
  }
}

/** Explicit single form string (form_type value) -> canonical form, or throw 422. Never returns null. */
export function canonicalFormOrThrow(raw: string): string {
  let s = stripInvisible(foldBasic(raw)).trim().toUpperCase().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/');
  s = s.replace(/^FORMS?\s+/, '').replace(/^FORM(?=\d)/, '');
  if (s === '') throw invalidForm(raw, 'empty');
  const m = lookupForm(s, { keyword: true, explicit: true }, raw);
  if (m !== null) return m;
  if (confusableDigitSpoof(stripInvisible(foldBasic(raw)).trim())) {
    throw unprocessable(
      'CONFUSABLE_FORM_TYPE',
      `Form type "${raw}" mixes look-alike letters and digits (O/0, l/1); type the EDGAR form exactly, e.g. 10-Q`,
    );
  }
  throw unknownForm(raw);
}

/**
 * The explicit `form_type` / `form` query value. Absent / empty / "all"
 * / "any" -> { kind: 'none' }. An explicit finite list selects a union.
 */
export function parseFormType(raw: unknown, field = 'form_type'): FormSpec {
  if (raw === undefined) return { kind: 'none' };
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'INVALID_FORM_TYPE', `Query parameter "${field}" must be a string`);
  }
  const folded = stripInvisible(foldBasic(raw)).trim();
  if (folded === '' || /^(ALL|ANY|ALL FORMS|ANY FORM|\*)$/i.test(folded)) return { kind: 'none' };
  // Round 9 (J2-r8 m5): ";" and "|" are read as separators exactly as in
  // the entity ("Tesla 10;K" -> 10-K), so form_type "10;K" / "10|K" is
  // 10-K too. It is still a list (422) when the separated parts are
  // themselves two or more EDGAR forms ("10-K;10-Q").
  if (/[;|]/.test(folded) && !/[,&+]|\bAND\b|\bOR\b/i.test(folded)) {
    const parts = folded.split(/[;|]/).map((x) => x.trim()).filter((x) => x !== '');
    const partForms = parts.filter((x) => {
      try {
        canonicalFormOrThrow(x);
        return true;
      } catch {
        return false;
      }
    });
    if (partForms.length < 2) {
      try {
        return { kind: 'form', form: canonicalFormOrThrow(folded.replace(/[;|]/g, ' ')) };
      } catch {
        // fall through to the list / unknown-form refusals below
      }
    }
  }
  if (/[,;|&+]|\bAND\b|\bOR\b/i.test(folded)) {
    const parts = folded.split(/[,;|&+]|\bAND\b|\bOR\b/i).map(p => p.trim());
    if (parts.length < 2 || parts.length > 10 || parts.some(p => !p)) throw unprocessable('MULTIPLE_FORM_TYPES', 'form list must contain2..10 nonempty exact EDGAR forms');
    const forms = [...new Set(parts.map(canonicalFormOrThrow))];
    return forms.length === 1 ? { kind: 'form', form: forms[0] } : { kind: 'forms', forms };
  }
  return { kind: 'form', form: canonicalFormOrThrow(raw) };
}

// ---------------------------------------------------------------------------
// Free-text extraction (entity / period / extra fields)
// ---------------------------------------------------------------------------

export const FILING_KEYWORDS = new Set(['FILING', 'FILINGS', 'FORM', 'FORMS', 'REPORT', 'REPORTS', 'FILED']);
const LEADING_FILLER = new Set([
  'FILINGS', 'FILING', 'FILED', 'REPORTS', 'REPORT', 'BY', 'OF', 'FOR', 'FROM', 'ON', 'THE', 'FORM', 'FORMS', 'ALL', 'ANY',
  'TYPE', 'NUMBER', 'COUNT', 'TOTAL',
]);
const TRAILING_FILLER = new Set(['FILINGS', 'FILING', 'FILED', 'REPORTS', 'REPORT', 'FORM', 'FORMS', 'BY', 'OF', 'FOR']);
/** Words that cannot name an entity on their own ("the number of filings", "calendar", "year"). */
export const FILLER_WORDS = new Set([
  ...LEADING_FILLER, ...TRAILING_FILLER, 'CALENDAR', 'YEAR', 'YEARS', 'MONTH', 'MONTHS', 'IN', 'DURING', 'A', 'AN', 'AND',
  'HOW', 'MANY', 'WHAT', 'IS', 'ARE', 'WAS', 'WERE', 'PERIOD', 'LAST', 'TO', 'WITH', 'SUBMITTED', 'MADE',
]);
/** Labelled CIK clauses: "(CIK 320193)", "CIK0000320193", "cik: 320193", "CIK#320193", "CIK No. 320193". */
const CIK_CLAUSE_RE = /\(?\s*\bCIK(?:\s*(?:NO\.?|NUMBER|#|:))?\s*#?\s*(\d{1,10})\b\s*\)?/gi;

/** Replace every labelled CIK clause with spaces of the same length (offsets preserved); returns the claimed CIKs. */
export function blankCikClauses(text: string): { text: string; ciks: number[] } {
  const ciks: number[] = [];
  const out = text.replace(CIK_CLAUSE_RE, (m: string, d: string) => {
    ciks.push(Number(d));
    return ' '.repeat(m.length);
  });
  return { text: out, ciks };
}

export interface Extraction {
  /** Remaining text (raw tokens) with form phrases, CIK clauses and edge filler removed; the input itself when nothing was found. */
  rest: string;
  forms: string[];
  /** CIKs claimed by labelled clauses and (entity only) bare 5-10 digit numbers. */
  ciks: number[];
  /** The text uses filing scaffolding (FILING/FORM/REPORT/FILED), a form, or a CIK claim: it is an EDGAR question. */
  edgarQuestion: boolean;
  /** Scaffolding keyword present but no form and no CIK was found. */
  scaffoldOnly: boolean;
}

interface Tok {
  raw: string;
  core: string;
}

function tokenize(text: string): Tok[] {
  return text
    .replace(/\s*\/\s*/g, '/')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((raw) => ({ raw, core: tokenCore(raw) }))
    .filter((t) => t.core !== '' || t.raw.trim() !== '');
}

function scan(toks: Tok[], keyword: boolean): Array<{ i: number; form: string; len: number }> {
  const hits: Array<{ i: number; form: string; len: number }> = [];
  for (let i = 0; i < toks.length; ) {
    const afterForm = (toks[i].core === 'FORM' || toks[i].core === 'FORMS') && i + 1 < toks.length;
    const start = afterForm ? i + 1 : i;
    const ctx = { keyword, explicit: afterForm };
    let matched: { form: string; len: number } | null = null;
    for (let n = Math.min(MULTIWORD_MAX_TOKENS, toks.length - start); n >= 2 && !matched; n--) {
      const words = toks.slice(start, start + n);
      if (words[n - 1].core === 'A') continue;
      const f = lookupForm(words.map((t) => t.core).join(' '), ctx, words.map((t) => t.raw).join(' '));
      if (f !== null) matched = { form: f, len: start - i + n };
    }
    if (!matched) {
      const f = lookupForm(toks[start].core, ctx, toks[start].raw);
      if (f !== null) matched = { form: f, len: start - i + 1 };
    }
    if (matched) {
      hits.push({ i, ...matched });
      i += matched.len;
    } else {
      i += 1;
    }
  }
  return hits;
}

/**
 * Pull EDGAR form phrases and CIK claims out of free text
 * ("Form 10-K filings by Apple Inc. (CIK 320193)" -> rest "Apple Inc.",
 * forms ["10-K"], ciks [320193]). Throws 422 INVALID_FORM_TYPE on a
 * form-shaped token with an invalid suffix ("10-K/A-1", "144/A1",
 * "13F-HR2"). Invisible characters inside a token are stripped for
 * matching ("10\u00AD-K" is 10-K); the returned rest keeps the raw tokens.
 */
export function extractForms(text: string, opts: { allowCik: boolean; bareNumberCik: boolean }): Extraction {
  const ciks: number[] = [];
  let folded = foldBasic(text);
  if (opts.allowCik) {
    folded = folded.replace(CIK_CLAUSE_RE, (_m, d: string) => {
      ciks.push(Number(d));
      return ' ';
    });
  }
  let toks = tokenize(folded);
  const keyword = toks.some((t) => FILING_KEYWORDS.has(t.core));
  const hits = scan(toks, keyword);
  const consumed = new Set<number>();
  for (const h of hits) for (let k = h.i; k < h.i + h.len; k++) consumed.add(k);
  if (opts.bareNumberCik) {
    // R6-M3: a bare 5-10 digit number next to a name is a CIK claim that
    // must agree with the resolved company ("Apple Inc. 1318605 filings"
    // must never serve Apple's count). A text that is ONLY digits is a
    // bare CIK and handled by the caller.
    const nonNumeric = toks.some((t, k) => !consumed.has(k) && !/^\d+$/.test(t.core) && t.core !== '');
    if (nonNumeric) {
      toks.forEach((t, k) => {
        if (!consumed.has(k) && /^\d{5,10}$/.test(t.core)) {
          ciks.push(Number(t.core));
          consumed.add(k);
        }
      });
    }
  }
  if (hits.length === 0 && ciks.length === 0 && !keyword) {
    return { rest: text, forms: [], ciks: [], edgarQuestion: false, scaffoldOnly: false };
  }
  toks = toks.filter((_t, k) => !consumed.has(k));
  while (toks.length > 0 && LEADING_FILLER.has(toks[0].core)) toks = toks.slice(1);
  while (toks.length > 0 && TRAILING_FILLER.has(toks[toks.length - 1].core)) toks = toks.slice(0, -1);
  if (toks.length > 0) {
    const last = toks[toks.length - 1];
    toks[toks.length - 1] = { raw: last.raw.replace(/['\u2019]s$/i, '').replace(/,$/, ''), core: last.core };
  }
  return {
    rest: toks.map((t) => t.raw).join(' ').trim(),
    forms: hits.map((h) => h.form),
    ciks,
    edgarQuestion: true,
    scaffoldOnly: hits.length === 0 && ciks.length === 0,
  };
}

/** True when every token of `text` is filler (or, in an EDGAR question, a bare 1-4 digit number). */
export function isFillerOnly(text: string, edgarQuestion: boolean): boolean {
  const toks = tokenize(foldBasic(text));
  // Only real filler WORDS count: a punctuation/invisible-only entity
  // ("...", "///", "\u200b") is left to the generic gate (422).
  if (toks.length === 0 || !toks.some((t) => FILLER_WORDS.has(t.core))) return false;
  return toks.every((t) => FILLER_WORDS.has(t.core) || (edgarQuestion && /^\d{1,4}$/.test(t.core)));
}

/**
 * THE handler-level guard on the RESIDUE. Every residue (entity text
 * left after extraction, period text left after extraction, every extra
 * query value) must carry NO form-like token — strong form shapes,
 * bare numeric forms in a filing context, slash/compact amendments. A
 * hit is 422 FORM_TOKEN_UNCONSUMED, never a silent unfiltered count.
 */
export function assertNoUnconsumedFormTokens(residues: Array<{ field: string; value: string }>): void {
  for (const { field, value } of residues) {
    if (typeof value !== 'string' || value === '') continue;
    const toks = tokenize(foldBasic(value));
    const keyword = toks.some((t) => FILING_KEYWORDS.has(t.core));
    let hits: Array<unknown> = [];
    try {
      hits = scan(toks, keyword);
    } catch {
      hits = [1];
    }
    if (hits.length > 0) {
      throw unprocessable(
        'FORM_TOKEN_UNCONSUMED',
        `Query field "${field}" ("${value}") contains an SEC form type that was not applied as a filter; pass it as form_type`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Renamed form families (A1 round 9, J2-r8 M1). EDGAR Release 24.4
// (deployed 2024-12-16; https://www.sec.gov/submit-filings/edgar-news-announcements/edgar-release-24-4)
// replaced the HTML/ASCII submission types SC 13D / SC 13G and their
// amendments with the XML submission types SCHEDULE 13D / SCHEDULE 13G
// (Modernization of Beneficial Ownership Reporting, Release No. 33-11253,
// Oct. 10, 2023; structured data required from 2024-12-18). Both spellings
// name the SAME schedule, so a request for either counts both. Audit of the
// closed vocabulary against the 136-quarter full-index counts (A1-BUILD r9):
// SC 13G, SC 13G/A and SC 13D drop to 0 after 2024Q4, where SCHEDULE 13G /
// 13G/A / 13D / 13D/A take over (a few early SCHEDULE 13G/13G/A appear in
// 2023Q4 and SCHEDULE 13D/13D/A in 2024Q1, before the 2024-12-18 mandate).
// SC 13D/A continues in small numbers through 2026Q3 (7+3+1+0+2+19+4 in
// 2025Q1..2026Q3) alongside SCHEDULE 13D/A, which is why both spellings
// must be counted together. Every other "SC ..." form (SC TO-C, SC TO-I,
// SC TO-T, SC 14D9, SC 13E3, SC 14F1, SC 14N and their /A) is still filed
// under its SC name through 2026 and has no SCHEDULE twin, so it is not
// aliased. An original and its amendment are never merged (10-K != 10-K/A).
// ---------------------------------------------------------------------------

export const FORM_FAMILIES: ReadonlyArray<readonly string[]> = [
  ['SC 13D', 'SCHEDULE 13D'],
  ['SC 13D/A', 'SCHEDULE 13D/A'],
  ['SC 13G', 'SCHEDULE 13G'],
  ['SC 13G/A', 'SCHEDULE 13G/A'],
];
export const FORM_FAMILY_SOURCE =
  'SEC EDGAR Release 24.4 (2024-12-16): SC 13D/SC 13G (and /A) replaced by SCHEDULE 13D/SCHEDULE 13G (and /A); Release No. 33-11253; https://www.sec.gov/submit-filings/edgar-news-announcements/edgar-release-24-4';
const FAMILY_OF = new Map<string, readonly string[]>();
for (const fam of FORM_FAMILIES) for (const f of fam) FAMILY_OF.set(f, fam);

/** Every literal EDGAR form string counted for a requested canonical form (itself, plus its renamed twin). */
export function formFamily(form: string): readonly string[] {
  return FAMILY_OF.get(form) ?? [form];
}

/** Separate fields must name the same exact form-family set; never silently widen. */
export function mergeFormSpecs(sources: Array<{ field: string; forms: string[] }>): FormSpec {
  const nonempty = sources.filter(s => s.forms.length);
  if (!nonempty.length) return { kind: 'none' };
  const families = (forms: string[]) => [...new Set(forms.map(f => formFamily(f)[0]))].sort();
  const first = families(nonempty[0].forms);
  if (nonempty.some(s => JSON.stringify(families(s.forms)) !== JSON.stringify(first))) {
    throw unprocessable('CONFLICTING_FORM_TYPE', 'Form filters in separate fields name different form sets; use the same explicit set');
  }
  if (nonempty.some(s => !['form_type', 'form'].includes(s.field) && families(s.forms).length > 1)) {
    throw unprocessable('MULTIPLE_FORM_TYPES', 'Pass multiple forms as an explicit form_type list');
  }
  const forms = [...new Set(nonempty[0].forms)];
  return forms.length === 1 ? { kind: 'form', form: forms[0] } : { kind: 'forms', forms };
}

/**
 * Exact-match filter on the EDGAR form column. AMENDMENT CONVENTION
 * (A1, 2026-11-21): "10-K" counts original 10-K rows only (handoff §6:
 * Apple 10-K 2023 = 1, Tesla 10-Q 2023 = 3, by filingDate, no
 * amendments); "X/A" counts X/A rows only (Apple 144/A 2025 = 1, Tesla
 * 5/A 2023 = 1, Tesla 4/A 2023 = 1). An amendment is never merged with
 * its base and the unfiltered total is never served for a form ask.
 * Round 9: a renamed form counts every literal spelling of its family
 * (SC 13G/A and SCHEDULE 13G/A), see FORM_FAMILIES.
 */
export function filterFilingsByForm<T extends { form: string }>(filings: T[], spec: FormSpec): T[] {
  if (spec.kind === 'none') return filings;
  const fam = spec.kind === "forms" ? spec.forms.flatMap(f => [...formFamily(f)]) : formFamily(spec.form);
  return filings.filter((f) => fam.includes(f.form));
}
