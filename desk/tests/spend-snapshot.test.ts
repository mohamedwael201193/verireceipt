import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { committedExposureUusdc, reserveSpend, spendLedgerFromFiles } from "../src/gate";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-cap-"));
  dirs.push(dir);
  const now = new Date();
  const reservationsFile = join(dir, "reservations.jsonl");
  const ledgerFile = join(dir, "gate.jsonl");
  const purchasesFile = join(dir, "purchases.jsonl");
  writeFileSync(reservationsFile, JSON.stringify({ kind: "gate", nonce: "settling", amount_uusdc: "1995000", reserved_at: now.toISOString() }) + "\n");
  const spend = spendLedgerFromFiles({ reservationsFile, lockFile: join(dir, "lock"), runLedgerFiles: [ledgerFile], purchasesFile }, () => now);
  const settle = () => appendFileSync(ledgerFile, JSON.stringify({ evaluated_at: now.toISOString(), purchase: { nonce: "settling", paid_uusdc: "1995000", worst_case_uusdc: null } }) + "\n");
  return { now, spend, settle, reservationsFile, ledgerFile, purchasesFile };
}

describe("consistent settlement snapshots", () => {
  it("refuses 10,000 when 1,995,000 settles immediately after the snapshot", () => {
    const f = fixture();
    const original = f.spend.readSettlementSnapshot;
    let interleave = true;
    f.spend.readSettlementSnapshot = () => {
      const snapshot = original();
      if (interleave) { interleave = false; f.settle(); }
      return snapshot;
    };
    // The stale snapshot still includes the old reservation, never drops it.
    expect(() => reserveSpend(f.spend, "gate", 10_000n, "new", 2_000_000n, f.now)).toThrow(/daily cap/);
    expect(committedExposureUusdc(f.spend, f.now)).toBe(1_995_000n);
    expect(readFileSync(f.reservationsFile, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("counts a settlement already in the snapshot once and permits exactly the remainder", () => {
    const f = fixture();
    f.settle();
    expect(committedExposureUusdc(f.spend, f.now)).toBe(1_995_000n);
    reserveSpend(f.spend, "desk", 5_000n, "remainder", 2_000_000n, f.now);
    expect(committedExposureUusdc(f.spend, f.now)).toBe(2_000_000n);
    expect(() => reserveSpend(f.spend, "gate", 1n, "overflow", 2_000_000n, f.now)).toThrow(/daily cap/);
  });
  it("does not consult separately mutable sum and nonce callbacks", () => {
    const f = fixture();
    f.spend.settledTodayUusdc = () => { throw new Error("separate sum read"); };
    f.spend.settledNonces = () => { throw new Error("separate nonce read"); };
    expect(() => reserveSpend(f.spend, "gate", 10_000n, "new", 2_000_000n, f.now)).toThrow(/daily cap/);
  });
  it("does not retire a reservation for a row with no counted amount", () => {
    const f = fixture();
    appendFileSync(f.ledgerFile, JSON.stringify({ evaluated_at: f.now.toISOString(), purchase: { nonce: "settling", paid_uusdc: null, worst_case_uusdc: null } }) + "\n");
    expect(committedExposureUusdc(f.spend, f.now)).toBe(1_995_000n);
  });
  it("fails closed on a partially appended settlement", () => {
    const f = fixture();
    writeFileSync(f.ledgerFile, "{unfinished");
    expect(() => reserveSpend(f.spend, "gate", 1n, "new", 2_000_000n, f.now)).toThrow();
    expect(readFileSync(f.reservationsFile, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("derives purchase amount and nonce from the same purchase row", () => {
    const f = fixture();
    writeFileSync(f.purchasesFile, JSON.stringify({ bought_at: f.now.toISOString(), nonce: "settling", telegraph_receipt: { amount_uusdc: "1995000" } }) + "\n");
    const snapshot = f.spend.readSettlementSnapshot();
    expect(snapshot.settledTodayUusdc).toBe(1_995_000n);
    expect(snapshot.settledNonces.has("settling")).toBe(true);
    expect(committedExposureUusdc(f.spend, f.now)).toBe(1_995_000n);
  });
});
