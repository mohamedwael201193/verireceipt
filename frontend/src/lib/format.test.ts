import { describe, expect, it } from "vitest";
import { formatDate, formatEth, formatUsd, formatUsdPrecise, shortenHash, shortenSha } from "./format";

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

describe("formatDate over-long invalid passthrough (J2 R5 m5)", () => {
  it("renders '—' for an over-long invalid string instead of passing 100k chars through", () => {
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
