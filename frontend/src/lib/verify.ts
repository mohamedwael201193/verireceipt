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

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase().replace(/^0x/, "");
}

/** SHA-256 of `data`, returned 0x-prefixed to match receipt digests. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
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
 */
export async function verifyReceipt(
  receipt: Receipt,
  rawBody: string | Uint8Array,
): Promise<ReceiptVerification> {
  const computedSha = await sha256Hex(rawBody);
  const recorded = normalizeHash(receipt.raw_response_sha256 ?? "");
  return {
    verified: recorded.length > 0 && normalizeHash(computedSha) === recorded,
    computedSha,
  };
}
