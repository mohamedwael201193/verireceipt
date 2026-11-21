import { beforeEach, describe, expect, it, vi } from "vitest";
import { readLedger } from "../src/ledger";
import { join } from "node:path";
import { DEMO_POLICY, classifyDemo, reportPurchase } from "../src/policy";
import * as verify from "../src/verify";
vi.mock("../src/verify", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/verify")>();
  return { ...actual, verifyPurchase: vi.fn(), storedLedgerAgrees: vi.fn(), checkDelivery: vi.fn(), checkEpochConsistency: vi.fn(), deliveryIsOk: vi.fn(), merkleProofShapeOk: vi.fn() };
});
const row = readLedger(join(__dirname, "..", "ledger", "purchases.jsonl"))[0];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verify.verifyPurchase).mockResolvedValue({ verified: true, checks: [], payloadValue: 53.65098 } as unknown as verify.VerifyOutput);
  vi.mocked(verify.storedLedgerAgrees).mockReturnValue({ ok: true, failures: [] });
  vi.mocked(verify.checkEpochConsistency).mockResolvedValue({ ok: true, failures: [] });
  vi.mocked(verify.checkDelivery).mockResolvedValue({ status: "included", epochId: row.telegraph_receipt.epoch_id, detail: "test fixture" });
  vi.mocked(verify.deliveryIsOk).mockReturnValue(true);
  vi.mocked(verify.merkleProofShapeOk).mockReturnValue(true);
});

describe("demo boundaries, not current recommendations", () => {
  it("pins labeled post-purchase demo thresholds", () => {
    expect(DEMO_POLICY.version).toBe("demo-paid-policy-v1");
    expect(DEMO_POLICY.label).toContain("after purchase");
    expect(Object.isFrozen(DEMO_POLICY)).toBe(true);
  });
  it.each([[-10, "RUN"], [0, "RUN"], [100, "RUN"], [100.01, "CURTAIL"]])("grid %s => %s", (n, want) => {
    expect(classifyDemo("m12-caiso-np15", n, true).outcome).toBe(want);
    expect(classifyDemo("m12-nyiso-zone-j", n, true).outcome).toBe(want);
  });
  it.each([[9_999_999_999, "HOLD"], [10_000_000_000, "PASS"], [10_000_000_001, "PASS"], [-1, "HOLD"]])("TVL %s => %s", (n, want) => {
    expect(classifyDemo("m13-tvl-aave-v3", n, true).outcome).toBe(want);
  });
  it.each([NaN, Infinity, -Infinity, null, "53", undefined, {}])("refuses invalid number %s", value => {
    expect(classifyDemo("m12-caiso-np15", value, true).outcome).toBe("HOLD");
  });
  it("does not turn other tasks into successful mission outcomes", () => {
    expect(classifyDemo("m13-route-eth-usdc", 1, true).outcome).toBe("NOT_APPLICABLE");
  });
  it("holds valid numbers when evidence fails", () => {
    expect(classifyDemo("m12-caiso-np15", 50, false).outcome).toBe("HOLD");
    expect(classifyDemo("m13-tvl-aave-v3", 20e9, false).outcome).toBe("HOLD");
  });
});

describe("read-only paid-evidence report", () => {
  it("uses live verified value, preserves original row, binds receipt and signal", async () => {
    const before = JSON.stringify(row);
    const r = await reportPurchase(row);
    expect(r.outcome).toBe("RUN");
    expect(r.measured_value).toBe(53.65098);
    expect(r.receipt_hash).toBe(row.telegraph_receipt.receipt_hash);
    expect(r.signal_hash).toBe(row.signal_hash);
    expect(r.basis).toContain("not current");
    expect(JSON.stringify(row)).toBe(before);
  });
  it.each(["verify", "ledger", "epoch", "delivery", "shape", "pending", "wrong epoch", "network"])("fails closed on %s", async kind => {
    if (kind === "verify") vi.mocked(verify.verifyPurchase).mockResolvedValue({ verified: false, checks: [{ name: "raw", ok: false, detail: "mismatch" }], payloadValue: 50 } as unknown as verify.VerifyOutput);
    if (kind === "ledger") vi.mocked(verify.storedLedgerAgrees).mockReturnValue({ ok: false, failures: ["params"] });
    if (kind === "epoch") vi.mocked(verify.checkEpochConsistency).mockResolvedValue({ ok: false, failures: ["window"] });
    if (kind === "delivery") vi.mocked(verify.deliveryIsOk).mockReturnValue(false);
    if (kind === "shape") vi.mocked(verify.merkleProofShapeOk).mockReturnValue(false);
    if (kind === "pending") vi.mocked(verify.checkDelivery).mockResolvedValue({ status: "pending", detail: "pending" });
    if (kind === "wrong epoch") vi.mocked(verify.checkDelivery).mockResolvedValue({ status: "included", epochId: 999, detail: "fixture" });
    if (kind === "network") vi.mocked(verify.verifyPurchase).mockRejectedValue(new Error("network"));
    const r = await reportPurchase(row);
    expect(r.evidence_ok).toBe(false);
    expect(r.outcome).toBe("HOLD");
    expect(r.measured_value).toBeNull();
    expect(r.failures.length).toBeGreaterThan(0);
  });
});
