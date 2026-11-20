import { afterEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";
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

describe("SharedArrayBuffer bodies verify (J2 R6 M-3)", () => {
  // WebCrypto throws TypeError for a view on a SharedArrayBuffer, so
  // a SAB-backed body used to return {verified:false} even when the
  // bytes matched — fail-closed, but a false negative. toBytes now
  // copies SAB-backed bytes into a fresh ArrayBuffer. The copy is
  // safe by construction: a SharedArrayBuffer can never be detached,
  // so the B-2 detached-view guarantee (probe-then-throw, exercised
  // in the describe above) is untouched by this path.
  const ABC_SHA =
    "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const EMPTY_SHA =
    "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  function sabOf(text: string): SharedArrayBuffer {
    const bytes = new TextEncoder().encode(text);
    const sab = new SharedArrayBuffer(bytes.byteLength);
    new Uint8Array(sab).set(bytes);
    return sab;
  }

  it("verifies a Uint8Array view over a SharedArrayBuffer", async () => {
    const view = new Uint8Array(sabOf("abc"));
    const result = await verifyReceipt(receiptWith(ABC_SHA), view);
    expect(result).toEqual({ verified: true, computedSha: ABC_SHA });
  });

  it("verifies an offset view over a SharedArrayBuffer (only its own bytes)", async () => {
    const sab = sabOf("xxabcyy");
    const view = new Uint8Array(sab, 2, 3);
    const result = await verifyReceipt(receiptWith(ABC_SHA), view);
    expect(result).toEqual({ verified: true, computedSha: ABC_SHA });
  });

  it("verifies a DataView over a SharedArrayBuffer", async () => {
    const view = new DataView(sabOf("abc"));
    const result = await verifyReceipt(
      receiptWith(ABC_SHA),
      view as unknown as ArrayBuffer,
    );
    expect(result).toEqual({ verified: true, computedSha: ABC_SHA });
  });

  it("verifies a bare SharedArrayBuffer", async () => {
    const result = await verifyReceipt(receiptWith(ABC_SHA), sabOf("abc"));
    expect(result).toEqual({ verified: true, computedSha: ABC_SHA });
  });

  it("still fails a SharedArrayBuffer view against the wrong digest", async () => {
    const view = new Uint8Array(sabOf("abc"));
    const result = await verifyReceipt(receiptWith(EMPTY_SHA), view);
    expect(result.verified).toBe(false);
    expect(result.computedSha).toBe(ABC_SHA);
  });

  it("sha256Hex hashes a SharedArrayBuffer view identically to its string form", async () => {
    const view = new Uint8Array(sabOf("abc"));
    await expect(sha256Hex(view)).resolves.toBe(ABC_SHA);
    await expect(sha256Hex(sabOf("abc"))).resolves.toBe(ABC_SHA);
  });

  it("still verifies a genuinely empty SharedArrayBuffer view against the empty digest", async () => {
    const view = new Uint8Array(new SharedArrayBuffer(0));
    const result = await verifyReceipt(receiptWith(EMPTY_SHA), view);
    expect(result).toEqual({ verified: true, computedSha: EMPTY_SHA });
  });

  it("rejects a Symbol.toStringTag-spoofed 'SharedArrayBuffer' instead of hashing empty bytes", async () => {
    const spoof = { [Symbol.toStringTag]: "SharedArrayBuffer" } as unknown as ArrayBuffer;
    await expect(sha256Hex(spoof)).rejects.toThrow(TypeError);
    await expect(
      verifyReceipt(receiptWith(EMPTY_SHA), spoof as unknown as ArrayBuffer),
    ).resolves.toEqual({ verified: false, computedSha: "" });
  });
});

describe("tag-spoofed SharedArrayBuffer verifies (J2 R7 M-3)", () => {
  // J2's round-6 repro: a SharedArrayBuffer with an own
  // Symbol.toStringTag of "ArrayBuffer" made toString report
  // "[object ArrayBuffer]", so the SAB-copy branch was skipped, the
  // raw SAB view reached subtle.digest (TypeError), and
  // verifyReceipt returned {verified:false} even with the correct
  // digest — a false negative. SAB detection is now tag-independent
  // (identity + `instanceof ArrayBuffer`), and bare buffers are
  // always copied into a fresh plain ArrayBuffer before hashing.
  const ABC_SHA =
    "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const EMPTY_SHA =
    "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  function sabOf(text: string): SharedArrayBuffer {
    const bytes = new TextEncoder().encode(text);
    const sab = new SharedArrayBuffer(bytes.byteLength);
    new Uint8Array(sab).set(bytes);
    return sab;
  }

  /** A real SAB whose toString tag claims it is an ArrayBuffer. */
  function spoofedSabOf(text: string, tag = "ArrayBuffer"): SharedArrayBuffer {
    const sab = sabOf(text);
    Object.defineProperty(sab, Symbol.toStringTag, { value: tag, configurable: true });
    expect(Object.prototype.toString.call(sab)).toBe(`[object ${tag}]`);
    return sab;
  }

  it("verifies a bare tag-spoofed SAB with the correct digest", async () => {
    const result = await verifyReceipt(receiptWith(ABC_SHA), spoofedSabOf("abc"));
    expect(result).toEqual({ verified: true, computedSha: ABC_SHA });
  });

  it("fails a bare tag-spoofed SAB against the wrong digest, with the correct computedSha", async () => {
    const result = await verifyReceipt(receiptWith(EMPTY_SHA), spoofedSabOf("abc"));
    expect(result.verified).toBe(false);
    expect(result.computedSha).toBe(ABC_SHA);
  });

  it("verifies a tag-spoofed SAB even when the tag is spoofed to something else entirely", async () => {
    const result = await verifyReceipt(
      receiptWith(ABC_SHA),
      spoofedSabOf("abc", "TotallyNotABuffer"),
    );
    expect(result).toEqual({ verified: true, computedSha: ABC_SHA });
  });

  it("verifies a Uint8Array view over a tag-spoofed SAB (only its own bytes)", async () => {
    const view = new Uint8Array(spoofedSabOf("xxabcyy"), 2, 3);
    const result = await verifyReceipt(receiptWith(ABC_SHA), view);
    expect(result).toEqual({ verified: true, computedSha: ABC_SHA });
  });

  it("verifies an offset view and a DataView over a tag-spoofed SAB", async () => {
    const sab = spoofedSabOf("abc");
    const view = new Uint8Array(sab, 0, 3);
    await expect(verifyReceipt(receiptWith(ABC_SHA), view)).resolves.toEqual({
      verified: true,
      computedSha: ABC_SHA,
    });
    const dataView = new DataView(spoofedSabOf("abc"));
    await expect(
      verifyReceipt(receiptWith(ABC_SHA), dataView as unknown as ArrayBuffer),
    ).resolves.toEqual({ verified: true, computedSha: ABC_SHA });
  });

  it("sha256Hex hashes a bare tag-spoofed SAB identically to its string form", async () => {
    await expect(sha256Hex(spoofedSabOf("abc"))).resolves.toBe(ABC_SHA);
    await expect(sha256Hex(new Uint8Array(spoofedSabOf("abc")))).resolves.toBe(ABC_SHA);
  });

  it("still rejects a Symbol.toStringTag-spoofed plain object (tag 'ArrayBuffer')", async () => {
    // The tag-independent identity check must not become a spoof
    // bypass: a plain object claiming the ArrayBuffer tag has no
    // buffer of its own, so it is rejected exactly as before.
    const spoof = { [Symbol.toStringTag]: "ArrayBuffer" } as unknown as SharedArrayBuffer;
    await expect(sha256Hex(spoof)).rejects.toThrow(TypeError);
    await expect(
      verifyReceipt(receiptWith(EMPTY_SHA), spoof as unknown as ArrayBuffer),
    ).resolves.toEqual({ verified: false, computedSha: "" });
  });

  it("verifies a cross-realm SharedArrayBuffer and a cross-realm ArrayBuffer view", async () => {
    // instanceof fails across realms, so the tag + instanceof legs
    // alone would miss these; the identity check + copy cover them.
    const ctx = vm.createContext({});
    const xSab = vm.runInContext(
      "new SharedArrayBuffer(3)",
      ctx,
    ) as SharedArrayBuffer;
    new Uint8Array(xSab).set(new TextEncoder().encode("abc"));
    expect(xSab instanceof SharedArrayBuffer).toBe(false);
    await expect(verifyReceipt(receiptWith(ABC_SHA), xSab)).resolves.toEqual({
      verified: true,
      computedSha: ABC_SHA,
    });
    const xView = vm.runInContext(
      "new Uint8Array([97, 98, 99])",
      ctx,
    ) as Uint8Array;
    expect(xView.buffer instanceof ArrayBuffer).toBe(false);
    await expect(verifyReceipt(receiptWith(ABC_SHA), xView)).resolves.toEqual({
      verified: true,
      computedSha: ABC_SHA,
    });
  });
});
