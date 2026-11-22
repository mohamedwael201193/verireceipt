import { describe, expect, it } from "vitest";
import { plainDecimal } from "../src/core/plainDecimal";

describe("measured decimal rendering", () => {
  it.each([
    [0, "0"], [-0, "0"], [32000000000, "32000000000"],
    [15121752429.31, "15121752429.31"], [67.57882, "67.57882"],
    [-17.3456789, "-17.3456789"], [1e-9, "0.000000001"],
    [1e21, "1000000000000000000000"],
    [Number.MAX_SAFE_INTEGER, "9007199254740991"],
  ] as const)("renders %s without grouping, exponent or reduced precision", (value, expected) => {
    const text = plainDecimal(value);
    expect(text).toBe(expected);
    expect(text).not.toMatch(/[,eE]/);
    expect(Number(text)).toBe(value === 0 ? 0 : value);
  });
  it.each([Infinity, -Infinity, NaN])("refuses non-finite %s", (value) => {
    expect(() => plainDecimal(value)).toThrow(RangeError);
  });
});
