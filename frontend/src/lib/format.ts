const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * Blank-rendering characters that `String.trim()` does NOT strip
 * (J2 R6 B-1 — category-based, replacing the R5 literal list, which
 * missed whole classes of the same bug). A string "has a visible
 * character" only if, after removing these, something non-whitespace
 * remains. A visible character next to one (e.g. "a\u200Bb") still
 * counts: only all-invisible strings are blank.
 *
 * The strip is a Unicode CATEGORY, not a literal list, so no future
 * code point in the class can slip through:
 * - `\p{Cf}` (format controls): the whole R5 list (U+00AD, U+180E,
 *   U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+FEFF) plus the
 *   R6 survivors — isolates U+2066–U+2069, U+206A, U+206F, Arabic
 *   marks U+061C, U+0600–U+0605, U+06DD, U+070F, U+0890–U+0891,
 *   U+08E2, shorthand U+1BCA0–U+1BCA3, U+1D173, U+13430,
 *   interlinear U+FFF9–U+FFFB, tags U+E0001, U+E007F.
 * - `\p{Cc}` (control characters, J2 R7 B-1): all 65 — U+0000–U+001F,
 *   U+007F–U+009F. The 5 White_Space ones (U+0009–U+000D) were
 *   already caught by trim(); the other 60 passed as "visible" and
 *   rendered blank. Controls have no glyph by definition, and a
 *   control-only receipt field / param is never legitimate content.
 * - `\p{Default_Ignorable_Code_Point}` (J2 R7 open item, measured in
 *   real Chromium 156 headless): renderers MUST ignore these by
 *   Unicode definition. Full-class canvas-width enumeration in that
 *   Chromium: all 4,174 DICP code points measure ZERO width except
 *   the 8 already stripped above (Hangul fillers U+115F/U+1160/
 *   U+3164/U+FFA0 + shorthand U+1BCA0–U+1BCA3); spot pixel-ink
 *   counts are 0 for U+2065, U+17B4, U+17B5, U+FFF0, U+E0000,
 *   U+E0080. This retires the R6 keep-list for U+2065, U+17B4,
 *   U+17B5 — the "renders visibly (tofu / dotted circle)" claim was
 *   false in real Chromium (0.00 width, 0 ink px at 16px and 64px).
 *   The newly-covered remainder is 3,771 code points: U+17B4–U+17B5,
 *   U+2065, U+FFF0–U+FFF8, U+E0000, U+E0002–U+E001F, U+E0080–U+E00FF,
 *   U+E01F0–U+E0FFF.
 * - Variation selectors + CGJ (Mn, but ONLY these — a blanket `\p{Mn}`
 *   would also strip lone combining marks, which render visibly):
 *   U+180B–U+180D, U+180F, U+FE00–U+FE0F, U+E0100–U+E01EF, U+034F.
 * - Hangul fillers (Lo, invisible by construction): U+115F, U+1160,
 *   U+3164, U+FFA0.
 * - U+2800 BRAILLE PATTERN BLANK (So, not White_Space — trim() does
 *   not strip it, and it renders as an empty cell).
 *
 * Deliberately NOT stripped (verified keep-list, see format.test.ts):
 * lone combining marks U+0301, U+0610 (Mn — they draw a small mark
 * even alone: 57 / 95 ink px at 64px in Chromium 156, zero advance
 * width, no dotted circle; documented residual, NOT a class — the
 * full Mn class is not deterministically invisible: 1,075 of 2,059
 * Mn code points have non-zero advance width in the same Chromium,
 * so no blanket `\p{Mn}` strip). PUA, noncharacters, unassigned Cn
 * and lone Mc marks render as visible tofu / glyphs (12.00–12.31px
 * advance, 444 ink px at 64px) and are NOT stripped; lone
 * surrogates render as U+FFFD (16.02px, 1,543 ink px).
 *
 * Unicode property escapes need ES2018+ (project target ES2022,
 * Node 24, modern browsers) — verified in Node 24 and in the
 * jsdom/vitest suite against every code point above.
 */
const INVISIBLE_FORMAT_CHARS =
  /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u180B-\u180D\u180F\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0\u2800]/gu;

/** True when `value` is a string containing at least one visible character. */
export function hasVisibleCharacter(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.replace(INVISIBLE_FORMAT_CHARS, "").trim().length > 0;
}

/**
 * Cap on the unparseable-input passthrough in formatDate (J2 R5 m5):
 * a short invalid string ("not-a-date") still passes through verbatim
 * (tested behaviour), but an over-long invalid string renders "—"
 * instead of landing 100k chars in the DOM. 128 mirrors
 * MAX_RECEIPT_FETCHED_AT_LENGTH (api.ts) — the card already caps
 * fetched_at at 128 before calling formatDate, so this only binds
 * direct callers of the exported helper. The cap applies ONLY to the
 * unparseable branch: a parseable date is always short.
 */
const MAX_INVALID_DATE_PASSTHROUGH_LENGTH = 128;

const usdPrecise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** $15,083,256,265 — whole dollars, no cents. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  // -0 formats as "-$0" in Intl; normalise it to plain $0 (J2 M-4).
  return usd.format(value === 0 ? 0 : value);
}

/** $43.43 — two decimals, for per-MWh prices and other small USD values. */
export function formatUsdPrecise(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return usdPrecise.format(value === 0 ? 0 : value);
}

/** 1.2345 ETH — up to 6 decimals, trailing zeros trimmed. */
export function formatEth(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  // Whitespace-only strings coerce to 0 via Number(" ") — they are not
  // amounts and must render as "—" (J2 M-4). Same for strings of only
  // invisible format characters (J2 R5 B-1): trim() does not strip
  // U+200B etc., so hasVisibleCharacter decides, not trim().
  if (typeof value === "string" && !hasVisibleCharacter(value)) return "—";
  const num = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(num)) return "—";
  // -0 renders as "-0 ETH" via toLocaleString; normalise it (J2 M-4).
  const normalised = num === 0 ? 0 : num;
  return `${normalised.toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`;
}

/**
 * ISO timestamp -> "20 Nov 2026, 07:37 UTC" (UTC, deterministic).
 * Total over non-string values (B-1b): a receipt field arriving as a
 * number/object must render "—", never throw and never hand React an
 * object child.
 */
export function formatDate(value: unknown): string {
  // Whitespace-only strings are unparseable (new Date("   ") is Invalid
  // Date) and used to be returned verbatim, rendering a blank cell
  // (J2 R4 B-1, re-opened): like shortenSha/shortenHash, they render "—".
  // Strings of only invisible format characters (U+200B etc.) are blank
  // the same way — trim() does not strip them, so hasVisibleCharacter
  // decides (J2 R5 B-1). Non-whitespace unparseable input still passes
  // through ("not-a-date") — that passthrough is tested behaviour, not
  // a blank render — subject to the over-long cap below (J2 R5 m5).
  if (typeof value !== "string" || value.length === 0 || !hasVisibleCharacter(value)) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.length > MAX_INVALID_DATE_PASSTHROUGH_LENGTH ? "—" : value;
  }
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const year = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hh}:${mm} UTC`;
}

/**
 * 0x1234…abcd — first 6 chars, ellipsis, last 4.
 * Total over non-string values (B-1b): a numeric sha used to throw
 * (value.slice on a number). Any non-string renders "—".
 */
export function shortenHash(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !hasVisibleCharacter(value)) return "—";
  if (value.length <= 13) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * 0x1b9f3e59…211b9685 — first 10 chars, ellipsis, last 8.
 * Total over non-string values (B-1b), same as shortenHash.
 */
export function shortenSha(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !hasVisibleCharacter(value)) return "—";
  if (value.length <= 20) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
