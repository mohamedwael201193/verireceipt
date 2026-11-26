// Deterministic past-tense to Polymarket "Will ..." question rewrite, plus the
// content guard that keeps the rewritten match to the same year, date, number and qualifiers.
// A rewrite is only a way to find the market; it never creates an outcome.
const PARTICIPLES: Record<string, string> = {
  won: 'win', lost: 'lose', hit: 'hit', cut: 'cut', beaten: 'beat', passed: 'pass',
  reached: 'reach', signed: 'sign', approved: 'approve', resigned: 'resign', ended: 'end',
  announced: 'announce', launched: 'launch', released: 'release', crossed: 'cross', exceeded: 'exceed',
};
export interface Rewrite { query: string; rule: 'did' | 'has_have_had'; }
export function willRewrite(event: string): Rewrite | null {
  const text = event.trim().replace(/[?.!\s]+$/, '');
  const did = /^did\s+(\S.*)$/i.exec(text);
  if (did) return { query: `Will ${did[1]}?`, rule: 'did' };
  const perfect = /^(?:has|have|had)\s+(\S.*)$/i.exec(text);
  if (!perfect) return null;
  const words = perfect[1].split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const base = PARTICIPLES[words[i].toLowerCase()];
    if (base) { words[i] = base; return { query: `Will ${words.join(' ')}?`, rule: 'has_have_had' }; }
  }
  return null;
}
const MONTHS = ['january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'];
const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
/** Every number (year, day, threshold, count) and month name in the text, normalized. */
export function scopeTokens(text: string): string[] {
  const t = text.toLowerCase();
  const out = new Set<string>();
  for (const m of t.matchAll(/\$?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million|b|billion|%|percent)?(?![a-z0-9])/g)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const unit = m[2];
    if (unit === '%' || unit === 'percent') out.add(`${n}%`);
    else out.add(String(unit ? n * MULT[unit] : n));
  }
  for (const w of t.match(/[a-z]+/g) ?? []) if (MONTHS.includes(w)) out.add(`month:${w.slice(0, 3)}`);
  if (/\bmay\s+\d|\d\s+may\b/.test(t)) out.add('month:may');
  return [...out].sort();
}
const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'by']);
const words = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
/** A rewritten query may only match a market question that is the same, or differs by stopwords alone. */
export function sameContent(query: string, question: string): boolean {
  const a = words(query), b = words(question);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const start = long.findIndex((_, i) => short.every((w, j) => long[i + j] === w));
  if (start < 0) return false;
  return [...long.slice(0, start), ...long.slice(start + short.length)].every((w) => STOP.has(w));
}
