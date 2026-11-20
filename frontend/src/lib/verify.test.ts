import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, verifyReceipt } from "./verify";
import type { Receipt } from "./types";

function receiptWith(sha: string): Receipt {
  return {
    receipt_id: "rcpt_TEST",
    upstream_url: "https://example.com/upstream",
    raw_response_sha256: sha,
    fetched_at: "2026-11-20T07:37:12.206Z",
  };
}

describe("sha256Hex", () => {
  it("matches the known SHA-256 vector for 'abc'", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the known SHA-256 vector for the empty string", async () => {
    await expect(sha256Hex("")).resolves.toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes Uint8Array input identically to its string form", async () => {
    const fromString = await sha256Hex("abc");
    const fromBytes = await sha256Hex(new TextEncoder().encode("abc"));
    expect(fromBytes).toBe(fromString);
  });
});

describe("verifyReceipt", () => {
  it("verifies when the recomputed hash matches the recorded digest", async () => {
    const result = await verifyReceipt(
      receiptWith("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
      "abc",
    );
    expect(result.verified).toBe(true);
    expect(result.computedSha).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches regardless of 0x prefix and case in the recorded digest", async () => {
    const result = await verifyReceipt(
      receiptWith("BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"),
      "abc",
    );
    expect(result.verified).toBe(true);
  });

  it("fails when the body does not match the recorded digest", async () => {
    const result = await verifyReceipt(
      receiptWith("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
      "different body",
    );
    expect(result.verified).toBe(false);
    expect(result.computedSha).not.toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("fails when the recorded digest is empty", async () => {
    const result = await verifyReceipt(receiptWith(""), "abc");
    expect(result.verified).toBe(false);
  });

  it("returns { verified: false } on a null receipt instead of throwing (J2 M3)", async () => {
    await expect(verifyReceipt(null, "abc")).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
    await expect(verifyReceipt(undefined, "abc")).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
  });

  it("returns { verified: false } on a non-string recorded hash instead of throwing (J2 M3)", async () => {
    const bad = { ...receiptWith("0xabc"), raw_response_sha256: 123 as unknown as string };
    await expect(verifyReceipt(bad, "abc")).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
  });

  it("returns { verified: false } on malformed bodies instead of throwing (J2 M3)", async () => {
    const receipt = receiptWith(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(verifyReceipt(receipt, null)).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
    await expect(verifyReceipt(receipt, undefined)).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
    await expect(verifyReceipt(receipt, 123 as unknown as string)).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
    await expect(verifyReceipt(receipt, {} as unknown as string)).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
  });

  it("still throws when WebCrypto is unavailable — never a fake hash (J2 M3)", async () => {
    vi.stubGlobal("crypto", undefined);
    try {
      await expect(
        verifyReceipt(
          receiptWith("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
          "abc",
        ),
      ).rejects.toThrow(/WebCrypto/);
      // Even malformed input must not mask the missing-crypto failure.
      await expect(verifyReceipt(null, "abc")).rejects.toThrow(/WebCrypto/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
