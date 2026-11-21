import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { DIAMOND } from "../src/constants";
import { readLedger, spentOnUtcDay } from "../src/ledger";
import { caisoHour, catalogAgrees, nyisoInterval, planTasks, valueFieldPinned } from "../src/missions";

describe("mission plan", () => {
  const now = new Date("2026-11-21T13:24:07.123Z");
  it("asks for finished intervals only", () => {
    expect(caisoHour(now)).toBe("2026-11-21T11:00:00Z");
    expect(nyisoInterval(now)).toBe("2026-11-21T12:50:00Z");
  });
  it("plans the M12 gates (CAISO NP15, NYISO Zone J) and the M13 TVL check with schema params", () => {
    const t = planTasks(now);
    expect(t.map((x) => x.id)).toEqual([
      "m12-caiso-np15", "m12-nyiso-zone-j", "m13-tvl-aave-v3",
      "m13-tx-desk-deposit", "m13-filings-aapl-10q-2025", "m13-route-eth-usdc", "m13-validator-1",
    ]);
    expect(Object.keys(t[0].params).sort()).toEqual(["interval_start", "node_or_zone"]);
    expect(Object.keys(t[2].params)).toEqual(["protocol"]);
    expect(t[3].params).toEqual({ tx_hash: "0xe8696cc29652173b1fdce601cfbd5d61649583bf811163d778d412739b78d2d3", chain: "sepolia" });
    expect(t[4].params).toEqual({ entity: "Form 10-Q filings by Apple Inc. (CIK 320193)", period: "calendar 2025" });
    expect(t[5].params).toEqual({ pair: "ETH/USDC" });
    expect(t[6].params).toEqual({ validator_index: "1" });
  });
  it("a static task's params must equal the catalog pin exactly", () => {
    const base = { task_id: "m13-route-eth-usdc", mission: "M13", title: "Mission 13 · 1 ETH to USDC execution quote (Ethereum mainnet)", intent: "OPTIMAL_EXECUTION_ROUTE_GENERAL", value_field: "amount_out" };
    expect(catalogAgrees({ ...base, params: { pair: "ETH/USDC" } })).toBe(true);
    expect(catalogAgrees({ ...base, params: { pair: "BTC/USDC" } })).toBe(false);
    expect(catalogAgrees({ ...base, params: { pair: "ETH/USDC", amount: "2" } })).toBe(false);
    expect(catalogAgrees({ ...base, params: {} })).toBe(false);
  });
});

// The committed ledger is real purchase evidence; these checks keep it honest.
describe("desk/ledger/purchases.jsonl", () => {
  const recs = readLedger(join(__dirname, "..", "ledger", "purchases.jsonl"));
  it("holds at least one escrow-settled purchase", () => {
    expect(recs.length).toBeGreaterThan(0);
  });
  it("every record is an escrow purchase on the Telegraph epoch rail, at the quoted flat price", () => {
    for (const r of recs) {
      expect(r.telegraph_receipt.rail).toBe("escrow");
      expect(r.telegraph_receipt.chain).toBe("telegraph");
      expect(r.telegraph_receipt.settlement).toBe("epoch");
      expect(r.telegraph_receipt.amount_uusdc).toBe(r.quoted_uusdc);
      expect(r.quoted_uusdc).toBe("10000");
      expect(r.telegraph_receipt.receipt_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.signal_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(Number(r.valid_before) - Number(r.valid_after)).toBeLessThanOrEqual(120);
      expect(r.payer).toBe(r.payer.toLowerCase());
      expect(JSON.stringify(r)).not.toMatch(/signature|private/i);
    }
  });
  it("VERIFIED iff every check passed and the recomputed sha equals the receipt's", () => {
    for (const r of recs) {
      const allOk = r.checks.length > 0 && r.checks.every((c) => c.ok);
      expect(r.verdict).toBe(allOk && r.raw_sha256_recomputed === r.miner_receipt?.raw_response_sha256 ? "VERIFIED" : "UNVERIFIED");
    }
  });
  it("receipt hashes, signal hashes, nonces, and miner receipt ids are unique", () => {
    expect(new Set(recs.map((r) => r.telegraph_receipt.receipt_hash)).size).toBe(recs.length);
    expect(new Set(recs.map((r) => r.signal_hash)).size).toBe(recs.length);
    expect(new Set(recs.map((r) => r.nonce)).size).toBe(recs.length);
    expect(new Set(recs.map((r) => r.miner_receipt?.receipt_id)).size).toBe(recs.length);
  });
  it("every row matches the pinned task catalog and official value_field", () => {
    for (const r of recs) {
      expect(catalogAgrees(r)).toBe(true);
      expect(valueFieldPinned(r.intent, r.value_field)).toBe(true);
    }
  });
  it("sums the UTC day's spend", () => {
    const day = recs[0].bought_at;
    expect(spentOnUtcDay(recs, new Date(day))).toBe(
      recs.filter((r) => r.bought_at.slice(0, 10) === day.slice(0, 10)).reduce((s, r) => s + BigInt(r.telegraph_receipt.amount_uusdc), 0n),
    );
    expect(DIAMOND).toBe("0x72a70e949362670bf8bcead24efc5b8f950aa08b");
  });
});
