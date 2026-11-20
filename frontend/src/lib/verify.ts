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

function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  // ArrayBuffer bodies (e.g. `await res.arrayBuffer()`) are a natural
  // way to hand a fetched upstream body to verification (J2 R3) — accept
  // them instead of silently failing the verification.
  if (isArrayBuffer(data)) return new Uint8Array(data);
  // ArrayBuffer.isView (not instanceof) — jsdom TextEncoder returns a
  // Uint8Array from another realm, which fails instanceof.
  if (ArrayBuffer.isView(data)) return data as Uint8Array;
  throw new TypeError("sha256Hex expects a string, Uint8Array or ArrayBuffer");
}

function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase().replace(/^0x/, "");
}

/** SHA-256 of `data`, returned 0x-prefixed to match receipt digests. */
export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
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
 * non-string / non-Uint8Array / non-ArrayBuffer body) returns
 * `{ verified: false, computedSha: "" }` instead of throwing — a bad
 * receipt is a failed verification, not a crash. The ONE exception is
 * WebCrypto being unavailable: sha256Hex still throws, because returning
 * a verdict without a real hash would be a fake result.
 */
export async function verifyReceipt(
  receipt: Receipt | null | undefined,
  rawBody: string | Uint8Array | ArrayBuffer | null | undefined,
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
      !isArrayBuffer(rawBody))
  ) {
    return { verified: false, computedSha: "" };
  }
  const computedSha = await sha256Hex(rawBody);
  const recorded = normalizeHash(receipt.raw_response_sha256);
  return {
    verified: recorded.length > 0 && normalizeHash(computedSha) === recorded,
    computedSha,
  };
}
