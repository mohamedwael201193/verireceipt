// Audit re-hash tests — frontend/src/lib/auditRehash.ts.
//
// The miner audit endpoint is stubbed (no network). The hash oracle is
// the standard SHA-256 test vector for "abc"; the receipt bytes are
// synthetic. Live proof lives in the worker's report, not in these tests.

import { describe, expect, it, vi } from "vitest";
import { auditRawUrl, rehashFromAudit } from "./auditRehash";
import type { Receipt } from "./types";

const ABC_SHA =
  "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function receiptWith(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: "rcpt_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    upstream_url: "https://example.com/upstream",
    raw_response_sha256: ABC_SHA,
    fetched_at: "2026-11-20T16:25:57.739Z",
    audit_url: "https://verireceipt.onrender.com/receipts/rcpt_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ...overrides,
  };
}

function bytesOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

type StubResponse = {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function stubFetch(res: StubResponse) {
  return async (_url: string): Promise<StubResponse> => res;
}

describe("auditRawUrl", () => {
  it("derives /receipts/:id/raw from the receipt's audit_url origin", () => {
    expect(auditRawUrl(receiptWith())).toBe(
      "https://verireceipt.onrender.com/receipts/rcpt_ABCDEFGHIJKLMNOPQRSTUVWXYZ/raw",
    );
  });

  it("a baseUrl override wins over audit_url", () => {
    expect(auditRawUrl(receiptWith(), "https://staging.example.com/x")).toBe(
      "https://staging.example.com/receipts/rcpt_ABCDEFGHIJKLMNOPQRSTUVWXYZ/raw",
    );
  });

  it("returns '' for a malformed receipt_id (no path injection)", () => {
    expect(auditRawUrl(receiptWith({ receipt_id: "../../etc/passwd" }))).toBe("");
    expect(auditRawUrl(receiptWith({ receipt_id: "rcpt_short" }))).toBe("");
    expect(auditRawUrl(null)).toBe("");
    expect(auditRawUrl(undefined)).toBe("");
  });

  it("returns '' for a non-https audit_url", () => {
    expect(
      auditRawUrl(receiptWith({ audit_url: "http://verireceipt.onrender.com/receipts/x" })),
    ).toBe("");
    expect(auditRawUrl(receiptWith({ audit_url: "not a url" }))).toBe("");
  });
});

describe("rehashFromAudit", () => {
  it("match: stored bytes hash to the recorded digest", async () => {
    const result = await rehashFromAudit(
      receiptWith(),
      stubFetch({ ok: true, status: 200, arrayBuffer: async () => bytesOf("abc") }),
    );
    expect(result.status).toBe("match");
    expect(result.computedSha).toBe(ABC_SHA);
    expect(result.recordedSha).toBe(ABC_SHA);
    expect(result.auditRawUrl).toContain("/raw");
  });

  it("mismatch: stored bytes hash to a different digest, both hashes reported", async () => {
    const result = await rehashFromAudit(
      receiptWith(),
      stubFetch({ ok: true, status: 200, arrayBuffer: async () => bytesOf("abd") }),
    );
    expect(result.status).toBe("mismatch");
    expect(result.computedSha).not.toBe(ABC_SHA);
    expect(result.recordedSha).toBe(ABC_SHA);
  });

  it("audit endpoint 404 → unavailable, NOT mismatch (the live state)", async () => {
    const result = await rehashFromAudit(
      receiptWith(),
      stubFetch({
        ok: false,
        status: 404,
        arrayBuffer: async () => bytesOf(""),
      }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.computedSha).toBe("");
    expect(result.reason).toContain("404");
    expect(result.reason).toContain("not a mismatch");
  });

  it("audit endpoint 500 → unavailable with the status", async () => {
    const result = await rehashFromAudit(
      receiptWith(),
      stubFetch({
        ok: false,
        status: 500,
        arrayBuffer: async () => bytesOf(""),
      }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("500");
  });

  it("fetch failure → unavailable, never a verdict without bytes", async () => {
    const result = await rehashFromAudit(receiptWith(), async () => {
      throw new Error("Failed to fetch");
    });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("Failed to fetch");
  });

  it("malformed receipt → unavailable (no URL, no verdict)", async () => {
    const result = await rehashFromAudit(
      receiptWith({ receipt_id: "bad" }),
      stubFetch({ ok: true, status: 200, arrayBuffer: async () => bytesOf("abc") }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.auditRawUrl).toBe("");
  });

  it("missing recorded digest → unavailable", async () => {
    const result = await rehashFromAudit(
      receiptWith({ raw_response_sha256: "" }),
      stubFetch({ ok: true, status: 200, arrayBuffer: async () => bytesOf("abc") }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("no recorded");
  });

  it("zero bytes served never MATCH — not even against sha256('') (O3)", async () => {
    const result = await rehashFromAudit(
      receiptWith({
        raw_response_sha256:
          "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      }),
      stubFetch({ ok: true, status: 200, arrayBuffer: async () => bytesOf("") }),
    );
    expect(result.status).toBe("mismatch");
    expect(result.reason).toContain("zero bytes");
  });

  it("a hung audit fetch times out after 30s → unavailable, never a hang (J2-F7)", async () => {
    vi.useFakeTimers();
    try {
      // A stub that never settles and ignores the AbortSignal: the race
      // must still surface UNAVAILABLE at the budget.
      const hanging = async (): Promise<StubResponse> => new Promise(() => {});
      const pending = rehashFromAudit(receiptWith(), hanging);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result.status).toBe("unavailable");
      expect(result.reason).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fetch that resolves but whose arrayBuffer() never resolves still times out after 30s (round-3 F3)", async () => {
    // The judge's reproduction: a signal-ignoring fetch whose
    // arrayBuffer() never resolves left rehashFromAudit pending after
    // 35.0s (past its 30s budget, no UNAVAILABLE) — the old code
    // cleared the timer after the fetch race and awaited arrayBuffer()
    // plain. The body read must race the same budget.
    vi.useFakeTimers();
    try {
      const hangingBody = async (): Promise<StubResponse> => ({
        ok: true,
        status: 200,
        arrayBuffer: () => new Promise(() => {}),
      });
      const pending = rehashFromAudit(receiptWith(), hangingBody);
      // The fetch resolves immediately; the budget is spent on the read.
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result.status).toBe("unavailable");
      expect(result.reason).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an AbortSignal to the fetch implementation", async () => {
    let seenSignal: unknown = null;
    const fetchImpl = async (_url: string, init?: { signal?: AbortSignal }) => {
      seenSignal = init?.signal;
      return { ok: true, status: 200, arrayBuffer: async () => bytesOf("abc") };
    };
    const result = await rehashFromAudit(receiptWith(), fetchImpl);
    expect(result.status).toBe("match");
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });
});
