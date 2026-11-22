import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLedger } from "../src/ledger";
import {
  BOUGHT_AT_SLACK_MS, checkEpochConsistency, checksAgree, deliveryIsOk, deliveryProofToStore,
  merkleProofShapeOk, parseEngineRequest, signalHashOf, storedDeliveryAgrees, storedLedgerAgrees,
  uniquePurchaseIds, verifyPurchase, type DeliveryProof, type StoredDeliveryProof,
} from "../src/verify";
import type { FieldStatus } from "../../src/core/shapedFields";
import { TASK_CATALOG, VALUE_FIELD_BY_INTENT } from "../src/missions";
import { VERIRECEIPT_ONCHAIN_MINER_ID, VERIRECEIPT_ONCHAIN_MINER_IDS } from "../src/constants";

const fx = (n: string) => join(__dirname, "fixtures", n);
const signal = JSON.parse(readFileSync(fx("signal-m12-caiso.json"), "utf8"));
const raw = readFileSync(fx("raw-rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR.bin"));
const meta = readFileSync(fx("meta-rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR.json"), "utf8");
const recs = readLedger(join(__dirname, "..", "ledger", "purchases.jsonl"));
const honest = recs[0];
const PAYER = honest.payer;
const ROOT = "0x" + "11".repeat(32);
const PROOF = Array.from({ length: 9 }, (_, i) => "0x" + (i + 1).toString(16).padStart(2, "0").repeat(32));

function stubFetch(over: { signal?: unknown; raw?: Uint8Array; meta?: string } = {}) {
  return (async (url: string) => {
    if (url.includes("/engine/v1/signal/")) return new Response(JSON.stringify(over.signal ?? signal), { status: 200 });
    if (url.endsWith("/raw")) return new Response(over.raw ?? raw, { status: 200 });
    if (url.includes("/receipts/")) return new Response(over.meta ?? meta, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function includedDelivery(over: Record<string, unknown> = {}): DeliveryProof {
  return {
    status: "included",
    detail: "ok",
    deliveriesRoot: ROOT,
    epochId: 31,
    proof: PROOF,
    delivery: {
      receipt_hash: honest.telegraph_receipt.receipt_hash,
      payer: PAYER,
      miner_id: honest.telegraph_receipt.miner, // the registration that served this committed purchase (6152)
      intent: honest.intent,
      usdc: 10000,
      ...over,
    },
  };
}

function epochFetch(recorded: Record<number, { from: string; to: string; deliveries?: Record<string, unknown> }>) {
  return (async (url: string) => {
    const del = /\/v1\/blocks\/(\d+)\/deliveries\/([^/?]+)$/.exec(url);
    const blk = /\/v1\/blocks\/(\d+)$/.exec(url);
    const pending = () => new Response(JSON.stringify({ error: "no block recorded for this epoch" }), { status: 404 });
    const notIn = () => new Response(JSON.stringify({ error: "receipt not in this block" }), { status: 404 });
    if (del) {
      const e = Number(del[1]);
      const h = del[2];
      if (!(e in recorded)) return pending();
      const row = recorded[e].deliveries?.[h];
      if (row) {
        return new Response(JSON.stringify({ delivery: row, deliveries_root: ROOT, epoch_id: e, proof: PROOF }), { status: 200 });
      }
      return notIn();
    }
    if (blk) {
      const e = Number(blk[1]);
      if (!(e in recorded)) return pending();
      const w = recorded[e];
      return new Response(JSON.stringify({
        epoch_id: e,
        deliveries_root: ROOT,
        body: { epoch_id: e, window_from: w.from, window_to: w.to },
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

// Recorded epochs form a prefix (as on the official node). 0-29 are stubs
// so binary search for latest recorded can find 31 in tests.
const EPOCH31: Record<number, { from: string; to: string; deliveries?: Record<string, unknown> }> = {
  30: { from: "2026-11-21T07:37:35Z", to: "2026-11-21T10:54:36Z" },
  31: { from: "2026-11-21T10:54:36Z", to: "2026-11-21T15:44:52Z" },
};
for (let e = 0; e < 30; e++) {
  EPOCH31[e] = { from: "2026-11-20T00:00:00Z", to: "2026-11-21T07:37:35Z" };
}

describe("J2 r3 / J1 r3 tampers (desk-d r4)", () => {
  async function live() {
    return verifyPurchase({
      payer: honest.payer,
      minerSlug: "verireceipt",
      signalHash: honest.signal_hash,
      valueField: honest.value_field,
      engineResult: { ...(honest.engine.result ?? {}), [honest.value_field]: honest.value },
      intent: honest.intent,
      fieldStatus: honest.engine.field_status as Record<string, FieldStatus>,
    }, stubFetch());
  }

  it("H1: a forged stored deliveries_root fails storedDeliveryAgrees", () => {
    const liveD = includedDelivery();
    const stored: StoredDeliveryProof = {
      status: "included",
      checked_at: "2026-11-21T00:00:00Z",
      deliveries_root: "0x" + "22".repeat(32),
      epoch_id: 31,
      receipt_hash: honest.telegraph_receipt.receipt_hash,
      payer: PAYER,
      usdc: 10000,
      intent: honest.intent,
      miner_id: honest.telegraph_receipt.miner, // the registration that served this committed purchase (6152)
    };
    const a = storedDeliveryAgrees(stored, liveD, honest);
    expect(a.ok).toBe(false);
    expect(a.failures).toContain("deliveries_root");
  });

  it("H1: stored included vs live pending fails", () => {
    const stored: StoredDeliveryProof = { status: "included", checked_at: "2026-11-21T00:00:00Z", deliveries_root: ROOT };
    const a = storedDeliveryAgrees(stored, { status: "pending", detail: "no block recorded for this epoch" }, honest);
    expect(a.ok).toBe(false);
    expect(a.failures).toContain("delivery_proof included but live pending");
  });

  it("H1: stored pending while live included is stale (run --write), not a pass", () => {
    const a = storedDeliveryAgrees({ status: "pending", checked_at: "2026-11-21T00:00:00Z" }, includedDelivery(), honest);
    expect(a.ok).toBe(false);
    expect(a.stale).toBe(true);
    expect(a.failures).toContain("delivery_proof stale (run --write)");
  });

  it("H1: a bogus stored status fails", () => {
    const a = storedDeliveryAgrees({ status: "bogus", checked_at: "2026-11-21T00:00:00Z" }, includedDelivery(), honest);
    expect(a.ok).toBe(false);
    expect(a.failures).toContain("delivery_proof status");
  });

  it("H1: honest stored included proof agrees with the live row", () => {
    const liveD = includedDelivery();
    const stored = deliveryProofToStore(liveD, true, "2026-11-21T00:00:00Z");
    expect(storedDeliveryAgrees(stored, liveD, honest).ok).toBe(true);
    expect(deliveryIsOk(liveD, honest.telegraph_receipt, honest.payer, honest.intent)).toBe(true);
  });

  it("H2: duplicate receipt_hash, signal_hash, nonce, or receipt_id fails uniquePurchaseIds", () => {
    expect(uniquePurchaseIds(recs).ok).toBe(true);
    const a = recs[0];
    const b = recs[1];
    expect(uniquePurchaseIds([a, { ...b, telegraph_receipt: { ...b.telegraph_receipt, receipt_hash: a.telegraph_receipt.receipt_hash } }]).failures.join(" ")).toMatch(/duplicate receipt_hash/);
    expect(uniquePurchaseIds([a, { ...b, signal_hash: a.signal_hash }]).failures.join(" ")).toMatch(/duplicate signal_hash/);
    expect(uniquePurchaseIds([a, { ...b, nonce: a.nonce }]).failures.join(" ")).toMatch(/duplicate nonce/);
    expect(uniquePurchaseIds([a, { ...b, miner_receipt: { ...b.miner_receipt!, receipt_id: a.miner_receipt!.receipt_id } }]).failures.join(" ")).toMatch(/duplicate miner_receipt.receipt_id/);
  });

  it("M1: a forged title or mission fails the catalog check", async () => {
    const v = await live();
    expect(storedLedgerAgrees({ ...honest, title: "Forged title" }, v).failures).toContain("catalog");
    expect(storedLedgerAgrees({ ...honest, mission: "M99" }, v).failures).toContain("catalog");
    expect(storedLedgerAgrees({ ...honest, task_id: "m12-nyiso-zone-j" }, v).failures).toContain("catalog");
  });

  it("M1: a bought_at far from the receipt or signal timestamp fails", async () => {
    const v = await live();
    expect(v.signalTimestamp).toBeTruthy();
    const a = storedLedgerAgrees({ ...honest, bought_at: "2020-01-01T00:00:00.000Z" }, v);
    expect(a.failures).toEqual(expect.arrayContaining(["bought_at vs receipt timestamp", "bought_at vs signal timestamp"]));
    expect(BOUGHT_AT_SLACK_MS).toBe(15_000);
  });

  it("M2: value_field must be the official scored field for the intent", async () => {
    const v = await live();
    expect(VALUE_FIELD_BY_INTENT[honest.intent]).toBe("lmp_usd_per_mwh");
    expect(storedLedgerAgrees({ ...honest, value_field: "chain_tvl_usd" }, v).failures).toContain("value_field");
    expect(storedLedgerAgrees({ ...honest, value_field: "node_or_zone" }, v).failures).toContain("value_field");
  });

  it("M3: delivery.intent or miner_id mismatch fails deliveryIsOk", () => {
    const rec = honest.telegraph_receipt;
    expect(deliveryIsOk(includedDelivery({ intent: "TVL_LOOKUP_GENERAL" }), rec, PAYER, honest.intent)).toBe(false);
    expect(deliveryIsOk(includedDelivery({ miner_id: "0000" }), rec, PAYER, honest.intent)).toBe(false);
    expect(deliveryIsOk(includedDelivery(), rec, PAYER, honest.intent)).toBe(true);
  });

  it("M3 / J1: epoch 99999 cannot stay pending when the receipt time falls in recorded epoch 31", async () => {
    const t = honest.telegraph_receipt.timestamp * 1000;
    const pending99999 = await checkEpochConsistency({ claimedEpoch: 99999, receiptTimeMs: t }, epochFetch(EPOCH31));
    expect(pending99999.ok).toBe(false);
    expect(pending99999.failures.join(" ")).toMatch(/recorded epoch 31/);
    const ok31 = await checkEpochConsistency({ claimedEpoch: 31, receiptTimeMs: t }, epochFetch(EPOCH31));
    expect(ok31.ok).toBe(true);
    // after the last recorded window, pending is allowed only at latest+1
    const after = Date.parse("2026-11-21T16:00:00Z");
    const ok32 = await checkEpochConsistency({ claimedEpoch: 32, receiptTimeMs: after }, epochFetch(EPOCH31));
    expect(ok32.ok).toBe(true);
    const bad99 = await checkEpochConsistency({ claimedEpoch: 99999, receiptTimeMs: after }, epochFetch(EPOCH31));
    expect(bad99.ok).toBe(false);
    expect(bad99.failures.join(" ")).toMatch(/pending epoch_id must be 32/);
  });

  it("J1 r5: a failed predecessor block-window lookup fails closed, never falls through to success", async () => {
    const t = honest.telegraph_receipt.timestamp * 1000;
    const base = epochFetch(EPOCH31);
    const failing = (async (url: string) => {
      if (/\/v1\/blocks\/31$/.test(url)) return new Response("node exploded", { status: 500 });
      return base(url);
    }) as unknown as typeof fetch;
    // claimed 32 pending; the walk must read epoch 31's window and fails closed.
    const r = await checkEpochConsistency({ claimedEpoch: 32, receiptTimeMs: Date.parse("2026-11-21T16:00:00Z") }, failing);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/epoch block 31 lookup failed/);
    // and the recorded-claim path fails closed the same way
    const r2 = await checkEpochConsistency({ claimedEpoch: 31, receiptTimeMs: t }, failing);
    expect(r2.ok).toBe(false);
  });

  it("J1 r5: a probe error during the recorded-epoch search fails closed", async () => {
    const base = epochFetch(EPOCH31);
    const failing = (async (url: string) => {
      if (/\/v1\/blocks\/15\/deliveries\//.test(url)) return new Response("node exploded", { status: 500 });
      return base(url);
    }) as unknown as typeof fetch;
    const r = await checkEpochConsistency({ claimedEpoch: 32, receiptTimeMs: Date.parse("2026-11-21T16:00:00Z") }, failing);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/probe failed/);
  });

  it("J1 r5: a receipt time in no recorded window (a gap before the latest window) fails closed", async () => {
    const GAP: Record<number, { from: string; to: string }> = {
      30: { from: "2026-11-20T00:00:00Z", to: "2026-11-21T07:37:35Z" },
      31: { from: "2026-11-21T10:54:36Z", to: "2026-11-21T15:44:52Z" },
    };
    for (let e = 0; e < 30; e++) GAP[e] = { from: "2026-11-19T00:00:00Z", to: "2026-11-20T00:00:00Z" };
    // 09:00 is after epoch 30's window and before epoch 31's window: no recorded window contains it.
    const r = await checkEpochConsistency({ claimedEpoch: 32, receiptTimeMs: Date.parse("2026-11-21T09:00:00Z") }, epochFetch(GAP));
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/matches no recorded window/);
  });

  it("J1: a forged check detail or title fails checksAgree / storedLedgerAgrees", async () => {
    const v = await live();
    const forgedDetail = honest.checks.map((c, i) => (i === 0 ? { ...c, detail: "forged detail" } : c));
    const forgedTitle = honest.checks.map((c, i) => (i === 0 ? { ...c, name: "forged title" } : c));
    expect(checksAgree(honest.checks, v.checks)).toBe(true);
    expect(checksAgree(forgedDetail, v.checks)).toBe(false);
    expect(checksAgree(forgedTitle, v.checks)).toBe(false);
    expect(storedLedgerAgrees({ ...honest, checks: forgedDetail }, v).failures).toContain("checks");
    expect(storedLedgerAgrees({ ...honest, checks: forgedTitle }, v).failures).toEqual(expect.arrayContaining(["checks"]));
  });

  it("J1 Fields H1 lock: a forged r.value fails even when engineResult uses the honest payload value", async () => {
    const v = await live();
    expect(storedLedgerAgrees(honest, v).ok).toBe(true);
    expect(storedLedgerAgrees({ ...honest, value: 1 }, v).failures).toContain("value");
  });

  it("Minor: an unparsable payload.request fails the signal intent check", async () => {
    const s = structuredClone(signal);
    s.payload.request = "not a request line";
    s.signal_hash = signalHashOf(s.payload);
    const v = await verifyPurchase({
      payer: honest.payer,
      minerSlug: "verireceipt",
      signalHash: s.signal_hash,
      valueField: honest.value_field,
      engineResult: { [honest.value_field]: s.payload.response[honest.value_field] },
      intent: honest.intent,
    }, stubFetch({ signal: s }));
    expect(v.checks.find((c) => c.name === "signal intent")?.ok).toBe(false);
    expect(v.verified).toBe(false);
    expect(parseEngineRequest("not a request line")).toBeNull();
  });

  it("J1: included deliveries must carry a well-formed Merkle proof shape (no invented walker)", () => {
    expect(merkleProofShapeOk(includedDelivery())).toBe(true);
    expect(merkleProofShapeOk({ ...includedDelivery(), proof: [] })).toBe(false);
    expect(merkleProofShapeOk({ ...includedDelivery(), proof: ["0xdead"] })).toBe(false);
    expect(merkleProofShapeOk({ ...includedDelivery(), deliveriesRoot: "0xdead" })).toBe(false);
  });

  it("the pinned catalog matches the committed ledger rows", () => {
    for (const r of recs) {
      const c = TASK_CATALOG[r.task_id];
      expect(c).toBeTruthy();
      expect(c.title).toBe(r.title);
      expect(c.mission).toBe(r.mission);
      expect(c.intent).toBe(r.intent);
      expect(c.valueField).toBe(r.value_field);
    }
  });
});

describe("pin-6160: registration ids after updateMiner(6152) -> 6160", () => {
  it("accepts the current id and keeps 6152 for committed purchases, nothing else", () => {
    expect(VERIRECEIPT_ONCHAIN_MINER_ID).toBe("6160");
    expect([...VERIRECEIPT_ONCHAIN_MINER_IDS].sort()).toEqual(["6152", "6160"]);
    expect(honest.telegraph_receipt.miner).toBe("6152");
  });
  it("a delivery row naming a different registration than the receipt fails", () => {
    expect(deliveryIsOk(includedDelivery({ miner_id: "6160" }), honest.telegraph_receipt, honest.payer, honest.intent)).toBe(false);
  });
  it("an unknown registration id fails", () => {
    expect(deliveryIsOk(includedDelivery({ miner_id: "6153" }), { ...honest.telegraph_receipt, miner: undefined }, honest.payer, honest.intent)).toBe(false);
  });
});
