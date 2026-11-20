import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatEth,
  formatUsd,
  formatUsdPrecise,
  hasVisibleCharacter,
  shortenHash,
  shortenSha,
} from "./format";

describe("formatUsd", () => {
  it("formats whole dollars without cents", () => {
    expect(formatUsd(15083256265)).toBe("$15,083,256,265");
    expect(formatUsd(0)).toBe("$0");
  });

  it("returns an em dash for null/undefined/NaN", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
  });

  it("returns an em dash for non-finite input (J2 M7)", () => {
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatUsd(Number.NEGATIVE_INFINITY)).toBe("—");
    expect(formatUsdPrecise(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatUsdPrecise(Number.NaN)).toBe("—");
  });
});

describe("formatUsdPrecise", () => {
  it("keeps two decimals", () => {
    expect(formatUsdPrecise(43.43)).toBe("$43.43");
    expect(formatUsdPrecise(1739.26)).toBe("$1,739.26");
  });
});

describe("formatEth", () => {
  it("formats numbers and numeric strings with the ETH suffix", () => {
    expect(formatEth(1.23456789)).toBe("1.234568 ETH");
    expect(formatEth("0.5")).toBe("0.5 ETH");
  });

  it("returns an em dash for missing or non-numeric input", () => {
    expect(formatEth(null)).toBe("—");
    expect(formatEth("not-a-number")).toBe("—");
  });

  it("returns an em dash for non-finite input (J2 M7)", () => {
    expect(formatEth(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatEth(Number.NEGATIVE_INFINITY)).toBe("—");
    expect(formatEth(Number.NaN)).toBe("—");
    expect(formatEth("Infinity")).toBe("—");
  });
});

describe("formatDate", () => {
  it("renders an ISO timestamp in UTC", () => {
    expect(formatDate("2026-11-20T07:37:12.206Z")).toBe("20 Nov 2026, 07:37 UTC");
  });

  it("passes invalid input through and dashes empty input", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
  });

  it("returns an em dash for whitespace-only input (J2 R4 B-1, re-opened)", () => {
    // Whitespace-only is unparseable and used to be returned verbatim,
    // rendering a blank Fetched-at cell.
    expect(formatDate("   ")).toBe("—");
    expect(formatDate("\t\n")).toBe("—");
    expect(formatDate(" ")).toBe("—");
  });
});

describe("shortenHash", () => {
  it("truncates a long hash to 6 + ellipsis + 4", () => {
    expect(shortenHash("0x1234567890abcdef")).toBe("0x1234…cdef");
  });

  it("leaves short values untouched", () => {
    expect(shortenHash("0x1234")).toBe("0x1234");
    expect(shortenHash(null)).toBe("—");
  });
});

describe("shortenSha", () => {
  it("truncates a sha256 to 10 + ellipsis + 8", () => {
    expect(
      shortenSha("0x1b9f3e593e73354720f2329c7bc53c56abf4ef1c4ce38ecc7d6aa26c211b9685"),
    ).toBe("0x1b9f3e59…211b9685");
  });

  it("leaves short values untouched", () => {
    expect(shortenSha("0xabc")).toBe("0xabc");
  });
});

describe("formatEth whitespace / -0 (J2 R2 M-4)", () => {
  it("returns an em dash for whitespace-only strings", () => {
    expect(formatEth(" ")).toBe("—");
    expect(formatEth("   ")).toBe("—");
    expect(formatEth("\t\n")).toBe("—");
  });

  it("normalises -0 to 0 (no '-0 ETH')", () => {
    expect(formatEth(-0)).toBe("0 ETH");
    expect(formatEth("-0")).toBe("0 ETH");
  });
});

describe("invisible format characters render '—' (J2 R5 B-1)", () => {
  // trim() strips NBSP/FEFF but NOT these: every one used to pass the
  // blank-render guards and render as a visually blank cell.
  const INVISIBLE = [
    "\u200B", // ZWSP
    "\u200C", // ZWNJ
    "\u200D", // ZWJ
    "\u2060", // WORD JOINER
    "\u180E", // Mongolian vowel separator
    "\u00AD", // SOFT HYPHEN (J2 R6 M-4: card battery omitted it)
    "\uFEFF", // BOM (J2 R6 M-4: card battery omitted it)
    "\u202E", // RIGHT-TO-LEFT OVERRIDE (J2 R6 M-4: card battery omitted it)
    "\u200B\u200B", // doubled
    " \u200B ", // mixed with spaces
    "\u200B \u200C \u200D", // mixed multiples
  ];

  it.each(INVISIBLE)("formatDate renders '—' for %s", (value) => {
    expect(formatDate(value)).toBe("—");
  });

  it.each(INVISIBLE)("shortenHash renders '—' for %s", (value) => {
    expect(shortenHash(value)).toBe("—");
  });

  it.each(INVISIBLE)("shortenSha renders '—' for %s", (value) => {
    expect(shortenSha(value)).toBe("—");
  });

  it.each(INVISIBLE)("formatEth renders '—' for %s", (value) => {
    expect(formatEth(value)).toBe("—");
  });

  it("still passes through / formats strings that have a visible character next to a format character", () => {
    // Only all-invisible strings are blank: a ZWSP inside real content
    // must not nuke the value.
    expect(formatDate("x\u200B")).toBe("x\u200B");
    expect(shortenSha("0xabc\u200B")).toBe("0xabc\u200B");
    expect(shortenHash("0x1234\u200B")).toBe("0x1234\u200B");
  });
});

describe("formatDate over-long invalid passthrough (J2 R5 m5)", () => {  it("renders '—' for an over-long invalid string instead of passing 100k chars through", () => {
    expect(formatDate("x".repeat(100_000))).toBe("—");
    expect(formatDate("x".repeat(129))).toBe("—");
  });

  it("still passes a short invalid string through, and keeps the 128-char boundary", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
    expect(formatDate("x".repeat(128))).toBe("x".repeat(128));
  });
});

describe("formatUsd -0 (J2 R2 M-4)", () => {
  it("normalises -0 to 0 (no '-$0')", () => {
    expect(formatUsd(-0)).toBe("$0");
    expect(formatUsdPrecise(-0)).toBe("$0.00");
  });
});

describe("formatters total over non-string values (J2 R2 B-1b)", () => {
  it("formatDate renders '—' for numbers, objects and arrays — never throws, never returns an object", () => {
    expect(formatDate(12345)).toBe("—");
    expect(formatDate({})).toBe("—");
    expect(formatDate([])).toBe("—");
    expect(formatDate(true)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });

  it("shortenSha renders '—' for numbers and objects — never throws on .slice", () => {
    expect(shortenSha(12345)).toBe("—");
    expect(shortenSha({})).toBe("—");
    expect(shortenSha([])).toBe("—");
    expect(shortenSha(null)).toBe("—");
    expect(shortenSha(undefined)).toBe("—");
  });

  it("shortenHash renders '—' for numbers and objects", () => {
    expect(shortenHash(12345)).toBe("—");
    expect(shortenHash({})).toBe("—");
    expect(shortenHash(null)).toBe("—");
  });

  it("shortenSha / shortenHash render '—' for whitespace-only and empty strings (J2 R3 B-1)", () => {
    expect(shortenSha("")).toBe("—");
    expect(shortenSha("   ")).toBe("—");
    expect(shortenSha("\t\n")).toBe("—");
    expect(shortenHash("")).toBe("—");
    expect(shortenHash("   ")).toBe("—");
    expect(shortenHash("\t\n")).toBe("—");
  });
});

describe("extended blank-rendering family renders '—' (J2 R6 B-1)", () => {
  // Every code point J2's round-5 repro listed as surviving the R5
  // literal strip list, as ranges expanded to single code points
  // (295 in total). A string of only one such character must be blank
  // in every formatter — the R5 list covered 8 of these and missed
  // the rest, so the regression battery covers the FULL family, not
  // a sample of it.
  const range = (start: number, end: number): number[] => {
    const out: number[] = [];
    for (let cp = start; cp <= end; cp++) out.push(cp);
    return out;
  };
  const CODE_POINTS = [
    // Cf isolates / format: U+2066–U+2069, U+206A, U+206F, U+061C,
    // U+0600–U+0605, U+06DD, U+070F, U+0890–U+0891, U+08E2,
    // U+1BCA0–U+1BCA3, U+1D173, U+13430, U+FFF9–U+FFFB, U+E0001, U+E007F
    ...range(0x2066, 0x2069),
    0x206a, 0x206f, 0x061c, ...range(0x0600, 0x0605), 0x06dd, 0x070f,
    ...range(0x0890, 0x0891), 0x08e2, ...range(0x1bca0, 0x1bca3), 0x1d173,
    0x13430, ...range(0xfff9, 0xfffb), 0xe0001, 0xe007f,
    // Mn variation selectors / CGJ: U+180B–U+180D, U+180F,
    // U+FE00–U+FE0F, U+E0100–U+E01EF, U+034F
    ...range(0x180b, 0x180d),
    0x180f,
    ...range(0xfe00, 0xfe0f),
    ...range(0xe0100, 0xe01ef),
    0x034f,
    // Lo Hangul fillers: U+115F, U+1160, U+3164, U+FFA0
    0x115f, 0x1160, 0x3164, 0xffa0,
    // So blank cell: U+2800
    0x2800,
  ];
  const EXTENDED = CODE_POINTS.map((cp) => String.fromCodePoint(cp));

  it("covers exactly the 295 extended-family code points", () => {
    expect(CODE_POINTS).toHaveLength(295);
    expect(new Set(CODE_POINTS).size).toBe(295);
  });

  it.each(EXTENDED)("hasVisibleCharacter is false for U+%s", (value) => {
    expect(hasVisibleCharacter(value)).toBe(false);
  });

  it.each(EXTENDED)("formatDate renders '—' for %s", (value) => {
    expect(formatDate(value)).toBe("—");
  });

  it.each(EXTENDED)("shortenHash renders '—' for %s", (value) => {
    expect(shortenHash(value)).toBe("—");
  });

  it.each(EXTENDED)("shortenSha renders '—' for %s", (value) => {
    expect(shortenSha(value)).toBe("—");
  });

  it.each(EXTENDED)("formatEth renders '—' for %s", (value) => {
    expect(formatEth(value)).toBe("—");
  });

  it("does NOT strip lone combining marks that draw a mark (U+0301, U+0610) — but U+2065 / U+17B4 / U+17B5 ARE now stripped (J2 R7 open item)", () => {
    // REVISED keep-list (measured in real Chromium 156 headless,
    // 16px sans-serif, span rect + canvas + pixel ink): U+2065,
    // U+17B4 and U+17B5 are Default_Ignorable_Code_Point — 0.00
    // width AND 0 ink px at 16px and 64px — so the R6 "tofu / dotted
    // circle" claim was false and they are stripped with the rest of
    // the DICP class. Lone U+0301 / U+0610 DO draw a small mark even
    // alone (57 / 95 ink px at 64px, 7 / 9 at 16px; zero advance
    // width, no dotted circle), so they stay visible — documented
    // residual, not a class: 1,075 of 2,059 Mn code points have
    // non-zero advance width in the same Chromium, so no blanket
    // \p{Mn} strip.
    for (const value of ["\u0301", "\u0610"]) {
      expect(hasVisibleCharacter(value)).toBe(true);
    }
    for (const value of ["\u2065", "\u17B4", "\u17B5"]) {
      expect(hasVisibleCharacter(value)).toBe(false);
      expect(formatDate(value)).toBe("—");
      expect(shortenSha(value)).toBe("—");
      expect(shortenHash(value)).toBe("—");
      expect(formatEth(value)).toBe("—");
    }
    expect(formatDate("\u0301")).toBe("\u0301");
    expect(shortenSha("0xabc\u0301")).toBe("0xabc\u0301");
  });
});

describe("control characters (Cc) render '—' (J2 R7 B-1)", () => {
  // All 65 \p{Cc} code points: U+0000–U+001F and U+007F–U+009F.
  // 5 of them are White_Space (U+0009–U+000D, already trim-caught);
  // the other 60 are the newly-stripped family — every one used to
  // pass hasVisibleCharacter and render raw (formatDate/shortenHash/
  // shortenSha returned "\u0001" verbatim; only U+000B/U+000C were
  // rejected before, via trim()).
  const range = (start: number, end: number): number[] => {
    const out: number[] = [];
    for (let cp = start; cp <= end; cp++) out.push(cp);
    return out;
  };
  const CODE_POINTS = [...range(0x00, 0x1f), ...range(0x7f, 0x9f)];
  const CC = CODE_POINTS.map((cp) => String.fromCodePoint(cp));

  it("covers exactly the 65 control code points (60 non-whitespace + 5 White_Space)", () => {
    expect(CODE_POINTS).toHaveLength(65);
    expect(new Set(CODE_POINTS).size).toBe(65);
    const nonWhiteSpace = CODE_POINTS.filter(
      (cp) => !/\s/u.test(String.fromCodePoint(cp)),
    );
    expect(nonWhiteSpace).toHaveLength(60);
  });

  it.each(CC)("hasVisibleCharacter is false for U+%s", (value) => {
    expect(hasVisibleCharacter(value)).toBe(false);
  });

  it.each(CC)("formatDate renders '—' for %s", (value) => {
    expect(formatDate(value)).toBe("—");
  });

  it.each(CC)("shortenHash renders '—' for %s", (value) => {
    expect(shortenHash(value)).toBe("—");
  });

  it.each(CC)("shortenSha renders '—' for %s", (value) => {
    expect(shortenSha(value)).toBe("—");
  });

  it.each(CC)("formatEth renders '—' for %s", (value) => {
    expect(formatEth(value)).toBe("—");
  });

  it("still passes through / formats strings that have a visible character next to a control character", () => {
    expect(formatDate("x\u0001")).toBe("x\u0001");
    expect(shortenSha("0xabc\u007F")).toBe("0xabc\u007F");
    expect(shortenHash("0x1234\u0085")).toBe("0x1234\u0085");
  });
});

describe("Default_Ignorable_Code_Point renders '—' (J2 R7 open item)", () => {
  // Full-class battery: every \p{Default_Ignorable_Code_Point} code
  // point (4,174 under Node 24's ICU) must be blank. Full-class
  // canvas-width enumeration in real Chromium 156 headless found
  // ZERO width for all of them except the 8 already stripped by the
  // R5/R6 list (Hangul fillers U+115F/U+1160/U+3164/U+FFA0 +
  // shorthand U+1BCA0–U+1BCA3), so the class strip is measured, not
  // speculative. The formatter battery runs on an 18-char sample of
  // the newly-covered remainder (3,771 code points: U+17B4–U+17B5,
  // U+2065, U+FFF0–U+FFF8, U+E0000, U+E0002–U+E001F, U+E0080–U+E00FF,
  // U+E01F0–U+E0FFF); the hasVisibleCharacter battery covers all.
  const dicpCodePoints = (): number[] => {
    const out: number[] = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      if (/\p{Default_Ignorable_Code_Point}/u.test(String.fromCodePoint(cp))) out.push(cp);
    }
    return out;
  };
  const DICP = dicpCodePoints();
  const SAMPLE = [
    "\u2065", "\u17B4", "\u17B5",
    ...["\uFFF0", "\uFFF1", "\uFFF2", "\uFFF3", "\uFFF4", "\uFFF5", "\uFFF6", "\uFFF7", "\uFFF8"],
    "\u{E0000}", "\u{E0002}", "\u{E0080}", "\u{E00FF}", "\u{E01F0}", "\u{E0FFF}",
  ];

  it("covers exactly the 4,174 Default_Ignorable_Code_Point code points (Node 24 ICU)", () => {
    expect(DICP).toHaveLength(4174);
    expect(new Set(DICP).size).toBe(4174);
  });

  it.each(DICP.map((cp) => String.fromCodePoint(cp)))(
    "hasVisibleCharacter is false for U+%s",
    (value) => {
      expect(hasVisibleCharacter(value)).toBe(false);
    },
  );

  it.each(SAMPLE)("formatDate renders '—' for %s", (value) => {
    expect(formatDate(value)).toBe("—");
  });

  it.each(SAMPLE)("shortenHash renders '—' for %s", (value) => {
    expect(shortenHash(value)).toBe("—");
  });

  it.each(SAMPLE)("shortenSha renders '—' for %s", (value) => {
    expect(shortenSha(value)).toBe("—");
  });

  it.each(SAMPLE)("formatEth renders '—' for %s", (value) => {
    expect(formatEth(value)).toBe("—");
  });
});
