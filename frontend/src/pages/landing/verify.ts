// Real receipt verification (DESIGN-SPEC §8 A16/A19, parent decision).
//
// The design's "MATCH VERIFIED ✓" was self-referential: it hashed a canned
// string, so it always passed. The real check fetches the miner endpoint
// as raw text, recomputes SHA-256 over those exact bytes with WebCrypto,
// and compares with the receipt's `raw_response_sha256` from the SAME
// response. "Verified" is shown ONLY on a byte-exact match.
//
// Honest limitation (verified against the miner source + live API): the
// miner's `raw_response_sha256` covers the UPSTREAM raw response bytes
// (src/core/receipt.ts `makeReceipt`), not the miner's envelope — so the
// digest of the envelope the browser receives is NOT expected to equal
// the recorded digest. A mismatch therefore does NOT mean the receipt is
// bad; it means the browser cannot see the upstream bytes. The UI states
// this plainly and never shows a match it does not have. If the miner
// later exposes the raw upstream bytes, this same helper verifies them.
//
// No FNV-1a fallback: if WebCrypto is unavailable, verification refuses
// with an error instead of displaying a fake SHA-256.

import { ApiError } from "../../lib/api";
import { sha256Hex, verifyReceipt } from "../../lib/receipt";

export type VerifyState =
  | { status: "idle" }
  | { status: "running" }
  | {
      status: "done";
      /** SHA-256 of the response body as received by this browser. */
      computedDigest: string;
      /** Receipt's recorded digest, as returned by the miner. */
      recordedDigest: string;
      match: boolean;
      receiptId: string;
    }
  | { status: "no-receipt"; detail: string }
  | { status: "error"; message: string };

export interface VerifiedFetch<T> {
  data: T;
  verify: VerifyState;
}

// Same 45 s budget as the data path (lib/api.ts): cold starts on the
// free tier are documented at 25–56 s (J2 measured 25 s, 34 s, 39–42 s,
// 56 s), so the old 20 s budget made the badge time out on every cold
// start while the IDE data beside it loaded fine.
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Fetch a same-origin /api URL as raw text, parse it, and verify the
 * receipt it carries against the SHA-256 of the exact bytes received.
 * Throws ApiError on HTTP errors / timeouts / network failure.
 */
export async function fetchAndVerify<T>(url: string): Promise<VerifiedFetch<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const rawText = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = body as { error?: string; code?: string; message?: string } | null;
      const message =
        err?.message ?? err?.error ?? `Request failed with status ${res.status}`;
      throw new ApiError(message, res.status, err?.code);
    }
    const data = body as T;
    const receipt = (body as { receipt?: { receipt_id?: string; raw_response_sha256?: string } } | null)?.receipt;
    if (!receipt?.raw_response_sha256 || !receipt?.receipt_id) {
      return {
        data,
        verify: {
          status: "no-receipt",
          detail: "This response carries no receipt to verify.",
        },
      };
    }
    const computedDigest = await sha256Hex(rawText);
    const match = await verifyReceipt(rawText, receipt.raw_response_sha256);
    return {
      data,
      verify: {
        status: "done",
        computedDigest,
        recordedDigest: receipt.raw_response_sha256,
        match,
        receiptId: receipt.receipt_id,
      },
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`, 0, "TIMEOUT");
    }
    if (err instanceof Error) throw new ApiError(err.message, 0, "NETWORK_ERROR");
    throw new ApiError("Unknown request failure", 0, "UNKNOWN");
  } finally {
    clearTimeout(timer);
  }
}

/** Verify only (no data needed): fetch + hash + compare, same response. */
export async function verifyEndpoint(url: string): Promise<VerifyState> {
  try {
    const { verify } = await fetchAndVerify<unknown>(url);
    return verify;
  } catch (err) {
    if (err instanceof ApiError) {
      return { status: "error", message: err.message };
    }
    if (err instanceof Error) return { status: "error", message: err.message };
    return { status: "error", message: String(err) };
  }
}
