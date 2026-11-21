import { describe, expect, it, vi } from "vitest";
import { assertPurchases, auditLinks, deliveryStatus, DESK_PURCHASES, epochChargeSubtext, EXPECTED_VERIFY_CHECKS, formatRecoveredValue, isEndToEndVerified, loadPurchases, purchaseVerdict, recoveredFromRaw, rehashStoredRaw, summarize, uusdcToUsd, type DeskPurchase } from "./deskPurchases";
import { sha256Hex } from "./receipt";

describe("desk purchases (committed ledger)", () => {
  it("loads the committed escrow purchases", () => {
    expect(DESK_PURCHASES.length).toBeGreaterThan(0);
    for (const p of DESK_PURCHASES) {
      expect(p.telegraph_receipt.rail).toBe("escrow");
      expect(p.telegraph_receipt.amount_uusdc).toBe("10000");
    }
  });
  it("summarizes from the rows only", () => {
    const s = summarize(DESK_PURCHASES);
    expect(s.total).toBe(DESK_PURCHASES.length);
    expect(s.spentUusdc).toBe(DESK_PURCHASES.length * 10000);
    expect(summarize([])).toEqual({ total: 0, verified: 0, spentUusdc: 0, epochs: [], epochsSubtext: "no epochs recorded" });
  });
  it("refuses a malformed export", () => {
    expect(() => assertPurchases({})).toThrow();
    expect(() => assertPurchases([{ ...DESK_PURCHASES[0], verdict: "MAYBE" }])).toThrow();
    expect(() => assertPurchases([{ ...DESK_PURCHASES[0], signal_hash: "0x12" }])).toThrow();
  });
  it("formats μUSDC as dollars", () => {
    expect(uusdcToUsd(10000)).toBe("$0.01");
    expect(uusdcToUsd(30000)).toBe("$0.03");
  });
  it("builds the public audit links", () => {
    const p = DESK_PURCHASES[0];
    const l = auditLinks(p);
    expect(l.signal).toBe(`https://devnode.telegraphprotocol.com/engine/v1/signal/${p.signal_hash}`);
    expect(l.delivery).toBe(`https://devnode.telegraphprotocol.com/v1/blocks/${p.telegraph_receipt.epoch_id}/deliveries/${p.telegraph_receipt.receipt_hash}`);
    expect(l.rawPath).toBe(`/api/receipts/${p.miner_receipt!.receipt_id}/raw`);
  });
});

describe("rehashStoredRaw", () => {
  const bytes = new TextEncoder().encode('{"a":1}');
  it("MATCH when the stored bytes hash to the receipt", async () => {
    const sha = await sha256Hex(bytes);
    const p = { ...DESK_PURCHASES[0], miner_receipt: { receipt_id: "rcpt_X", raw_response_sha256: sha } };
    const f = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
    expect(await rehashStoredRaw(p, f)).toEqual({ state: "match", sha, bytes: bytes.byteLength });
  });
  it("MISMATCH when one byte differs", async () => {
    const p = { ...DESK_PURCHASES[0], miner_receipt: { receipt_id: "rcpt_X", raw_response_sha256: "0".repeat(64) } };
    const f = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
    expect((await rehashStoredRaw(p, f)).state).toBe("mismatch");
  });
  it("error (never a match) on HTTP failure", async () => {
    const f = vi.fn(async () => new Response("x", { status: 404 })) as unknown as typeof fetch;
    expect(await rehashStoredRaw(DESK_PURCHASES[0], f)).toEqual({ state: "error", message: "HTTP 404" });
  });
});


function row(over: Partial<DeskPurchase> = {}): DeskPurchase {
  return {
    ...DESK_PURCHASES[0],
    ...over,
    telegraph_receipt: { ...DESK_PURCHASES[0].telegraph_receipt, ...(over.telegraph_receipt ?? {}) },
    miner_receipt: over.miner_receipt === undefined ? DESK_PURCHASES[0].miner_receipt : over.miner_receipt,
    checks: over.checks ?? DESK_PURCHASES[0].checks,
    delivery_proof: over.delivery_proof === undefined ? DESK_PURCHASES[0].delivery_proof : over.delivery_proof,
  };
}

describe("isEndToEndVerified / assertPurchases (J2 Minor 3)", () => {
  it("the committed ledger rows are end-to-end verified", () => {
    for (const p of DESK_PURCHASES) {
      expect(isEndToEndVerified(p)).toBe(true);
      expect(purchaseVerdict(p)).toBe("VERIFIED");
    }
    expect(summarize(DESK_PURCHASES).verified).toBe(DESK_PURCHASES.length);
  });
  it("refuses a VERIFIED export whose checks failed", () => {
    const bad = row({ checks: [{ name: "signal hash re-derived", ok: false, detail: "no" }] });
    expect(() => assertPurchases([bad])).toThrow(/VERIFIED without the full expected check set or a matching sha/);
    expect(isEndToEndVerified(bad)).toBe(false);
    expect(purchaseVerdict(bad)).toBe("UNVERIFIED");
    expect(summarize([bad]).verified).toBe(0);
  });
  it("refuses a VERIFIED export whose recomputed sha drifted from the receipt", () => {
    const bad = row({ raw_sha256_recomputed: "0".repeat(64) });
    expect(() => assertPurchases([bad])).toThrow(/VERIFIED without the full expected check set or a matching sha/);
    expect(isEndToEndVerified(bad)).toBe(false);
    expect(summarize([bad]).verified).toBe(0);
  });
  it("does not treat an empty checks array as a pass", () => {
    const bad = row({ checks: [] });
    expect(isEndToEndVerified(bad)).toBe(false);
    expect(() => assertPurchases([bad])).toThrow(/VERIFIED without the full expected check set or a matching sha/);
  });
  it("still accepts an honest UNVERIFIED row with failed checks", () => {
    const u = row({ verdict: "UNVERIFIED", checks: [{ name: "x", ok: false, detail: "no" }] });
    expect(assertPurchases([u])).toEqual([u]);
    expect(summarize([u]).verified).toBe(0);
  });
});

describe("epochChargeSubtext / deliveryStatus (J1 Medium, J2 Minor 1–2)", () => {
  it("committed rows are included in recorded epoch 31 and billed in those ledger roots", () => {
    for (const p of DESK_PURCHASES) {
      expect(deliveryStatus(p)).toBe("included");
      expect(p.delivery_proof?.status).toBe("included");
      expect(p.delivery_proof?.deliveries_root).toBe("0x8a2c6d8ca02026c9cf055c8a2c40f5d4bc87ecbdcb7f674f24fc786ebf4a5005");
      expect(p.telegraph_receipt.epoch_id).toBe(31);
    }
    expect(epochChargeSubtext(DESK_PURCHASES)).toBe("charged in these ledger roots");
    expect(summarize(DESK_PURCHASES).epochsSubtext).toBe("charged in these ledger roots");
  });
  it("says charged in these ledger roots only when every delivery is included", () => {
    const included = row({ delivery_proof: { status: "included", checked_at: "2026-11-21T00:00:00Z", deliveries_root: "0x" + "ab".repeat(32) } });
    expect(deliveryStatus(included)).toBe("included");
    expect(epochChargeSubtext([included])).toBe("charged in these ledger roots");
  });
  it("does not say charged when one epoch is still pending", () => {
    const included = row({ delivery_proof: { status: "included", checked_at: "2026-11-21T00:00:00Z" } });
    const pending = row({ telegraph_receipt: { ...DESK_PURCHASES[0].telegraph_receipt, epoch_id: 32 }, delivery_proof: null });
    expect(epochChargeSubtext([included, pending])).toBe("some billed in a recorded ledger root; others pending epoch submission");
    expect(epochChargeSubtext([included, pending])).not.toBe("charged in these ledger roots");
  });
  it("distinguishes a delivery error from pending", () => {
    const err = row({ delivery_proof: { status: "error", checked_at: "2026-11-21T00:00:00Z" } });
    expect(deliveryStatus(err)).toBe("error");
    expect(epochChargeSubtext([err])).toBe("delivery error; not charged in a recorded ledger root");
    expect(epochChargeSubtext([err])).not.toMatch(/pending/);
  });
});

describe("J2 r3 tampers (desk-d panel/load)", () => {
  it("refuses a VERIFIED row that has only one arbitrary passing check (J2 Minor 2)", () => {
    const bad = row({ checks: [{ name: "x", ok: true, detail: "no" }] });
    expect(isEndToEndVerified(bad)).toBe(false);
    expect(() => assertPurchases([bad])).toThrow(/full expected check set/);
    expect(summarize([bad]).verified).toBe(0);
  });
  it("requires every expected check name, not just a non-empty all-ok array", () => {
    expect(EXPECTED_VERIFY_CHECKS).toHaveLength(8);
    const missing = row({ checks: EXPECTED_VERIFY_CHECKS.slice(1).map((name) => ({ name, ok: true, detail: "x" })) });
    expect(isEndToEndVerified(missing)).toBe(false);
    expect(() => assertPurchases([missing])).toThrow(/full expected check set/);
  });
  it("shows an unknown delivery status as unknown, not pending (J2 Minor 1)", () => {
    const bogus = row({ delivery_proof: { status: "bogus", checked_at: "2026-11-21T00:00:00Z" } });
    expect(deliveryStatus(bogus)).toBe("unknown");
    expect(epochChargeSubtext([bogus])).toBe("delivery status unknown; not charged in a recorded ledger root");
    expect(epochChargeSubtext([bogus])).not.toMatch(/pending/);
    expect(epochChargeSubtext([bogus])).not.toBe("charged in these ledger roots");
  });
  it("loadPurchases fails soft so a bad export cannot throw at module load (J2 Minor 5)", () => {
    const bad = row({ checks: [{ name: "x", ok: true, detail: "no" }] });
    const loaded = loadPurchases([bad]);
    expect(loaded.rows).toEqual([]);
    expect(loaded.error).toMatch(/full expected check set/);
    expect(() => loadPurchases({ no: "array" })).not.toThrow();
    expect(loadPurchases({ no: "array" }).error).toMatch(/not an array/);
    expect(loadPurchases(DESK_PURCHASES).error).toBeNull();
    expect(loadPurchases(DESK_PURCHASES).rows).toHaveLength(DESK_PURCHASES.length);
  });
});


describe("J1 / J2 r4 frontend guards", () => {
  it("an extra failing check prevents VERIFIED even when all expected names pass", () => {
    const checks = [...EXPECTED_VERIFY_CHECKS.map((name) => ({ name, ok: true, detail: "x" })), { name: "forged extra", ok: false, detail: "no" }];
    const bad = row({ checks });
    expect(isEndToEndVerified(bad)).toBe(false);
    expect(purchaseVerdict(bad)).toBe("UNVERIFIED");
    expect(() => assertPurchases([bad])).toThrow(/full expected check set/);
    expect(summarize([bad]).verified).toBe(0);
  });
  it("mixed included + unknown delivery status says unknown, not pending", () => {
    const included = row({ delivery_proof: { status: "included", checked_at: "2026-11-21T00:00:00Z", deliveries_root: "0x" + "ab".repeat(32) } });
    const bogus = row({ delivery_proof: { status: "bogus", checked_at: "2026-11-21T00:00:00Z" } });
    expect(epochChargeSubtext([included, bogus])).toBe("some billed in a recorded ledger root; at least one delivery status unknown");
    expect(epochChargeSubtext([included, bogus])).not.toMatch(/pending/);
    expect(epochChargeSubtext([included, bogus])).not.toBe("charged in these ledger roots");
  });
  it("assertPurchases refuses a forged title or value_field (catalog / pin)", () => {
    expect(() => assertPurchases([row({ title: "Forged title" })])).toThrow(/task catalog/);
    expect(() => assertPurchases([row({ value_field: "chain_tvl_usd" })])).toThrow(/task catalog|value_field/);
    expect(() => assertPurchases([row({ mission: "M99" })])).toThrow(/task catalog/);
  });
  it("assertPurchases refuses a bought_at far from the receipt timestamp", () => {
    expect(() => assertPurchases([row({ bought_at: "2020-01-01T00:00:00.000Z" })])).toThrow(/bought_at/);
  });
  it("assertPurchases refuses duplicate receipt_hash, signal_hash, nonce, or receipt_id", () => {
    const a = DESK_PURCHASES[0];
    const b = DESK_PURCHASES[1];
    expect(() => assertPurchases([a, { ...b, telegraph_receipt: { ...b.telegraph_receipt, receipt_hash: a.telegraph_receipt.receipt_hash } }])).toThrow(/duplicate receipt_hash/);
    expect(() => assertPurchases([a, { ...b, signal_hash: a.signal_hash }])).toThrow(/duplicate signal_hash/);
    expect(() => assertPurchases([a, { ...b, nonce: a.nonce }])).toThrow(/duplicate nonce/);
    expect(() => assertPurchases([a, { ...b, miner_receipt: { ...b.miner_receipt!, receipt_id: a.miner_receipt!.receipt_id } }])).toThrow(/duplicate miner_receipt.receipt_id/);
  });
});

describe("recovered fields on the committed ledger (J2 fields H1 / M1)", () => {
  it("every committed VERIFIED row carries raw-recovered values and does not treat them as node-ok", () => {
    for (const p of DESK_PURCHASES) {
      const recovered = recoveredFromRaw(p);
      expect(recovered.length).toBeGreaterThan(0);
      for (const f of recovered) {
        expect(p.recovered_fields![f.field].source).toBe("raw");
        expect(p.recovered_fields![f.field].node_status).toBe("unavailable");
        expect(typeof f.value === "string" || typeof f.value === "number").toBe(true);
      }
    }
    const caiso = DESK_PURCHASES.find((p) => p.task_id === "m12-caiso-np15")!;
    expect(recoveredFromRaw(caiso).map((f) => [f.field, f.value])).toEqual([
      ["node_or_zone", "TH_NP15_GEN-APND"],
      ["market", "CAISO"],
      ["interval_start", "2026-11-21T11:00:00.000Z"],
      ["currency", "USD"],
    ]);
    const tvl = DESK_PURCHASES.find((p) => p.task_id === "m13-tvl-aave-v3")!;
    expect(tvl.recovered_fields!.chain_tvl_usd).toEqual({ value: 12690034044.50001, node_status: "ok", source: "node" });
    expect(recoveredFromRaw(tvl).map((f) => [f.field, f.value])).toEqual([
      ["protocol_or_chain", "aave-v3"],
      ["as_of", "2026-11-21T13:26:51.492Z"],
    ]);
  });
  it("does not show recovered values on an UNVERIFIED row", () => {
    const u = row({ verdict: "UNVERIFIED", checks: [{ name: "x", ok: false, detail: "no" }] });
    expect(recoveredFromRaw(u)).toEqual([]);
  });
  it("does not treat a numeric field tagged source=raw as recovered", () => {
    const bad = row({
      recovered_fields: {
        ...(DESK_PURCHASES[0].recovered_fields ?? {}),
        tvl_usd: { value: 1, node_status: "unavailable", source: "raw" },
      },
    });
    expect(recoveredFromRaw(bad).some((f) => f.field === "tvl_usd")).toBe(false);
    expect(() => assertPurchases([bad])).toThrow(/numeric field was recovered from raw/);
  });
  it("assertPurchases rejects a recovered value that would crash String()", () => {
    const bad = row({
      recovered_fields: {
        market: { value: { toString: null }, node_status: "unavailable", source: "raw" },
      },
    });
    expect(() => assertPurchases([bad])).toThrow(/not a string, number, or null/);
    expect(formatRecoveredValue({ toString: null })).toBe('{"toString":null}');
  });
});
