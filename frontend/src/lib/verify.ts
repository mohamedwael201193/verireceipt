// Receipt verification: recompute SHA-256 over a fetched upstream response
// body and compare it with the receipt's recorded digest.
//
// This replaces the design files' undefined "Merkle Verified" model and
// their always-passing canned verification: the only claim this helper
// makes is "these bytes hash to the recorded digest".
//
// IMPORTANT — what is hashed: the miner hashes the RAW UPSTREAM response
// bytes (e.g. the SEC EDGAR / DeFiLlama / RPC payload), NOT its own JSON
// envelope. So `rawBody` must be the bytes fetched from
// `receipt.upstream_url`. Hashing the miner's JSON envelope will NOT match.
// Fetching some upstreams from the browser may be CORS-blocked; in that
// case the page must surface "cannot verify in browser", never a fake match.
//
// No fallback hash: if WebCrypto is unavailable, sha256Hex throws instead
// of returning a look-alike digest (cf. DESIGN-SPEC §8 A19 — the FNV-1a
// fallback in the design files must never ship).

import type { Receipt } from "./types";

export interface ReceiptVerification {
  verified: boolean;
  /** 0x-prefixed lowercase hex SHA-256 of the supplied body. */
  computedSha: string;
}

/**
 * Cross-realm ArrayBuffer check: `instanceof ArrayBuffer` fails for a
 * buffer from another realm (jsdom's TextEncoder / a Response's
 * arrayBuffer in some environments), exactly the trap the Uint8Array
 * check already avoids with ArrayBuffer.isView. Object.prototype.toString
 * reads the object's internal class tag instead of its prototype chain.
 *
 * toString alone is NOT enough (J2 R4 M-2): any plain object can spoof
 * the tag via `[Symbol.toStringTag]: "ArrayBuffer"`, and toBytes then
 * did `new Uint8Array(spoof)` — an array-like with no length, silently
 * yielding empty bytes — so a spoofed body hashed as the empty string
 * and faked verified:true against the sha256("") digest. The identity
 * check closes it: a real ArrayBuffer is its own view's buffer
 * (`new Uint8Array(buf).buffer === buf`); a spoof's is a fresh empty
 * buffer. Identity is realm-independent, so cross-realm real buffers
 * still pass; pooled views and DataViews never reach here (they take
 * the ArrayBuffer.isView path); a detached buffer fails closed to
 * {verified:false} instead of throwing out of toBytes.
 */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  if (value === null || typeof value !== "object") return false;
  if (Object.prototype.toString.call(value) !== "[object ArrayBuffer]") return false;
  try {
    return new Uint8Array(value as ArrayBuffer).buffer === value;
  } catch {
    return false;
  }
}

/**
 * SharedArrayBuffer check, same shape as isArrayBuffer: the tag alone
 * is spoofable (`[Symbol.toStringTag]`), so the identity check closes
 * it — a real SharedArrayBuffer is its own view's buffer, a spoof's
 * is a fresh empty buffer. A SharedArrayBuffer can never be detached,
 * so there is no B-2 interaction here.
 */
function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  if (value === null || typeof value !== "object") return false;
  if (Object.prototype.toString.call(value) !== "[object SharedArrayBuffer]") return false;
  try {
    return new Uint8Array(value as SharedArrayBuffer).buffer === value;
  } catch {
    return false;
  }
}

function toBytes(data: string | Uint8Array | ArrayBuffer | SharedArrayBuffer): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  // ArrayBuffer bodies (e.g. `await res.arrayBuffer()`) are a natural
  // way to hand a fetched upstream body to verification (J2 R3) — accept
  // them instead of silently failing the verification.
  if (isArrayBuffer(data)) return new Uint8Array(data);
  // A bare SharedArrayBuffer (J2 R6 M-3): WebCrypto rejects a view on
  // one with TypeError, so copy its bytes into a fresh ArrayBuffer.
  // The tag + identity check above keeps spoofs out, exactly as for
  // ArrayBuffer; a SharedArrayBuffer can never be detached, so the
  // B-2 fail-closed guarantee is untouched.
  if (isSharedArrayBuffer(data)) return new Uint8Array(data).slice();
  // ArrayBuffer.isView (not instanceof) — jsdom TextEncoder returns a
  // Uint8Array from another realm, which fails instanceof.
  if (ArrayBuffer.isView(data)) {
    // Detached-view check (J2 R5 B-2): a detached TypedArray/DataView
    // sails through the isView gate and WebCrypto silently hashes it
    // as ZERO bytes — a detached view of "hello" verified true against
    // the sha256("") digest (fail-open). A detached buffer is
    // detectable because constructing any view over it throws
    // TypeError, while a live buffer — even a zero-length one, or a
    // resizable buffer resized to 0 — constructs fine. So a throw
    // here means "detached", never "genuinely empty": an empty view
    // constructed with length 0 still verifies true vs the empty hash.
    // (Reading .byteLength would also throw for a detached DataView,
    // but returns 0 without throwing for a detached TypedArray, so
    // the constructor probe is the uniform detector.)
    try {
      new Uint8Array(data.buffer as ArrayBuffer);
    } catch {
      throw new TypeError("sha256Hex: cannot hash a view of a detached ArrayBuffer");
    }
    // SharedArrayBuffer-backed views (J2 R6 M-3): WebCrypto throws
    // TypeError for a view on a SharedArrayBuffer, so a SAB-backed
    // body could never verify even when the bytes matched — a false
    // negative. Copy the view's own bytes (byteOffset/byteLength, so
    // offset views and DataViews hash exactly their own bytes) into a
    // fresh ArrayBuffer. Only SAB-backed views copy: a plain
    // ArrayBuffer-backed view keeps the zero-copy path. The detached
    // probe above still runs first — a detached view throws before
    // any copy — so the B-2 guarantee is unchanged.
    if (Object.prototype.toString.call(data.buffer) === "[object SharedArrayBuffer]") {
      return new Uint8Array(
        new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
      );
    }
    return data as Uint8Array;
  }
  throw new TypeError("sha256Hex expects a string, Uint8Array or ArrayBuffer");
}

function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase().replace(/^0x/, "");
}

/** SHA-256 of `data`, returned 0x-prefixed to match receipt digests. */
export async function sha256Hex(
  data: string | Uint8Array | ArrayBuffer | SharedArrayBuffer,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "WebCrypto (crypto.subtle) is unavailable in this environment — cannot compute SHA-256",
    );
  }
  const digest = await subtle.digest("SHA-256", toBytes(data) as BufferSource);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}`;
}

/**
 * Recompute SHA-256 over the raw upstream response body and compare it
 * with `receipt.raw_response_sha256` (comparison ignores `0x` prefix and
 * case). Returns `{ verified, computedSha }`.
 *
 * Malformed input (null / non-object receipt, non-string recorded hash,
 * non-string / non-Uint8Array / non-ArrayBuffer / non-SharedArrayBuffer
 * body) returns `{ verified: false, computedSha: "" }` instead of throwing — a bad
 * receipt is a failed verification, not a crash. A detached view or
 * detached DataView body (J2 R5 B-2) is malformed the same way: it
 * returns `{ verified: false }` instead of throwing out of
 * subtle.digest (the old DataView path) or hashing zero bytes (the old
 * TypedArray path). The ONE exception is WebCrypto being unavailable:
 * sha256Hex still throws, because returning a verdict without a real
 * hash would be a fake result.
 */
export async function verifyReceipt(
  receipt: Receipt | null | undefined,
  rawBody: string | Uint8Array | ArrayBuffer | SharedArrayBuffer | null | undefined,
): Promise<ReceiptVerification> {
  // Check WebCrypto FIRST: unavailable crypto must throw even for
  // malformed input — never a silent verdict without a real hash.
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "WebCrypto (crypto.subtle) is unavailable in this environment — cannot compute SHA-256",
    );
  }
  if (
    receipt === null ||
    receipt === undefined ||
    typeof receipt !== "object" ||
    typeof receipt.raw_response_sha256 !== "string" ||
    (typeof rawBody !== "string" &&
      !ArrayBuffer.isView(rawBody) &&
      !isArrayBuffer(rawBody) &&
      !isSharedArrayBuffer(rawBody))
  ) {
    return { verified: false, computedSha: "" };
  }
  let computedSha: string;
  try {
    computedSha = await sha256Hex(rawBody);
  } catch (err) {
    // A hash that cannot be computed (detached view/DataView, or a
    // digest failure) is a failed verification, not a crash — EXCEPT
    // missing WebCrypto, which must still throw (checked above, and
    // re-checked here in case subtle vanished mid-call).
    if (!globalThis.crypto?.subtle) throw err;
    return { verified: false, computedSha: "" };
  }
  const recorded = normalizeHash(receipt.raw_response_sha256);
  return {
    verified: recorded.length > 0 && normalizeHash(computedSha) === recorded,
    computedSha,
  };
}
