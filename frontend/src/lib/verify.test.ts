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

/**
 * An ArrayBuffer holding exactly the UTF-8 bytes of `text`, as
 * `await res.arrayBuffer()` returns. NOT `encode(text).buffer` directly:
 * a TextEncoder may hand back a view into a pooled, larger buffer, so
 * the raw .buffer would hash trailing pool bytes instead of the text.
 * Slicing to the view's exact byte range keeps the bytes exact while
 * still exercising the cross-realm ArrayBuffer path.
 */
function arrayBufferOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
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

  it("hashes an ArrayBuffer identically to its string form (J2 R3)", async () => {
    const fromString = await sha256Hex("abc");
    const fromBuffer = await sha256Hex(arrayBufferOf("abc"));
    expect(fromBuffer).toBe(fromString);
    expect(fromBuffer).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects a Symbol.toStringTag-spoofed 'ArrayBuffer' instead of hashing empty bytes (J2 R4 M-2)", async () => {
    const spoof = { [Symbol.toStringTag]: "ArrayBuffer" } as unknown as ArrayBuffer;
    await expect(sha256Hex(spoof)).rejects.toThrow(TypeError);
    // A spoof carrying a length must not pass either.
    const spoofWithLength = {
      [Symbol.toStringTag]: "ArrayBuffer",
      length: 3,
    } as unknown as ArrayBuffer;
    await expect(sha256Hex(spoofWithLength)).rejects.toThrow(TypeError);
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

  it("verifies an ArrayBuffer body instead of false-negativing on it (J2 R3)", async () => {
    const result = await verifyReceipt(
      receiptWith("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
      arrayBufferOf("abc"),
    );
    expect(result.verified).toBe(true);
    expect(result.computedSha).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("fails (not throws) when an ArrayBuffer body does not match the digest", async () => {
    const result = await verifyReceipt(
      receiptWith("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
      arrayBufferOf("different body"),
    );
    expect(result.verified).toBe(false);
    expect(result.computedSha).not.toBe("");
  });

  it("returns { verified: false } for a Symbol.toStringTag-spoofed 'ArrayBuffer' (J2 R4 M-2)", async () => {
    // J2's repro: a plain object claiming the ArrayBuffer tag used to
    // hash as empty bytes (new Uint8Array(spoof) yields length 0), so
    // it faked verified:true against the sha256("") digest.
    const emptyDigest =
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const spoof = { [Symbol.toStringTag]: "ArrayBuffer" } as unknown as ArrayBuffer;
    await expect(verifyReceipt(receiptWith(emptyDigest), spoof)).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
    const spoofWithLength = {
      [Symbol.toStringTag]: "ArrayBuffer",
      length: 3,
    } as unknown as ArrayBuffer;
    await expect(verifyReceipt(receiptWith(emptyDigest), spoofWithLength)).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
  });

  it("verifies a real empty ArrayBuffer against the empty-string digest (J2 R4 M-2)", async () => {
    const result = await verifyReceipt(
      receiptWith("0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
      new ArrayBuffer(0),
    );
    expect(result.verified).toBe(true);
    expect(result.computedSha).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("verifies a DataView body — views must not regress (J2 R4 M-2)", async () => {
    const bytes = new TextEncoder().encode("abc");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await verifyReceipt(
      receiptWith("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
      view as unknown as ArrayBuffer,
    );
    expect(result.verified).toBe(true);
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

describe("detached views fail closed (J2 R5 B-2)", () => {
  // ArrayBuffer.transfer() / resizable buffers exist at runtime
  // (Node 24) but predate this project's TS lib, so reach them
  // through narrow casts instead of changing the lib for the branch.
  const transferBuffer = (buf: ArrayBuffer): void => {
    (buf as unknown as { transfer(): ArrayBuffer }).transfer();
  };
  const resizableBuffer = (byteLength: number, maxByteLength: number): ArrayBuffer =>
    new (
      ArrayBuffer as unknown as new (
        byteLength: number,
        options: { maxByteLength: number },
      ) => ArrayBuffer
    )(byteLength, { maxByteLength });
  const resizeBuffer = (buf: ArrayBuffer, byteLength: number): void => {
    (buf as unknown as { resize(byteLength: number): void }).resize(byteLength);
  };
  const EMPTY_SHA =
    "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const ABC_SHA =
    "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  /** A Uint8Array view over `text`, detached via buffer.transfer(). */
  function detachedViewOf(text: string): Uint8Array {
    const view = new Uint8Array(arrayBufferOf(text));
    transferBuffer(view.buffer);
    return view;
  }

  it("fails a detached Uint8Array view instead of hashing zero bytes", async () => {
    // J2's repro: buffer "hello" -> view -> transfer() -> verifyReceipt
    // against sha256("") returned { verified: true } (fail-open).
    const view = detachedViewOf("hello");
    expect(view.length).toBe(0);
    await expect(verifyReceipt(receiptWith(EMPTY_SHA), view)).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
  });

  it("fails a detached offset view", async () => {
    const buf = new ArrayBuffer(10);
    new Uint8Array(buf).set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const view = new Uint8Array(buf, 2, 5);
    transferBuffer(buf);
    expect(view.length).toBe(0);
    await expect(verifyReceipt(receiptWith(EMPTY_SHA), view)).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
  });

  it("fails a detached Float64Array view", async () => {
    const view = new Float64Array([1, 2, 3]);
    transferBuffer(view.buffer);
    expect(view.length).toBe(0);
    await expect(
      verifyReceipt(receiptWith(EMPTY_SHA), view as unknown as ArrayBuffer),
    ).resolves.toEqual({ verified: false, computedSha: "" });
  });

  it("fails a detached DataView instead of throwing", async () => {
    // The old path threw TypeError out of subtle.digest, violating the
    // documented "malformed input returns {verified:false}" contract.
    const view = new DataView(arrayBufferOf("hello"));
    transferBuffer(view.buffer);
    await expect(
      verifyReceipt(receiptWith(EMPTY_SHA), view as unknown as ArrayBuffer),
    ).resolves.toEqual({ verified: false, computedSha: "" });
  });

  it("sha256Hex rejects (never empty-hashes) a detached view / DataView", async () => {
    await expect(sha256Hex(detachedViewOf("hello"))).rejects.toThrow(TypeError);
    const dv = new DataView(arrayBufferOf("hello"));
    transferBuffer(dv.buffer);
    await expect(sha256Hex(dv as unknown as ArrayBuffer)).rejects.toThrow(TypeError);
  });

  it("still verifies a genuinely empty view (length 0 by construction) against the empty digest", async () => {
    const result = await verifyReceipt(receiptWith(EMPTY_SHA), new Uint8Array(0));
    expect(result).toEqual({ verified: true, computedSha: EMPTY_SHA });
  });

  it("still verifies a resizable buffer resized to 0 against the empty digest", async () => {
    const buf = resizableBuffer(5, 10);
    const view = new Uint8Array(buf);
    resizeBuffer(buf, 0);
    expect(view.length).toBe(0);
    const result = await verifyReceipt(receiptWith(EMPTY_SHA), view);
    expect(result).toEqual({ verified: true, computedSha: EMPTY_SHA });
  });

  it("still fails (not throws) a detached ArrayBuffer", async () => {
    const buf = arrayBufferOf("abc");
    transferBuffer(buf);
    await expect(verifyReceipt(receiptWith(ABC_SHA), buf)).resolves.toEqual({
      verified: false,
      computedSha: "",
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
