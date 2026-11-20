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
