// Desk verification tests — src/desk/verify.ts.
//
// All devnode traffic is stubbed: no test touches the network. Product
// data here is synthetic (fixed hashes / canned devnode bodies) — the
// hash-function vectors are the standard SHA-256 test vectors, which is
// the legitimate use of known vectors; live proof lives in the worker's
// report, not in these tests.
//
// The design under test (proven live 2026-11-20): signal_hash and
// receipt_hash are DIFFERENT hashes on DIFFERENT endpoints. A signal
// hash never resolves as a delivery, and a receipt hash never resolves
// as a signal — the tests pin both directions.
//
// CAVEAT (J1-F3): the live combined run paired a signal and a receipt
// from DIFFERENT asks — no single receipt has been proven end-to-end
// live by these tests. verifyReceipt takes a caller-paired
// signal_hash + receipt_hash (or the MCP ledger path, which pairs them
// from one ledger row); the end-to-end live proof lives in the
// worker's report, not in these tests.

import { describe, it, expect } from "vitest";
import {
  verifySignal,
  verifyDelivery,
  verifyReceipt,
  findLatestFinalizedEpoch,
  verifyRawBytes,
  isHash,
  isSignalVerified,
  signalUrl,
  deliveryUrl,
  blockUrl,
  type FetchFn,
} from "../src/desk/verify";

const SIGNAL =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const RECEIPT =
  "0x2222222222222222222222222222222222222222222222222222222222222222";
const FIXED_NOW = "2026-11-20T18:00:00.000Z";

function stubFetch(
  routes: Record<string, { status: number; body: unknown }>,
  calls: string[] = [],
): FetchFn {
  return async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    };
  };
}

function verifiedSignalBody(): Record<string, unknown> {
  return {
    verification: { algorithm: "keccak256", commitment: "payload", verified: true },
  };
}

function deliveryBody(): Record<string, unknown> {
  return {
    block_data_root: "0xabc",
    deliveries_root: "0xdef",
    delivery: { receipt_hash: RECEIPT, intent: "CRYPTO_PRICE_USD" },
    epoch_id: 24,
    proof: ["0xaaa", "0xbbb"],
  };
}

describe("isHash", () => {
  it("accepts 0x + 64 hex chars", () => {
    expect(isHash(SIGNAL)).toBe(true);
  });
  it("rejects short, non-hex, missing-0x and non-string values", () => {
    expect(isHash("0x1234")).toBe(false);
    expect(isHash("11".repeat(32))).toBe(false);
    expect(isHash(`0x${"g".repeat(64)}`)).toBe(false);
    expect(isHash(123)).toBe(false);
    expect(isHash(null)).toBe(false);
  });
});

describe("URL builders", () => {
  it("signal URL is the devnode engine path", () => {
    expect(signalUrl(SIGNAL)).toBe(
      `https://devnode.telegraphprotocol.com/engine/v1/signal/${SIGNAL}`,
    );
  });
  it("delivery URL carries epoch and receipt hash", () => {
    expect(deliveryUrl(24, RECEIPT)).toBe(
      `https://devnode.telegraphprotocol.com/v1/blocks/24/deliveries/${RECEIPT}`,
    );
  });
  it("block URL carries the epoch", () => {
    expect(blockUrl(24)).toBe("https://devnode.telegraphprotocol.com/v1/blocks/24");
  });
});

describe("isSignalVerified", () => {
  it("requires verification.verified === true (strict, not truthy)", () => {
    expect(isSignalVerified({ verification: { verified: true } })).toBe(true);
    expect(isSignalVerified({ verification: { verified: "true" } })).toBe(false);
    expect(isSignalVerified({ verification: { verified: false } })).toBe(false);
    expect(isSignalVerified({})).toBe(false);
    expect(isSignalVerified(null)).toBe(false);
  });

  it("a top-level verified:true is NOT enough (no fallback without an identifier)", () => {
    expect(isSignalVerified({ verified: true })).toBe(false);
    expect(isSignalVerified({ verified: true, verification: { verified: false } })).toBe(
      false,
    );
  });

  it("a body identifier that names a different hash fails closed", () => {
    expect(
      isSignalVerified(
        { verification: { verified: true }, signal_hash: RECEIPT },
        SIGNAL,
      ),
    ).toBe(false);
    expect(
      isSignalVerified(
        { verification: { verified: true }, signal_hash: SIGNAL },
        SIGNAL,
      ),
    ).toBe(true);
  });

  it("a NESTED identifier inside verification that names a different hash fails closed (round-2 FIX D / J2-F3)", () => {
    // The docstring promises the check for "an identifier field" the
    // body carries — a nested verification.signal_hash / verification.hash
    // is carried by the body too, so it must equal the requested hash.
    expect(
      isSignalVerified(
        {
          verification: { verified: true, signal_hash: RECEIPT },
          signal_hash: SIGNAL,
        },
        SIGNAL,
      ),
    ).toBe(false);
    expect(
      isSignalVerified(
        {
          verification: { verified: true, hash: RECEIPT },
          signal_hash: SIGNAL,
        },
        SIGNAL,
      ),
    ).toBe(false);
    expect(
      isSignalVerified(
        {
          verification: { verified: true, signal_hash: SIGNAL },
          signal_hash: SIGNAL,
        },
        SIGNAL,
      ),
    ).toBe(true);
  });

  it("a present-but-WRONG-TYPED identifier fails closed (round-3 S1: wrong-typed is a mismatch, not absent)", () => {
    // A number where a hash string belongs must not verify — the old
    // code only compared string identifiers, so signal_hash: 12345
    // (top-level or nested) verified with verified:true.
    expect(
      isSignalVerified(
        { verification: { verified: true }, signal_hash: 12345 },
        SIGNAL,
      ),
    ).toBe(false);
    expect(
      isSignalVerified(
        { verification: { verified: true }, hash: 12345 },
        SIGNAL,
      ),
    ).toBe(false);
    expect(
      isSignalVerified(
        { verification: { verified: true, signal_hash: 12345 } },
        SIGNAL,
      ),
    ).toBe(false);
    expect(
      isSignalVerified(
        { verification: { verified: true, hash: 12345 } },
        SIGNAL,
      ),
    ).toBe(false);
    // And a matching string identifier still verifies.
    expect(
      isSignalVerified(
        { verification: { verified: true, signal_hash: SIGNAL } },
        SIGNAL,
      ),
    ).toBe(true);
  });
});

describe("verifySignal (the answer check)", () => {
  it("verified:true → verified", async () => {
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: { status: 200, body: verifiedSignalBody() },
    });
    const check = await verifySignal(SIGNAL, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({
      verified: true,
      status: "verified",
      signal_hash: SIGNAL,
      checked_at: FIXED_NOW,
    });
  });

  it("signal 404 → not_found", async () => {
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: { status: 404, body: { error: "signal not found" } },
    });
    const check = await verifySignal(SIGNAL, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "not_found" });
    expect(check.detail).toContain("signal not found");
  });

  it("verified !== true → unverified", async () => {
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: {
        status: 200,
        body: { verification: { verified: false } },
      },
    });
    const check = await verifySignal(SIGNAL, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
  });

  it("signal 500 → error, fail closed", async () => {
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: { status: 500, body: { error: "boom" } },
    });
    const check = await verifySignal(SIGNAL, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "error" });
    expect(check.detail).toContain("500");
  });

  it("malformed hash → error and nothing is fetched", async () => {
    const calls: string[] = [];
    const fetchFn = stubFetch({}, calls);
    const check = await verifySignal("not-a-hash", { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "error" });
    expect(calls).toEqual([]);
  });

  it("network failure → error, never verified", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("fetch failed");
    };
    const check = await verifySignal(SIGNAL, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "error" });
    expect(check.detail).toContain("fetch failed");
  });

  it("never calls the deliveries endpoint with a signal hash", async () => {
    const calls: string[] = [];
    const fetchFn = stubFetch(
      { [signalUrl(SIGNAL)]: { status: 200, body: verifiedSignalBody() } },
      calls,
    );
    await verifySignal(SIGNAL, { fetchFn, now: () => FIXED_NOW });
    expect(calls).toEqual([signalUrl(SIGNAL)]);
  });

  it("a nested verification.signal_hash naming a different hash → unverified (round-2 FIX D / J2-F3)", async () => {
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: {
        status: 200,
        body: {
          verification: { verified: true, signal_hash: RECEIPT },
          signal_hash: SIGNAL,
        },
      },
    });
    const check = await verifySignal(SIGNAL, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
  });

  it("a fetch whose json() never resolves still cannot hang past the deadline (round-2 FIX E / J2-F5)", async () => {
    // The fetch resolves immediately but its json() never resolves.
    // fetchJson must race the body read against the same budget — the
    // 120s-deadline claim is false for this step without that race.
    // A 5s guard fails the test fast instead of hanging the suite if
    // the fix regresses.
    const fetchFn: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    });
    const check = await Promise.race([
      verifySignal(SIGNAL, {
        fetchFn,
        now: () => FIXED_NOW,
        deadline: Date.now() + 200,
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("verifySignal hung: res.json() was not bounded by the deadline")),
          5000,
        ),
      ),
    ]);
    expect(check).toMatchObject({ verified: false, status: "error" });
    expect(check.detail).toMatch(/timed out|deadline/);
  });
});

describe("verifyDelivery (the payment check, one epoch)", () => {
  it("200 with proof → verified with epoch and proof", async () => {
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 200, body: deliveryBody() },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({
      verified: true,
      status: "verified",
      receipt_hash: RECEIPT,
      epoch: 24,
      proof: ["0xaaa", "0xbbb"],
    });
  });

  it("200 with a different receipt_hash in the body → unverified, never verified on status alone", async () => {
    const body = deliveryBody();
    (body["delivery"] as Record<string, unknown>)["receipt_hash"] =
      "0x3333333333333333333333333333333333333333333333333333333333333333";
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
    expect(check.detail).toContain("not the requested");
  });

  it("200 with a different epoch_id → unverified", async () => {
    const body = deliveryBody();
    body["epoch_id"] = 23;
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
    expect(check.detail).toContain("epoch_id 23");
  });

  it("200 with a STRING epoch_id → unverified (round-2 FIX C / J2-F2: present-but-wrong-typed is a mismatch, not absent)", async () => {
    // P2: epoch_id "23" (string, wrong epoch), matching receipt_hash,
    // non-empty proof, requested epoch 24 — must NOT verify, and the
    // detail must not claim "epoch_id match the request".
    const body = deliveryBody();
    body["epoch_id"] = "23" as unknown as number;
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
    expect(check.detail).toContain("epoch_id");
    expect(check.detail).not.toContain("receipt_hash and epoch_id match the request");
  });

  it("200 with a string epoch_id naming the RIGHT epoch is still unverified (type matters, not just value)", async () => {
    const body = deliveryBody();
    body["epoch_id"] = "24" as unknown as number;
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
  });

  it("200 with a NUMERIC receipt_hash in delivery → unverified (round-2 FIX C / J2-F2)", async () => {
    // P3: delivery.receipt_hash 12345 (number, not the requested hash),
    // epoch_id 24, proof present — must NOT verify.
    const body = deliveryBody();
    (body["delivery"] as Record<string, unknown>)["receipt_hash"] = 12345;
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
    expect(check.detail).toContain("receipt_hash");
    expect(check.detail).not.toContain("receipt_hash and epoch_id match the request");
  });

  it("200 with a NUMERIC top-level receipt_hash → unverified (same type-leniency hole, top-level field)", async () => {
    const body = deliveryBody();
    delete (body["delivery"] as Record<string, unknown>)["receipt_hash"];
    (body as Record<string, unknown>)["receipt_hash"] = 12345;
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
  });

  it("200 whose TOP-LEVEL receipt_hash names a different hash → unverified even when the nested one matches (round-3 F2, direction A)", async () => {
    // The judge's reproduction: body {receipt_hash: 0xcccc…,
    // delivery: {receipt_hash: <requested>}, proof: ["0x01"],
    // epoch_id: 25} verified:true with a detail falsely claiming
    // "receipt_hash and epoch_id match the request" — the old code
    // preferred delivery.receipt_hash and never validated the field
    // it did not use.
    const body = {
      receipt_hash:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      delivery: { receipt_hash: RECEIPT, intent: "CRYPTO_PRICE_USD" },
      epoch_id: 25,
      proof: ["0x01"],
    };
    const fetchFn = stubFetch({
      [deliveryUrl(25, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 25, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
    expect(check.detail).toContain("receipt_hash");
    expect(check.detail).toContain("0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
    expect(check.detail).not.toContain("receipt_hash and epoch_id match the request");
  });

  it("200 whose NESTED receipt_hash names a different hash → unverified even when the top-level one matches (round-3 F2, direction B)", async () => {
    const body = {
      receipt_hash: RECEIPT,
      delivery: {
        receipt_hash:
          "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        intent: "CRYPTO_PRICE_USD",
      },
      epoch_id: 25,
      proof: ["0x01"],
    };
    const fetchFn = stubFetch({
      [deliveryUrl(25, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 25, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
    expect(check.detail).toContain("delivery.receipt_hash");
    expect(check.detail).not.toContain("receipt_hash and epoch_id match the request");
  });

  it("200 with BOTH receipt_hash fields matching → still verified (no false negative from the F2 check)", async () => {
    const body = {
      receipt_hash: RECEIPT,
      delivery: { receipt_hash: RECEIPT, intent: "CRYPTO_PRICE_USD" },
      epoch_id: 24,
      proof: ["0xaaa", "0xbbb"],
    };
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: true, status: "verified" });
  });

  it("200 with no proof → unverified (a missing proof never verifies)", async () => {
    const body = deliveryBody();
    delete body["proof"];
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
    expect(check.detail).toContain("no Merkle proof");
  });

  it("200 with an empty proof array → unverified", async () => {
    const body = deliveryBody();
    body["proof"] = [];
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 200, body },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "unverified" });
  });

  it("404 'no block recorded' → pending, never a broken link", async () => {
    const fetchFn = stubFetch({
      [deliveryUrl(25, RECEIPT)]: {
        status: 404,
        body: { error: "no block recorded for this epoch" },
      },
    });
    const check = await verifyDelivery(RECEIPT, 25, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "pending", epoch: null });
    expect(check.detail).toContain("Pending epoch finalization");
    expect(check.delivery_url).toBe(deliveryUrl(25, RECEIPT));
  });

  it("404 with an EMPTY body → pending only if the epoch has no block (probe decides, nothing fabricated)", async () => {
    // Epoch 99: no block anywhere (stub default 404) → pending.
    const fetchFn = stubFetch({});
    const check = await verifyDelivery(RECEIPT, 99, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "pending" });
    expect(check.detail).toContain("no block is recorded for epoch 99 yet");
    expect(check.detail).not.toContain("receipt not in this block");
  });

  it("404 with an empty body but a block DOES exist → not_found (no fabricated reason)", async () => {
    const fetchFn = stubFetch({
      [blockUrl(24)]: { status: 200, body: {} },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "not_found" });
    expect(check.detail).toContain("block exists (finalized)");
  });

  it("404 with an empty body and a failing block probe → error, never a fabricated not_found", async () => {
    const fetchFn: FetchFn = async (url: string) => {
      if (url === deliveryUrl(24, RECEIPT)) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "error" });
    expect(check.detail).toContain("probe failed");
  });

  it("404 'receipt not in this block' → not_found (epoch IS finalized)", async () => {
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: {
        status: 404,
        body: { error: "receipt not in this block" },
      },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "not_found" });
    expect(check.detail).toContain("finalized");
  });

  it("delivery 500 → error", async () => {
    const fetchFn = stubFetch({
      [deliveryUrl(24, RECEIPT)]: { status: 500, body: {} },
    });
    const check = await verifyDelivery(RECEIPT, 24, { fetchFn, now: () => FIXED_NOW });
    expect(check).toMatchObject({ verified: false, status: "error" });
  });

  it("malformed hash / epoch → error, nothing fetched", async () => {
    const calls: string[] = [];
    const fetchFn = stubFetch({}, calls);
    await verifyDelivery("bad", 24, { fetchFn, now: () => FIXED_NOW });
    await verifyDelivery(RECEIPT, -1, { fetchFn, now: () => FIXED_NOW });
    expect(calls).toEqual([]);
  });
});

describe("findLatestFinalizedEpoch", () => {
  it("finds the highest epoch with a block (exponential + binary search)", async () => {
    // Live blocks are contiguous from the first epoch: the search relies
    // on that (an epoch existing implies all earlier ones exist).
    const existing = new Set(Array.from({ length: 25 }, (_, i) => i));
    const fetchFn: FetchFn = async (url: string) => {
      const epoch = Number(url.split("/").pop());
      const ok = existing.has(epoch);
      return { ok, status: ok ? 200 : 404, json: async () => ({}) };
    };
    await expect(findLatestFinalizedEpoch(fetchFn)).resolves.toBe(24);
  });

  it("returns -1 when even epoch 0 has no block", async () => {
    const fetchFn: FetchFn = async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    await expect(findLatestFinalizedEpoch(fetchFn)).resolves.toBe(-1);
  });

  it("THROWS on a transient 500 probe — a 500 is never read as 'no block'", async () => {
    const existing = new Set(Array.from({ length: 25 }, (_, i) => i));
    const fetchFn: FetchFn = async (url: string) => {
      const epoch = Number(url.split("/").pop());
      if (epoch === 16) {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      }
      const ok = existing.has(epoch);
      return { ok, status: ok ? 200 : 404, json: async () => ({}) };
    };
    await expect(findLatestFinalizedEpoch(fetchFn)).rejects.toThrow(/Transient devnode failure/);
  });

  it("THROWS when the epoch-0 probe itself fails transiently", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("fetch failed");
    };
    await expect(findLatestFinalizedEpoch(fetchFn)).rejects.toThrow(/Transient devnode failure/);
  });
});

describe("verifyReceipt (combined verdict)", () => {
  it("signal verified + delivery verified in the given epoch → verified", async () => {
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: { status: 200, body: verifiedSignalBody() },
      [deliveryUrl(24, RECEIPT)]: { status: 200, body: deliveryBody() },
    });
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT, epoch: 24 },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict).toMatchObject({
      verified: true,
      status: "verified",
      signal_hash: SIGNAL,
      receipt_hash: RECEIPT,
      epoch: 24,
    });
    expect(verdict.signal.verified).toBe(true);
    expect(verdict.delivery?.verified).toBe(true);
  });

  it("signal verified, no receipt_hash → PARTIAL (verified:false), never 'verified'", async () => {
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: { status: 200, body: verifiedSignalBody() },
    });
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL },
      { fetchFn, now: () => FIXED_NOW },
    );
    // J2-F1: signal-only must never read as verified — the payment half
    // was never checked. The old expectation (verified:true,
    // status:"verified") pinned the flaw; it is corrected here.
    expect(verdict.verified).toBe(false);
    expect(verdict.status).toBe("partial");
    expect(verdict.delivery).toBe(null);
    expect(verdict.detail).toContain("PARTIALLY verified");
  });

  it("mistyped receipt_hash / epoch throw instead of silently dropping the payment half", async () => {
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: { status: 200, body: verifiedSignalBody() },
    });
    await expect(
      verifyReceipt(
        { signal_hash: SIGNAL, receipt_hash: 123 as unknown as string, epoch: 24 },
        { fetchFn, now: () => FIXED_NOW },
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      verifyReceipt(
        { signal_hash: SIGNAL, receipt_hash: RECEIPT, epoch: "24" as unknown as number },
        { fetchFn, now: () => FIXED_NOW },
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      verifyReceipt(
        { signal_hash: 123 as unknown as string },
        { fetchFn, now: () => FIXED_NOW },
      ),
    ).rejects.toThrow(TypeError);
  });

  it("EMPTY-STRING receipt_hash throws TypeError instead of becoming 'partial' (round-3 F4)", async () => {
    // The old code coerced "" to null, yielding status "partial" with
    // the false detail "No receipt_hash was recorded for this ask" —
    // a receipt_hash WAS supplied, it was empty. "" is malformed, like
    // every other malformed value, and fails closed as an error.
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: { status: 200, body: verifiedSignalBody() },
    });
    await expect(
      verifyReceipt(
        { signal_hash: SIGNAL, receipt_hash: "" },
        { fetchFn, now: () => FIXED_NOW },
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      verifyReceipt(
        { signal_hash: SIGNAL, receipt_hash: "" },
        { fetchFn, now: () => FIXED_NOW },
      ),
    ).rejects.toThrow(/must not be empty/);
  });

  it("malformed receipt_hash with NO epoch → error, never pending (round-4 F1 = J1 N1 = J2 F1)", async () => {
    // Judge reproduction: stubbed devnode where the old code scanned
    // 8 epochs (each refusing the hash as "error", treated as
    // transient), then the latest+1 probe (no block) reported
    // "pending" for a hash that can never settle in any epoch.
    for (const bad of ["not-a-hash", "   ", "0x1234"]) {
      const calls: string[] = [];
      const fetchFn: FetchFn = async (url: string) => {
        calls.push(url);
        if (url === signalUrl(SIGNAL)) {
          return { ok: true, status: 200, json: async () => verifiedSignalBody() };
        }
        if (url.includes("/deliveries/")) {
          return {
            ok: false,
            status: 404,
            json: async () => ({ error: "receipt not in this block" }),
          };
        }
        const epoch = Number(url.split("/").pop());
        const ok = epoch <= 24; // Blocks exist through 24; 25 (latest+1) has none.
        return { ok, status: ok ? 200 : 404, json: async () => ({}) };
      };
      const verdict = await verifyReceipt(
        { signal_hash: SIGNAL, receipt_hash: bad },
        { fetchFn, now: () => FIXED_NOW },
      );
      expect(verdict.verified).toBe(false);
      expect(verdict.status).toBe("error");
      expect(verdict.signal.verified).toBe(true);
      expect(verdict.delivery?.status).toBe("error");
      expect(verdict.delivery?.delivery_url).toBe(null);
      expect(verdict.delivery?.detail).toContain("Refused");
      expect(verdict.detail).toContain("Refused");
      // Nothing was fetched for the delivery half: no epoch discovery,
      // no scan, no latest+1 probe — only the signal lookup ran.
      expect(calls).toEqual([signalUrl(SIGNAL)]);
    }
  });

  it("malformed receipt_hash WITH an epoch → error too (both paths agree, round-4 F1)", async () => {
    const calls: string[] = [];
    const fetchFn = stubFetch(
      { [signalUrl(SIGNAL)]: { status: 200, body: verifiedSignalBody() } },
      calls,
    );
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: "not-a-hash", epoch: 24 },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.status).toBe("error");
    expect(verdict.delivery?.status).toBe("error");
    expect(verdict.delivery?.delivery_url).toBe(deliveryUrl(24, "not-a-hash"));
    expect(verdict.detail).toContain("Refused");
    expect(calls).toEqual([signalUrl(SIGNAL)]);
  });

  it("signal verified + delivery pending (epoch not closed) → pending overall", async () => {
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: { status: 200, body: verifiedSignalBody() },
      [deliveryUrl(25, RECEIPT)]: {
        status: 404,
        body: { error: "no block recorded for this epoch" },
      },
    });
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT, epoch: 25 },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.status).toBe("pending");
    expect(verdict.signal.verified).toBe(true);
    expect(verdict.delivery?.status).toBe("pending");
  });

  it("signal not found → not verified even when the delivery verifies", async () => {
    const fetchFn = stubFetch({
      [signalUrl(SIGNAL)]: { status: 404, body: { error: "signal not found" } },
      [deliveryUrl(24, RECEIPT)]: { status: 200, body: deliveryBody() },
    });
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT, epoch: 24 },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.status).toBe("not_found");
    expect(verdict.delivery?.verified).toBe(true);
  });

  it("no epoch given → discovers latest finalized epoch and scans down", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url: string) => {
      calls.push(url);
      if (url === signalUrl(SIGNAL)) {
        return { ok: true, status: 200, json: async () => verifiedSignalBody() };
      }
      if (url === deliveryUrl(24, RECEIPT)) {
        return { ok: true, status: 200, json: async () => deliveryBody() };
      }
      if (url.startsWith("https://devnode.telegraphprotocol.com/v1/blocks/")) {
        const tail = url.split("/").pop() ?? "";
        // Block probes (no /deliveries/ segment) and delivery lookups.
        if (url.includes("/deliveries/")) {
          return {
            ok: false,
            status: 404,
            json: async () => ({ error: "receipt not in this block" }),
          };
        }
        const epoch = Number(tail);
        const ok = epoch <= 24;
        return { ok, status: ok ? 200 : 404, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(true);
    expect(verdict.epoch).toBe(24);
    expect(verdict.delivery?.status).toBe("verified");
  });

  it("no epoch given, receipt in NO finalized epoch, latest+1 has no block → pending (never not_found)", async () => {
    // J1-F2 / J2-F4: a receipt settling in the unfinalized epoch must
    // not be reported as not_found naming a scanned epoch.
    const fetchFn: FetchFn = async (url: string) => {
      if (url === signalUrl(SIGNAL)) {
        return { ok: true, status: 200, json: async () => verifiedSignalBody() };
      }
      if (url.includes("/deliveries/")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "receipt not in this block" }),
        };
      }
      const epoch = Number(url.split("/").pop());
      const ok = epoch <= 24; // Blocks exist through 24; 25 (latest+1) has none.
      return { ok, status: ok ? 200 : 404, json: async () => ({}) };
    };
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.status).toBe("pending");
    expect(verdict.detail).toContain("epoch 25");
    expect(verdict.detail).not.toContain("epoch 17");
  });

  it("no epoch given, blocks through 25 → pending via latest+1 (26), not not_found", async () => {
    const fetchFn: FetchFn = async (url: string) => {
      if (url === signalUrl(SIGNAL)) {
        return { ok: true, status: 200, json: async () => verifiedSignalBody() };
      }
      if (url.includes("/deliveries/")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "receipt not in this block" }),
        };
      }
      const epoch = Number(url.split("/").pop());
      const ok = epoch <= 25; // Blocks exist through 25: latest is 25, latest+1 (26) has none… but the probe below says otherwise.
      return { ok, status: ok ? 200 : 404, json: async () => ({}) };
    };
    // With blocks through 25, latest = 25 and latest+1 = 26 has no block,
    // so this is pending, not not_found — pin that explicitly instead.
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.status).toBe("pending");
    expect(verdict.detail).toContain("epoch 26");
  });

  it("no epoch given, latest+1 block exists but receipt is in none → not_found naming the scanned range", async () => {
    // Discovery must see latest = 24 while the latest+1 probe sees a
    // block: emulate a block appearing between discovery and probe by
    // making the block probe stateful (first pass: ≤24, then 25 appears).
    let discoveryDone = false;
    const fetchFn: FetchFn = async (url: string) => {
      if (url === signalUrl(SIGNAL)) {
        return { ok: true, status: 200, json: async () => verifiedSignalBody() };
      }
      if (url.includes("/deliveries/")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "receipt not in this block" }),
        };
      }
      const epoch = Number(url.split("/").pop());
      const ok = discoveryDone ? epoch <= 25 : epoch <= 24;
      if (url === blockUrl(25) && !discoveryDone) discoveryDone = true;
      return { ok, status: ok ? 200 : 404, json: async () => ({}) };
    };
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.status).toBe("not_found");
    expect(verdict.detail).toContain("epochs 24 down to 17");
    expect(verdict.detail).not.toContain("epoch 17 block is finalized");
  });

  it("a transient 500 on one scanned epoch never becomes not_found — it surfaces as error", async () => {
    const fetchFn: FetchFn = async (url: string) => {
      if (url === signalUrl(SIGNAL)) {
        return { ok: true, status: 200, json: async () => verifiedSignalBody() };
      }
      if (url === deliveryUrl(24, RECEIPT)) {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      }
      if (url.includes("/deliveries/")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "receipt not in this block" }),
        };
      }
      const epoch = Number(url.split("/").pop());
      const ok = epoch <= 24;
      return { ok, status: ok ? 200 : 404, json: async () => ({}) };
    };
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(false);
    // latest+1 (25) has no block, so the receipt may still settle there:
    // pending outranks the remembered scan error.
    expect(verdict.status).toBe("pending");
    // Round-2 FIX B (J2-F1): the pending detail must carry the
    // remembered scan error — epoch 24 500'd and was never successfully
    // scanned, so the detail must NOT assert the epochs "were scanned
    // and do not contain this receipt" as if the scan were complete.
    expect(verdict.delivery?.detail).toContain("epoch 24");
    expect(verdict.delivery?.detail).toContain("never successfully scanned");
    expect(verdict.delivery?.detail).toContain("incomplete");
    expect(verdict.delivery?.detail).not.toContain(
      "were scanned and do not contain this receipt",
    );
  });

  it("a transient 500 on one scanned epoch surfaces as error when latest+1 HAS a block", async () => {
    let probeCount = 0;
    const fetchFn: FetchFn = async (url: string) => {
      if (url === signalUrl(SIGNAL)) {
        return { ok: true, status: 200, json: async () => verifiedSignalBody() };
      }
      if (url === deliveryUrl(24, RECEIPT)) {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      }
      if (url.includes("/deliveries/")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "receipt not in this block" }),
        };
      }
      // Discovery sees blocks through 24; by probe time 25 has a block.
      if (url === blockUrl(25)) {
        probeCount += 1;
        const ok = probeCount > 1; // First sighting (discovery): no block. Later: block.
        return { ok, status: ok ? 200 : 404, json: async () => ({}) };
      }
      const epoch = Number(url.split("/").pop());
      const ok = epoch <= 24;
      return { ok, status: ok ? 200 : 404, json: async () => ({}) };
    };
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.status).toBe("error");
    expect(verdict.detail).toContain("500");
  });

  it("a transient 500 on one epoch does not stop the scan — a lower epoch still verifies", async () => {
    const fetchFn: FetchFn = async (url: string) => {
      if (url === signalUrl(SIGNAL)) {
        return { ok: true, status: 200, json: async () => verifiedSignalBody() };
      }
      if (url === deliveryUrl(24, RECEIPT)) {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      }
      if (url === deliveryUrl(23, RECEIPT)) {
        // A body that genuinely binds to epoch 23 (not the epoch-24 body).
        return {
          ok: true,
          status: 200,
          json: async () => ({
            delivery: { receipt_hash: RECEIPT, intent: "CRYPTO_PRICE_USD" },
            epoch_id: 23,
            proof: ["0xaaa", "0xbbb"],
          }),
        };
      }
      if (url.includes("/deliveries/")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "receipt not in this block" }),
        };
      }
      const epoch = Number(url.split("/").pop());
      const ok = epoch <= 24;
      return { ok, status: ok ? 200 : 404, json: async () => ({}) };
    };
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(true);
    expect(verdict.status).toBe("verified");
    expect(verdict.epoch).toBe(23);
  });

  it("a 200 for the WRONG epoch never verifies — the binding check rejects it", async () => {
    // Same stub shape, but the epoch-23 lookup returns the epoch-24 body:
    // epoch_id 24 ≠ requested 23, so the scan continues to pending via
    // latest+1 instead of falsely verifying.
    const fetchFn: FetchFn = async (url: string) => {
      if (url === signalUrl(SIGNAL)) {
        return { ok: true, status: 200, json: async () => verifiedSignalBody() };
      }
      if (url === deliveryUrl(23, RECEIPT)) {
        return { ok: true, status: 200, json: async () => deliveryBody() };
      }
      if (url.includes("/deliveries/")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "receipt not in this block" }),
        };
      }
      const epoch = Number(url.split("/").pop());
      const ok = epoch <= 24;
      return { ok, status: ok ? 200 : 404, json: async () => ({}) };
    };
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL, receipt_hash: RECEIPT },
      { fetchFn, now: () => FIXED_NOW },
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.status).toBe("pending");
  });

  it("a deadline already in the past fails closed as error and fetches nothing", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => verifiedSignalBody() };
    };
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL },
      { fetchFn, now: () => FIXED_NOW, deadline: Date.now() - 1000 },
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.status).toBe("error");
    expect(verdict.signal.status).toBe("error");
    expect(verdict.signal.detail).toContain("deadline");
    expect(calls).toEqual([]);
  });

  it("a fetch that ignores AbortSignal still cannot hang past the per-fetch timeout", async () => {
    // A stub that never settles and never looks at the signal: the race
    // in fetchJson must reject anyway. Use a tiny deadline so the test
    // runs in ~50ms instead of 120s.
    const fetchFn: FetchFn = async () => new Promise(() => {});
    const verdict = await verifyReceipt(
      { signal_hash: SIGNAL },
      { fetchFn, now: () => FIXED_NOW, deadline: Date.now() + 50 },
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.signal.status).toBe("error");
    expect(verdict.signal.detail).toMatch(/timed out|deadline/);
  });
});

describe("verifyRawBytes", () => {
  it("matches the SHA-256 vector for 'abc' (0x-prefixed)", () => {
    const r = verifyRawBytes(
      "abc",
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(r.match).toBe(true);
    expect(r.computedSha).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("empty bytes NEVER match — not even against sha256('') (O3)", () => {
    const r = verifyRawBytes(
      "",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(r.match).toBe(false);
    expect(r.computedSha).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(verifyRawBytes(Buffer.alloc(0), "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855").match).toBe(
      false,
    );
  });

  it("comparison ignores 0x prefix and case", () => {
    const r = verifyRawBytes(
      "abc",
      "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
    );
    expect(r.match).toBe(true);
  });

  it("Buffer input hashes identically to its string form", () => {
    const r = verifyRawBytes(
      Buffer.from("abc", "utf8"),
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(r.match).toBe(true);
  });

  it("different bytes → mismatch with both hashes reported", () => {
    const r = verifyRawBytes(
      "abd",
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(r.match).toBe(false);
    expect(r.computedSha).not.toBe(r.recordedSha);
    expect(r.recordedSha).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("malformed recorded digest → mismatch, never a throw", () => {
    expect(verifyRawBytes("abc", "not-a-hash").match).toBe(false);
    expect(verifyRawBytes("abc", "").match).toBe(false);
    expect(verifyRawBytes("abc", "0x1234").match).toBe(false);
  });

  it("non-string / null / undefined inputs → match:false, never a throw (J2-F6)", () => {
    const good = "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(verifyRawBytes("abc", null).match).toBe(false);
    expect(verifyRawBytes("abc", undefined).match).toBe(false);
    expect(verifyRawBytes("abc", 123).match).toBe(false);
    expect(verifyRawBytes("abc", {}).match).toBe(false);
    expect(verifyRawBytes(null, good).match).toBe(false);
    expect(verifyRawBytes(undefined, good).match).toBe(false);
    expect(verifyRawBytes(123, good).match).toBe(false);
    expect(verifyRawBytes(null, null).match).toBe(false);
    // And the malformed cases still report the hashes honestly.
    expect(verifyRawBytes(null, good).computedSha).toBe("");
    expect(verifyRawBytes(null, good).recordedSha).toBe(good);
    expect(verifyRawBytes("abc", null).recordedSha).toBe("");
  });
});
