import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, verifyReceipt } from "./receipt";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("receipt verification (DESIGN-SPEC §8 A16/A19)", () => {
  it("recomputes SHA-256 and matches the receipt hash", async () => {
    const body = '{"tx_hash":"0xabc","status":"confirmed"}';
    const expected = createHash("sha256").update(body).digest("hex");
    await expect(verifyReceipt(body, expected)).resolves.toBe(true);
    // 0x-prefixed and uppercase forms must also match.
    await expect(verifyReceipt(body, `0x${expected.toUpperCase()}`)).resolves.toBe(true);
  });

  it("reports a mismatch instead of a false Verified", async () => {
    const body = '{"tx_hash":"0xabc","status":"confirmed"}';
    await expect(verifyReceipt(body, "00".repeat(32))).resolves.toBe(false);
    await expect(verifyReceipt(body, "not-a-hash")).resolves.toBe(false);
  });

  it("sha256Hex matches Node's implementation", async () => {
    const body = "verireceipt";
    const expected = createHash("sha256").update(body).digest("hex");
    await expect(sha256Hex(body)).resolves.toBe(expected);
  });

  it("refuses to verify when WebCrypto is unavailable (never a fake hash)", async () => {
    vi.stubGlobal("crypto", undefined);
    await expect(sha256Hex("x")).rejects.toThrow(/WebCrypto/);
    await expect(verifyReceipt("x", "00".repeat(32))).rejects.toThrow(/WebCrypto/);
  });

  it("returns false for non-string inputs instead of throwing (J2 M2)", async () => {
    const validHash = "00".repeat(32);
    await expect(verifyReceipt(undefined, validHash)).resolves.toBe(false);
    await expect(verifyReceipt(null, validHash)).resolves.toBe(false);
    await expect(verifyReceipt(123, validHash)).resolves.toBe(false);
    await expect(verifyReceipt({ raw: "x" }, validHash)).resolves.toBe(false);
    await expect(verifyReceipt(["x"], validHash)).resolves.toBe(false);
    await expect(verifyReceipt("x", undefined)).resolves.toBe(false);
    await expect(verifyReceipt("x", null)).resolves.toBe(false);
    await expect(verifyReceipt("x", 123)).resolves.toBe(false);
    await expect(verifyReceipt("x", {})).resolves.toBe(false);
    await expect(verifyReceipt(undefined, undefined)).resolves.toBe(false);
  });

  it("still throws on non-string inputs when WebCrypto is unavailable (J2 M2)", async () => {
    vi.stubGlobal("crypto", undefined);
    // WebCrypto refusal wins over the non-string false: never a fake hash.
    await expect(verifyReceipt(undefined, "00".repeat(32))).rejects.toThrow(/WebCrypto/);
    await expect(verifyReceipt("x", undefined)).rejects.toThrow(/WebCrypto/);
  });
});
