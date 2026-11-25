import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalPayloadJson, checkDelivery, deliveryIsOk, deliveryProofToStore, FLAT_ESCROW_UUSDC,
  parseEngineRequest, receiptPendingShape, sha256Hex, signalHashOf, storedDeliveryAgrees, storedLedgerAgrees,
  uniquePurchaseIds, verifyPurchase, type DeliveryProof, type LedgerIdentity, type VerifyOutput,
} from "../src/verify";
import type { FieldStatus } from "../../src/core/shapedFields";
import { readLedger } from "../src/ledger";


const fx = (n: string) => join(__dirname, "fixtures", n);
const signal = JSON.parse(readFileSync(fx("signal-m12-caiso.json"), "utf8"));
const raw = readFileSync(fx("raw-rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR.bin"));
const meta = readFileSync(fx("meta-rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR.json"), "utf8");
const paid = JSON.parse(readFileSync(fx("paid-m12-caiso.json"), "utf8"));
const PAYER = "0xf76e6b0920e9332ff4410f6dd53f01722abc71a3";

function stubFetch(over: { signal?: unknown; raw?: Uint8Array; meta?: string } = {}) {
  return (async (url: string) => {
    if (url.includes("/engine/v1/signal/")) return new Response(JSON.stringify(over.signal ?? signal), { status: 200 });
    if (url.endsWith("/raw")) return new Response(over.raw ?? raw, { status: 200 });
    if (url.includes("/receipts/")) return new Response(over.meta ?? meta, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const input = { payer: PAYER, minerSlug: "verireceipt", signalHash: paid.body.signal_hash, valueField: "lmp_usd_per_mwh", engineResult: paid.body.result, intent: "GRID_POWER_PRICE_GENERAL" };

describe("signal hash re-derivation", () => {
  it("keccak256 of the key-sorted, Go-escaped payload equals the live signal_hash", () => {
    expect(signalHashOf(signal.payload)).toBe(signal.signal_hash);
    expect(signal.signal_hash).toBe(paid.body.signal_hash);
  });
  it("sorts integer-like object keys lexically, including nested maps and maps inside arrays", () => {
    const payload = { response: { by_type: { "3": 1, "144": 2, "10-K": 3 }, nested: [{ "2": "b", "10": "a" }] } };
    expect(canonicalPayloadJson(payload)).toBe('{"response":{"by_type":{"10-K":3,"144":2,"3":1},"nested":[{"10":"a","2":"b"}]}}');
  });
  it("retains array order and produces the same canonical bytes regardless of insertion order", () => {
    const a = { "2": [3, 1, 2], "10": { "4": "<&>", "11": null } };
    const b = { "10": { "11": null, "4": "<&>" }, "2": [3, 1, 2] };
    expect(canonicalPayloadJson(a)).toBe('{"10":{"11":null,"4":"\\u003c\\u0026\\u003e"},"2":[3,1,2]}');
    expect(signalHashOf(a)).toBe(signalHashOf(b));
    expect(signalHashOf(a)).not.toBe(signalHashOf({ ...a, "2": [1, 2, 3] }));
  });
  it("escapes & < > like Go encoding/json", () => {
    expect(canonicalPayloadJson({ b: "x&y<z>", a: 1 })).toBe('{"a":1,"b":"x\\u0026y\\u003cz\\u003e"}');
  });
});

describe("verifyPurchase on a real escrow purchase", () => {
  it("passes every check with the live records", async () => {
    const v = await verifyPurchase(input, stubFetch());
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v.verified).toBe(true);
    expect(v.rawSha256).toBe(sha256Hex(raw));
    expect(v.minerReceipt?.receipt_id).toBe("rcpt_PDY2JQEJJ1F6K6HJKKMPSH5XYR");
  });
  it("fails when one stored byte changes", async () => {
    const t = Uint8Array.from(raw);
    t[0] ^= 1;
    const v = await verifyPurchase(input, stubFetch({ raw: t }));
    expect(v.verified).toBe(false);
    expect(v.checks.find((c) => c.name.startsWith("sha256"))?.ok).toBe(false);
  });
  it("fails when the signal payload was altered (hash no longer re-derives)", async () => {
    const s = structuredClone(signal);
    s.payload.response.lmp_usd_per_mwh = 1;
    const v = await verifyPurchase(input, stubFetch({ signal: s }));
    expect(v.checks.find((c) => c.name === "signal hash re-derived")?.ok).toBe(false);
    expect(v.verified).toBe(false);
  });
  it("fails when the engine value disagrees with the miner answer", async () => {
    const v = await verifyPurchase({ ...input, engineResult: { lmp_usd_per_mwh: 0 } }, stubFetch());
    expect(v.verified).toBe(false);
  });
  it("fails for another payer", async () => {
    const v = await verifyPurchase({ ...input, payer: "0x0000000000000000000000000000000000000001" }, stubFetch());
    expect(v.verified).toBe(false);
  });
  it("fails when the stored metadata disagrees", async () => {
    const v = await verifyPurchase(input, stubFetch({ meta: JSON.stringify({ raw_response_sha256: "0".repeat(64) }) }));
    expect(v.verified).toBe(false);
  });
  it("check details carry no provider slugs or names (publication sweep)", async () => {
    // Sentinel inputs: any interpolation of the caller's slug or host into a
    // check name/detail must show up here, even though verification fails.
    const sentinel = { ...input, minerSlug: "zz-sentinel-provider-x", minerBaseUrl: "https://zz-sentinel-host.invalid" };
    const joined = (v: VerifyOutput) => v.checks.map((c) => `${c.name}: ${c.detail ?? ""}`).join("\n");
    for (const v of [
      await verifyPurchase(sentinel, stubFetch()),
      // raw-bytes-mismatch early-return path
      await verifyPurchase(sentinel, stubFetch({ raw: Uint8Array.from(raw, (b, i) => (i === 0 ? b ^ 1 : b)) })),
    ]) {
      const details = joined(v);
      expect(details).not.toContain("zz-sentinel-provider-x");
      expect(details).not.toContain("zz-sentinel-host");
      expect(details).not.toMatch(/slug=|praman|datawire|a1-preflight|metricwire|miner_name/i);
    }
  });
});

describe("deliveryIsOk (J2 Minor 2)", () => {
  const receipt = { receipt_hash: "0x" + "ab".repeat(32), amount_uusdc: "10000" };
  const payer = PAYER;
  const included: DeliveryProof = {
    status: "included",
    detail: "ok",
    delivery: { payer, receipt_hash: receipt.receipt_hash, usdc: 10000, miner_id: "6152" },
  };
  it("pending is OK (epoch block not recorded yet)", () => {
    expect(deliveryIsOk({ status: "pending", detail: "no block recorded for this epoch" }, receipt, payer)).toBe(true);
  });
  it("error is not OK", () => {
    expect(deliveryIsOk({ status: "error", detail: "HTTP 502" }, receipt, payer)).toBe(false);
  });
  it("included is OK only when payer, receipt_hash, and usdc match", () => {
    expect(deliveryIsOk(included, receipt, payer)).toBe(true);
    expect(deliveryIsOk({ ...included, delivery: { ...included.delivery, payer: "0x0000000000000000000000000000000000000001" } }, receipt, payer)).toBe(false);
    expect(deliveryIsOk({ ...included, delivery: { ...included.delivery, usdc: 1 } }, receipt, payer)).toBe(false);
    expect(deliveryIsOk({ ...included, delivery: { ...included.delivery, receipt_hash: "0x" + "cd".repeat(32) } }, receipt, payer)).toBe(false);
  });
  it("the delivery's miner_id must be one of our registration ids and equal the receipt's miner", () => {
    expect(deliveryIsOk(included, { ...receipt, miner: "6152" }, payer)).toBe(true);
    expect(deliveryIsOk({ ...included, delivery: { ...included.delivery, miner_id: "6159" } }, receipt, payer)).toBe(false);
    expect(deliveryIsOk(included, { ...receipt, miner: "6159" }, payer)).toBe(false);
  });
});

describe("checkDelivery status mapping", () => {
  it("404 is pending, 5xx is error, 200 with a delivery row is included", async () => {
    const pending = await checkDelivery(31, "0x" + "ab".repeat(32), (async () => new Response(JSON.stringify({ error: "no block recorded for this epoch" }), { status: 404 })) as unknown as typeof fetch);
    expect(pending.status).toBe("pending");
    const other404 = await checkDelivery(31, "0x" + "ab".repeat(32), (async () => new Response(JSON.stringify({ error: "delivery not found" }), { status: 404 })) as unknown as typeof fetch);
    expect(other404.status).toBe("error");
    const err = await checkDelivery(31, "0x" + "ab".repeat(32), (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch);
    expect(err.status).toBe("error");
    expect(deliveryIsOk(err, { receipt_hash: "0x" + "ab".repeat(32), amount_uusdc: "10000" }, PAYER)).toBe(false);
    const rec = { payer: PAYER, receipt_hash: "0x" + "ab".repeat(32), usdc: 10000, miner_id: "6152" };
    const inc = await checkDelivery(30, rec.receipt_hash, (async () => new Response(JSON.stringify({ delivery: rec, deliveries_root: "0x" + "11".repeat(32) }), { status: 200 })) as unknown as typeof fetch);
    expect(inc.status).toBe("included");
    expect(deliveryIsOk(inc, { receipt_hash: rec.receipt_hash, amount_uusdc: "10000" }, PAYER)).toBe(true);
  });
});

describe("parseEngineRequest", () => {
  it("parses the official [intent] line and ignores key order", () => {
    const p = parseEngineRequest('[intent] GRID_POWER_PRICE_GENERAL → {"interval_start":"2026-11-21T11:00:00Z","node_or_zone":"TH_NP15_GEN-APND"}');
    expect(p).toEqual({ intentId: "GRID_POWER_PRICE_GENERAL", params: { interval_start: "2026-11-21T11:00:00Z", node_or_zone: "TH_NP15_GEN-APND" } });
    expect(parseEngineRequest("[intent] X -> {\"a\":\"1\"}")).toEqual({ intentId: "X", params: { a: "1" } });
    expect(parseEngineRequest("not a request")).toBeNull();
  });
});

describe("signal intent is pinned to the purchased intent (J2 M2)", () => {
  it("fails when a self-consistent payload carries a different intent_id", async () => {
    const s = structuredClone(signal);
    s.payload.intent_id = "TVL_LOOKUP_GENERAL";
    s.signal_hash = signalHashOf(s.payload);
    const v = await verifyPurchase(input, stubFetch({ signal: s }));
    expect(v.verified).toBe(false);
    expect(v.intentId).toBe("TVL_LOOKUP_GENERAL");
    expect(v.checks.find((c) => c.name === "signal intent")?.ok).toBe(false);
  });
  it("passes when payload.intent_id and the request line match the purchased intent", async () => {
    const v = await verifyPurchase(input, stubFetch());
    expect(v.checks.find((c) => c.name === "signal intent")?.ok).toBe(true);
    expect(v.intentId).toBe("GRID_POWER_PRICE_GENERAL");
    expect(v.requestParams).toEqual({ interval_start: "2026-11-21T11:00:00Z", node_or_zone: "TH_NP15_GEN-APND" });
    expect(v.verified).toBe(true);
  });
});

describe("deliveryIsOk / deliveryProofToStore (J1 Minor 1, J2 Minor 4)", () => {
  const receipt = { receipt_hash: "0x" + "ab".repeat(32), amount_uusdc: "10000" };
  it("an included row with no receipt_hash is not OK (no fallback to the ledger hash)", () => {
    const d: DeliveryProof = { status: "included", detail: "ok", delivery: { payer: PAYER, usdc: 10000 } };
    expect(deliveryIsOk(d, receipt, PAYER)).toBe(false);
    expect(deliveryProofToStore(d, false, "2026-11-21T00:00:00Z")).toEqual({ status: "error", checked_at: "2026-11-21T00:00:00Z" });
  });
  it("--write stores included only when the delivery row matches payer, amount and receipt_hash", () => {
    const ok: DeliveryProof = { status: "included", detail: "ok", deliveriesRoot: "0x" + "11".repeat(32), delivery: { payer: PAYER, receipt_hash: receipt.receipt_hash, usdc: 10000, miner_id: "6152" } };
    expect(deliveryIsOk(ok, receipt, PAYER)).toBe(true);
    expect(deliveryProofToStore(ok, true, "2026-11-21T00:00:00Z")).toEqual({ status: "included", checked_at: "2026-11-21T00:00:00Z", deliveries_root: "0x" + "11".repeat(32), receipt_hash: receipt.receipt_hash, payer: PAYER, usdc: 10000, miner_id: "6152" });
    const mismatch: DeliveryProof = { ...ok, delivery: { ...ok.delivery, usdc: 1 } };
    expect(deliveryIsOk(mismatch, receipt, PAYER)).toBe(false);
    expect(deliveryProofToStore(mismatch, false, "2026-11-21T00:00:00Z")?.status).toBe("error");
    expect(deliveryProofToStore(mismatch, false, "2026-11-21T00:00:00Z")?.status).not.toBe("included");
  });
});

describe("J2 r3 tampers against storedLedgerAgrees (H1, M1)", () => {
  const recs = readLedger(join(__dirname, "..", "ledger", "purchases.jsonl"));
  const honest = recs[0];
  async function live(): Promise<VerifyOutput> {
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
  function row(over: Record<string, unknown> = {}): LedgerIdentity {
    const r = { ...honest, ...over, telegraph_receipt: { ...honest.telegraph_receipt, ...((over.telegraph_receipt as object) ?? {}) }, miner_receipt: over.miner_receipt === undefined ? honest.miner_receipt : over.miner_receipt, checks: (over.checks as LedgerIdentity["checks"]) ?? honest.checks, params: (over.params as LedgerIdentity["params"]) ?? honest.params } as LedgerIdentity;
    return r;
  }

  it("the honest committed row agrees with a live re-derivation", async () => {
    const v = await live();
    expect(v.verified).toBe(true);
    expect(storedLedgerAgrees(honest, v).ok).toBe(true);
    expect(receiptPendingShape(honest).ok).toBe(true);
  });
  it("T2: forged raw sha on the receipt and the recomputed field fails", async () => {
    const v = await live();
    const t = row({ miner_receipt: { ...honest.miner_receipt!, raw_response_sha256: "0".repeat(64) }, raw_sha256_recomputed: "0".repeat(64) });
    const a = storedLedgerAgrees(t, v);
    expect(a.ok).toBe(false);
    expect(a.failures).toEqual(expect.arrayContaining(["raw_response_sha256", "raw_sha256_recomputed"]));
  });
  it("T12: a forged miner receipt_id fails", async () => {
    const v = await live();
    const t = row({ miner_receipt: { ...honest.miner_receipt!, receipt_id: "rcpt_AAAAAAAAAAAAAAAAAAAAAAAAAA" } });
    expect(storedLedgerAgrees(t, v).failures).toContain("receipt_id");
  });
  it("T14: a forged intent and params fail", async () => {
    const v = await live();
    const t = row({ intent: "TVL_LOOKUP_GENERAL", params: { protocol: "aave-v3" }, title: "forged" });
    const a = storedLedgerAgrees(t, v);
    expect(a.failures).toEqual(expect.arrayContaining(["intent_id", "params"]));
  });
  it("T1: VERIFIED with a failed stored check fails (verdict-vs-stored-checks)", async () => {
    const v = await live();
    const checks = honest.checks.map((c, i) => (i === 0 ? { ...c, ok: false } : c));
    const t = row({ checks });
    expect(storedLedgerAgrees(t, v).failures).toEqual(expect.arrayContaining(["verdict-vs-stored-checks", "checks"]));
  });
  it("T3: a drifted raw_sha256_recomputed fails", async () => {
    const v = await live();
    const t = row({ raw_sha256_recomputed: "0".repeat(64) });
    expect(storedLedgerAgrees(t, v).failures).toContain("raw_sha256_recomputed");
  });
  it("T9: amount_uusdc 1 and a fake receipt_hash fail while pending (M1)", async () => {
    const v = await live();
    const t = row({ telegraph_receipt: { ...honest.telegraph_receipt, amount_uusdc: "1", receipt_hash: "0xdead" } });
    const a = storedLedgerAgrees(t, v);
    expect(a.failures).toEqual(expect.arrayContaining(["amount_uusdc != " + FLAT_ESCROW_UUSDC, "quoted_uusdc != amount_uusdc", "receipt_hash shape"]));
    expect(receiptPendingShape(t).ok).toBe(false);
  });
  it("T13: epoch_id must be a non-negative safe integer (shape); 99999 is still a valid shape", () => {
    expect(receiptPendingShape(row({ telegraph_receipt: { ...honest.telegraph_receipt, epoch_id: 99999 } })).ok).toBe(true);
    expect(receiptPendingShape(row({ telegraph_receipt: { ...honest.telegraph_receipt, epoch_id: -1 } })).ok).toBe(false);
    expect(receiptPendingShape(row({ telegraph_receipt: { ...honest.telegraph_receipt, epoch_id: 1.5 } })).ok).toBe(false);
  });
  it("raw_bytes drift fails", async () => {
    const v = await live();
    expect(storedLedgerAgrees(row({ raw_bytes: 1 }), v).failures).toContain("raw_bytes");
  });
});
