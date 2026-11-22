// Controlled envelope fixtures, not live-source or evaluator measurements.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError, errorBody } from "../src/core/errors";
import { envelope, makeReceipt } from "../src/core/receipt";

const yaml = readFileSync(resolve(process.cwd(), "miner.yaml"), "utf8");
const mappingBlock = yaml.match(/^  signal_mapping:\n((?:^    .*\n)+)/m)?.[1] ?? "";
const mapping = Object.fromEntries([...mappingBlock.matchAll(/^    (\w+): (\w+)$/gm)]
  .map((m) => [m[1], m[2]]));
function project(response: Record<string, unknown>) {
  return {
    label: response[mapping.label_field],
    reason: response[mapping.reason_field],
    confidence: response[mapping.confidence_field],
  };
}
const cases: Array<{ intent: string; fields: Record<string, unknown>; answer: string }> = [
  { intent: "ONCHAIN_TX_LOOKUP_GENERAL", fields: { block_number: 123456, status: "confirmed", value_eth: 0.12345 }, answer: "The transaction is confirmed in block 123456 with value 0.12345 ETH." },
  { intent: "REGULATORY_FILING_MONITOR_GENERAL", fields: { entity: "Example Corp", filing_count: 0, filings: [], urls: [] }, answer: "Example Corp has 0 matching filings in the requested period." },
  { intent: "TVL_LOOKUP_GENERAL", fields: { protocol_or_chain: "example", tvl_usd: 12345.67, chain_tvl_usd: 12345.67, as_of: "2026-11-21T00:00:00Z" }, answer: "Example TVL is 12345.67 USD as of 2026-11-21T00:00:00Z." },
  { intent: "OPTIMAL_EXECUTION_ROUTE_GENERAL", fields: { amount_out: 3000123456 }, answer: "Selling 1 ETH returns 3000.123456 USDC, or 3000123456 USDC base units." },
  { intent: "GRID_POWER_PRICE_GENERAL", fields: { node_or_zone: "ZONE_A", market: "NYISO", lmp_usd_per_mwh: -1.23, interval_start: "2026-11-21T00:00:00Z", currency: "USD" }, answer: "NYISO ZONE_A wholesale price is -1.23 USD/MWh for 2026-11-21T00:00:00Z." },
  { intent: "VALIDATOR_PERFORMANCE_VERIFY_GENERAL", fields: { validator_index: 1, effective_balance: 32000000000, status: "active_ongoing", finalized_state_root: "0x" + "a".repeat(64) }, answer: "Validator 1 has effective balance 32000000000 gwei at a finalized state, with status active_ongoing and 3/4 sources agreed." },
];

describe("factual answer signal mapping", () => {
  it("uses the existing complete answer, not a verification-only label", () => {
    expect(mapping).toEqual({ confidence_field: "confidence", label_field: "answer", reason_field: "source" });
  });
  for (const { intent, fields, answer } of cases) {
    it(`${intent}: keeps the answer, typed fields, verification and receipt distinct`, () => {
      const receipt = makeReceipt(intent, "https://example.invalid/unit-test", JSON.stringify(fields), "controlled fixture");
      const before = structuredClone({ fields, receipt });
      const response = envelope(intent, fields, receipt, { answer, verdict: "verified", confidence: 1, source: "Controlled fixture source" });
      expect(project(response)).toEqual({ label: answer, reason: "Controlled fixture source", confidence: 1 });
      expect(response.verdict).toBe("verified");
      for (const [key, value] of Object.entries(fields)) expect(response[key]).toEqual(value);
      expect(response.receipt).toBe(receipt);
      expect({ fields, receipt }).toEqual(before);
    });
  }
  it("keeps answer first on the wire even when a typed field is large", () => {
    const receipt = makeReceipt("REGULATORY_FILING_MONITOR_GENERAL", "https://example.invalid/unit-test", "[]", "controlled fixture");
    const response = envelope("REGULATORY_FILING_MONITOR_GENERAL", { filings: ["x".repeat(10000)], filing_count: 1 }, receipt,
      { answer: "There is 1 matching filing.", verdict: "verified", confidence: 1, source: "Controlled fixture source" });
    expect(Object.keys(response)[0]).toBe("answer");
    expect(JSON.stringify(response).startsWith('{"answer":"There is 1 matching filing."')).toBe(true);
  });
  it.each([0, 32000000000, 2048000000000])("preserves effective_balance=%s exactly in gwei", (effective_balance) => {
    const receipt = makeReceipt("VALIDATOR_PERFORMANCE_VERIFY_GENERAL", "https://example.invalid/unit-test", String(effective_balance), "controlled fixture");
    const answer = `Validator 1 effective balance is ${effective_balance} gwei.`;
    const response = envelope("VALIDATOR_PERFORMANCE_VERIFY_GENERAL", { validator_index: 1, effective_balance }, receipt,
      { answer, verdict: "verified", confidence: 1, source: "Controlled fixture source" });
    expect(project(response).label).toBe(answer);
    expect(response.effective_balance).toBe(effective_balance);
    expect(typeof response.effective_balance).toBe("number");
  });
  it.each([400, 422, 502, 504])("does not manufacture a successful label for HTTP %s refusals", (status) => {
    const response = errorBody(new ApiError(status, "SOURCE_UNAVAILABLE", "No verified answer is available."));
    expect(project(response).label).toBeUndefined();
    expect(response).not.toHaveProperty("receipt");
    expect(response).not.toHaveProperty("effective_balance");
  });
  it("keeps answer protected against a typed-field collision", () => {
    const receipt = makeReceipt("VALIDATOR_PERFORMANCE_VERIFY_GENERAL", "https://example.invalid/unit-test", "{}", "controlled fixture");
    expect(() => envelope("VALIDATOR_PERFORMANCE_VERIFY_GENERAL", { answer: "untrusted field" }, receipt,
      { answer: "Verified numeric answer", verdict: "verified", confidence: 1, source: "Controlled fixture source" })).toThrow(/reserved key: answer/);
  });
});
