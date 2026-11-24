import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FIELD_FORMAT, OUTPUT_MAPPING, formatFor, isNumericField, reconcileShaped, valueMatchesFormat } from "../src/core/shapedFields";

// Historical official format projections, not evaluation questions or replies.
const contracts = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/intent14-response-formats.json"), "utf8")).intents as Record<string, { response: { fields: Array<{ name: string; type: string }> } }>;

describe("fourteen-intent consumer format mirror", () => {
  it("pins every added mapped field to its captured official format type", () => {
    expect(Object.keys(contracts)).toHaveLength(8);
    // All 57 declared intents have consumer output and format mirrors.
    // This historical contract fixture checks its original 8 additions; the
    // complete mapping/type loop also runs in shaped-fields.test.ts.
    expect(Object.keys(OUTPUT_MAPPING)).toHaveLength(57);
    expect(Object.keys(FIELD_FORMAT).sort()).toEqual(Object.keys(OUTPUT_MAPPING).sort());
    for (const [intent, contract] of Object.entries(contracts)) {
      const source = Object.fromEntries(contract.response.fields.map((f) => [f.name, f]));
      expect(Object.keys(FIELD_FORMAT[intent]).sort()).toEqual(Object.keys(OUTPUT_MAPPING[intent]).sort());
      for (const name of Object.keys(OUTPUT_MAPPING[intent])) {
        expect(source[name], `${intent}.${name}`).toBeDefined();
        expect(formatFor(intent, name)?.type, `${intent}.${name}`).toBe(source[name].type);
      }
    }
  });

  for (const [intent, field] of [
    ["DNS_RECORD_LOOKUP_GENERAL", "has_record"],
    ["SSL_VERIFICATION_CERT", "certificate_valid"],
    ["EMAIL_SECURITY_GENERAL", "lookup_ok"],
  ]) {
    for (const value of [false, true]) {
      it(`preserves semantic ${value} for verified raw ${intent}`, () => {
        const result = reconcileShaped({ intent, result: {}, field_status: { [field]: "unavailable" } }, { [field]: value }, { rawVerified: true });
        expect(result[field]).toEqual({ value, source: "raw", node_status: "unavailable" });
        expect(isNumericField(intent, field)).toBe(false);
      });
    }
    for (const value of ["true", "false", "0", "NOERROR", 0, 1, null, {}, []]) {
      it(`does not coerce ${JSON.stringify(value)} into raw boolean ${intent}`, () => {
        expect(valueMatchesFormat(value, formatFor(intent, field))).toBe(false);
        const result = reconcileShaped({ intent, result: {}, field_status: { [field]: "unavailable" } }, { [field]: value }, { rawVerified: true });
        expect(result[field]).toEqual({ value: null, source: "none", node_status: "unavailable" });
      });
    }
    it(`requires verified raw and preserves missing/rejected for ${intent}`, () => {
      const raw = { [field]: true };
      const unavailable = { intent, result: {}, field_status: { [field]: "unavailable" as const } };
      expect(reconcileShaped(unavailable, raw, { rawVerified: false })[field].source).toBe("none");
      for (const status of ["missing", "rejected"] as const) {
        expect(reconcileShaped({ intent, result: {}, field_status: { [field]: status } }, raw, { rawVerified: true })[field]).toEqual({ value: null, source: "none", node_status: status });
      }
    });
  }
});
