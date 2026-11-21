import { describe, expect, it } from "vitest";
import { inspectResearchReport } from "./researchReport";
const report = () => ({ version: "research-run-v1", plan: { version: "research-packet-v1", cik: "320193", year: 2025, form: "10-Q", minimum_count: 3, network: "eip155:11155111" },
  plan_hash: "a".repeat(64), result: { status: "SUPPORTED", reason: "fixture only", observed_count: 3, checks: [{ name: "source bytes", ok: true }] },
  verification_checks: [{ name: "signal identity", ok: true }], delivery: { status: "pending" } });
describe("local research report inspector, structural checks only", () => {
  it("keeps reported checks and pending separate from authentication", () => {
    const r = inspectResearchReport(JSON.stringify(report()));
    expect(r.status).toBe("SUPPORTED"); expect(r.checks).toHaveLength(2); expect(r.delivery).toBe("pending");
  });
  it("preserves reported failures even when a file claims success", () => {
    const x = report(); x.result.checks[0].ok = false;
    expect(inspectResearchReport(JSON.stringify(x)).checks.some(x => !x.ok)).toBe(true);
  });
  it.each([null, [], {}, { ...report(), version: "different" }, { ...report(), delivery: { status: "settled" } },
    { ...report(), plan_hash: "short" }, { ...report(), verification_checks: null },
    { ...report(), result: { ...report().result, status: "GUARANTEED" } },
    { ...report(), result: { ...report().result, observed_count: -1 } },
    { ...report(), result: { ...report().result, checks: [{ name: "x", ok: "true" }] } },
  ])("rejects malformed or unsupported reports", input => { expect(() => inspectResearchReport(JSON.stringify(input))).toThrow(); });
  it("bounds file size and check count", () => {
    expect(() => inspectResearchReport(" ".repeat(2_000_001))).toThrow();
    const x = report(); x.result.checks = Array.from({ length: 501 }, () => ({ name: "x", ok: true }));
    expect(() => inspectResearchReport(JSON.stringify(x))).toThrow();
  });
});
