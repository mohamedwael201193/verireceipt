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
});
