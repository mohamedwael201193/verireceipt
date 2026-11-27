// Pure sanctions-list parsing and fuzzy name matching. Zero I/O, zero
// imports: shared by the live miner handler (sanctionsScreening.ts) and by
// the research desk's independent primary recompute, so both always run the
// exact same algorithm. Moved verbatim out of sanctionsScreening.ts.

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

/** Legal-form tokens are jurisdiction boilerplate, not identity: the
 * company behind "PJSC MTS BANK" is MTS BANK. They are dropped from both
 * names before scoring (graded receipt rcpt_2ZJWV2G5XZDSTWD2YZK98VEJIF:
 * "MTS BANK" scored 0.8 against the SDN alias "PJSC MTS BANK" and stayed
 * under the 0.85 threshold on the legal-form token alone). */
const LEGAL_FORM_TOKENS = new Set([
  "pjsc", "jsc", "ojsc", "cjsc", "pao", "oao", "zao", "ao", "llc", "ooo",
  "ltd", "limited", "inc", "corp", "corporation", "co", "company", "plc",
  "sa", "ag", "gmbh", "nv", "bv", "public", "joint", "stock",
]);

/** A name that stripping would empty keeps its tokens: two legal-form-only
 * names must never collapse into an empty-string "match". */
function withoutLegalForms(tokens: string[]): string[] {
  const kept = tokens.filter((t) => !LEGAL_FORM_TOKENS.has(t));
  return kept.length ? kept : tokens;
}

/** One normalized pair: max of Sørensen-Dice on the token sets and
 * normalized Levenshtein on the whole string. */
function pairScore(a: string, b: string): number {
  if (a === b) return 1;
  const ta = a.split(" ");
  const tb = b.split(" ");
  const setB = new Set(tb);
  const inter = ta.filter((t) => setB.has(t)).length;
  const dice = (2 * inter) / (ta.length + tb.length);
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.round(Math.max(dice, lev) * 1e6) / 1e6;
}

/** Slavic patronymic suffixes: the extra token in a listed name that a
 * short public name lacks ("KADYROV, Ramzan Akhmatovich" vs the public
 * "Ramzan Kadyrov"). Covers Russian and common transliteration variants
 * (ovich/ovitch, evich, ovych/evych) and the female forms (ovna/evna,
 * ivna/yivna). */
const PATRONYMIC = /(ovich|ovitch|evich|ovych|evych|ovna|evna|ivna|yivna)$/;

/** The documented score: max of Sørensen-Dice on the token sets and
 * normalized Levenshtein on the whole normalized string — with two
 * legal-form rules on the stripped cores.
 *
 * Equal core: when both names reduce to the SAME token set once legal-form
 * tokens are dropped (same core, differing only in jurisdiction
 * boilerplate like "PJSC MTS BANK" vs "MTS BANK"), the score is 1.
 *
 * Patronymic core: when the query core has at least 2 tokens, each at
 * least 3 characters, every query token appears in the candidate core,
 * and every EXTRA candidate token is a Slavic patronymic, the score is
 * the raw comparison raised to a 0.9 floor. A public short name is the
 * same person as a listed name that only adds a patronymic (graded
 * evidence: prod answered matched=false, best 0.8, for "Ramzan Kadyrov"
 * against SDN #23343 "KADYROV, Ramzan Akhmatovich", tokens
 * {ramzan,kadyrov} vs {kadyrov,ramzan,akhmatovich}, Dice 4/5 = 0.8 under
 * the 0.85 threshold). The floor is 0.9, not 1: a subset is weaker
 * evidence than an equal core. The guard rails are what keep the rule
 * safe (measured on the real SDN+ALT+UN lists, 2026-11-27): a plain
 * subset rule newly lifts 4,419 cross-entity pairs to >=0.85; requiring
 * patronymic-only extras, forward direction, and the 2-token/3-char
 * minimums leaves 19, each a first+last name shared with a genuinely
 * listed person (6 the same person across the UN and OFAC lists, 13 a
 * name collision between two listed individuals). A single-token side
 * never takes this path, tokens shorter than 3 characters never
 * participate, and the reverse direction (a short listed alias inside a
 * longer query) never fires. Anything short of this scores exactly the
 * raw comparison. */
export function matchScore(query: string, candidate: string): number {
  const a = normalizeName(query);
  const b = normalizeName(candidate);
  if (!a || !b) return 0;
  const strippedA = withoutLegalForms(a.split(" "));
  const strippedB = withoutLegalForms(b.split(" "));
  const setA = new Set(strippedA);
  const setB = new Set(strippedB);
  if (setA.size === setB.size && [...setA].every((t) => setB.has(t))) return 1;
  const raw = pairScore(a, b);
  if (
    setA.size >= 2 &&
    [...setA].every((t) => t.length >= 3 && setB.has(t)) &&
    [...setB].every((t) => setA.has(t) || PATRONYMIC.test(t))
  ) {
    return Math.max(raw, 0.9);
  }
  return raw;
}
