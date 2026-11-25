// RED-mutant guard: templates G and H must refuse a missing or malformed
// pinned_block. Removing the pin requirement from either template turns
// these tests red.
import { describe, expect, it } from "vitest";
import { researchTemplate } from "../src/researchTemplates";

describe("template selector pinning", () => {
  it("G rejects a missing, undefined or malformed pinned finalized block", () => {
    for (const bad of [undefined, "", "0", "abc", "-3", "1.5"]) {
      expect(() => researchTemplate("G", new Date().toISOString(), bad as string | undefined)).toThrow(/pinned finalized block/);
    }
  });
  it("H rejects a missing, undefined or malformed pinned Bitcoin tip height", () => {
    for (const bad of [undefined, "", "0", "abc", "-3", "1.5", "100000001"]) {
      expect(() => researchTemplate("H", new Date().toISOString(), bad as string | undefined)).toThrow(/pinned Bitcoin tip/);
    }
  });
  it("G and H accept a well-formed pin", () => {
    expect(() => researchTemplate("G", new Date().toISOString(), "23900000")).not.toThrow();
    expect(() => researchTemplate("H", new Date().toISOString(), "977460")).not.toThrow();
  });
});
