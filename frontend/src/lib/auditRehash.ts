// Browser re-hash against the MINER'S STORED raw bytes.
//
// This is the Desk's receipt re-hash: fetch the exact bytes the miner
// hashed at fetch time from its audit endpoint
// (GET /receipts/:id/raw — see CONTRACT.md at the repo root) and
// recompute SHA-256 over them with WebCrypto, comparing with the
// receipt's recorded `raw_response_sha256`.
//
// This is deliberately NOT the upstream re-fetch in Receipts.tsx's
// VerifyPanel: live upstreams (DeFiLlama, SEC EDGAR) return fresh data
// on every fetch, so a re-fetch hash legitimately differs from the
// fetch-time hash and a mismatch there proves nothing about the
// receipt. Only the stored bytes can prove MATCH or MISMATCH.
//
// Honest states — there is no silent pass:
//   - "match" / "mismatch": the audit endpoint served bytes and the
//     hash was (or was not) equal to the recorded digest. Both hashes
//     are returned so the UI can show them.
//   - "unavailable": the audit endpoint is not deployed yet (404), the
//     receipt is malformed, or the fetch failed. An unavailable audit
//     endpoint is NEVER reported as a mismatch — the re-hash story is
//     simply unproven until the miner ships the contract.

import { verifyReceipt } from "./verify";
import type { Receipt } from "./types";

export type AuditRehashStatus = "match" | "mismatch" | "unavailable";

export interface AuditRehashResult {
  status: AuditRehashStatus;
  /** 0x-prefixed lowercase hex SHA-256 of the fetched bytes ("" when unavailable). */
  computedSha: string;
  /** The receipt's recorded digest, as recorded ("" when the receipt is malformed). */
  recordedSha: string;
  /** The audit URL that was fetched ("" when none could be derived). */
  auditRawUrl: string;
  /** Human-readable explanation — what was checked, or what is missing. */
  reason: string;
}

export const RECEIPT_ID_RE = /^rcpt_[A-Z0-9]{26}$/;

/**
 * Derive the audit raw-bytes URL for a receipt.
 *
 * The receipt's own `audit_url` (e.g.
 * https://verireceipt.onrender.com/receipts/rcpt_…) names the miner
 * origin; the raw bytes live at that origin under
 * /receipts/<receipt_id>/raw. A `baseUrl` override exists for tests and
 * for a Desk pointed at a non-default miner origin. Only https origins
 * are accepted — an http: or non-URL audit_url can never verify.
 * Returns "" when no safe URL can be derived.
 */
export function auditRawUrl(receipt: Receipt | null | undefined, baseUrl?: string): string {
  if (
    receipt === null ||
    receipt === undefined ||
    typeof receipt !== "object" ||
    typeof receipt.receipt_id !== "string" ||
    !RECEIPT_ID_RE.test(receipt.receipt_id)
  ) {
    return "";
  }
  let origin = "";
  if (typeof baseUrl === "string" && baseUrl.length > 0) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === "https:") origin = parsed.origin;
    } catch {
      origin = "";
    }
  } else if (typeof receipt.audit_url === "string") {
    try {
      const parsed = new URL(receipt.audit_url);
      if (parsed.protocol === "https:") origin = parsed.origin;
    } catch {
      origin = "";
    }
  }
  if (!origin) return "";
  return `${origin}/receipts/${receipt.receipt_id}/raw`;
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * How long the audit fetch may take before it fails closed as
 * UNAVAILABLE. A hung /raw must never leave the control stuck on
 * "Verifying…" forever: the abort fires at this budget, and the race
 * below is the backstop for a fetch implementation that ignores the
 * signal. 30s: the audit endpoint serves stored bytes (no slow
 * upstream), so a longer budget buys nothing.
 */
export const AUDIT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Re-hash a receipt against the miner's stored raw bytes.
 *
 * - audit endpoint 404 → "unavailable": the miner has not shipped the
 *   audit contract yet (the live state as of 2026-11-20). This is a
 *   missing proof, not a failed receipt.
 * - any other non-OK status / fetch failure / timeout → "unavailable" with the
 *   reason, never a verdict without bytes. A fetch that hangs past
 *   AUDIT_FETCH_TIMEOUT_MS surfaces as UNAVAILABLE (timeout), never a
 *   stuck control.
 * - bytes served → SHA-256 over exactly those bytes, compared with the
 *   recorded digest: "match" or "mismatch", with both hashes. Zero
 *   bytes served never match — not even against sha256("").
 */
export async function rehashFromAudit(
  receipt: Receipt | null | undefined,
  fetchImpl: FetchLike = fetch,
  baseUrl?: string,
): Promise<AuditRehashResult> {
  const recordedSha =
    receipt !== null &&
    receipt !== undefined &&
    typeof receipt === "object" &&
    typeof receipt.raw_response_sha256 === "string"
      ? receipt.raw_response_sha256
      : "";
  const url = auditRawUrl(receipt, baseUrl);
  if (!url) {
    return {
      status: "unavailable",
      computedSha: "",
      recordedSha,
      auditRawUrl: "",
      reason:
        "No audit URL could be derived for this receipt (missing or malformed receipt_id / audit_url) — the stored bytes cannot be fetched, so the hash was not checked.",
    };
  }
  if (!recordedSha) {
    return {
      status: "unavailable",
      computedSha: "",
      recordedSha: "",
      auditRawUrl: url,
      reason:
        "The receipt carries no recorded raw_response_sha256 — there is nothing to compare the recomputed hash against.",
    };
  }
  let res: { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> };
  // Timeout + abort: the audit endpoint serves stored bytes, so 30s is
  // generous. The AbortController fires at the budget; the race is the
  // backstop for a fetch implementation that ignores the signal — the
  // call can never hang the control past the budget either way.
  //
  // Round-3 F3: the SAME race must also bound res.arrayBuffer(). The
  // old code cleared the timer in the finally of the fetch race, then
  // awaited arrayBuffer() plain — a signal-ignoring fetch whose
  // arrayBuffer() never resolved left rehashFromAudit pending past its
  // 30s budget with no UNAVAILABLE. The timer is therefore cleared
  // only after the body read settles (finally of the whole block), and
  // the body read races the same timeout promise.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error(
    `Audit fetch timed out after ${AUDIT_FETCH_TIMEOUT_MS / 1000}s — the audit endpoint did not answer.`,
  );
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, AUDIT_FETCH_TIMEOUT_MS);
  });
  try {
    try {
      res = await Promise.race([fetchImpl(url, { signal: controller.signal }), timeout]);
    } catch (err) {
      return {
        status: "unavailable",
        computedSha: "",
        recordedSha,
        auditRawUrl: url,
        reason: `Audit fetch failed: ${err instanceof Error ? err.message : "network error"} — the hash was not checked, not confirmed.`,
      };
    }
    if (res.status === 404) {
      return {
        status: "unavailable",
        computedSha: "",
        recordedSha,
        auditRawUrl: url,
        reason:
          "Audit endpoint not available (HTTP 404): the miner has not shipped GET /receipts/:id/raw yet (see CONTRACT.md). The re-hash is unproven — not a mismatch.",
      };
    }
    if (!res.ok) {
      return {
        status: "unavailable",
        computedSha: "",
        recordedSha,
        auditRawUrl: url,
        reason: `Audit endpoint returned HTTP ${res.status} — the hash was not checked, not confirmed.`,
      };
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await Promise.race([res.arrayBuffer(), timeout]);
    } catch (err) {
      if (err === timeoutError) {
        return {
          status: "unavailable",
          computedSha: "",
          recordedSha,
          auditRawUrl: url,
          reason: `${timeoutError.message} — the hash was not checked, not confirmed.`,
        };
      }
      return {
        status: "unavailable",
        computedSha: "",
        recordedSha,
        auditRawUrl: url,
        reason: `Audit response could not be read: ${err instanceof Error ? err.message : "read error"} — the hash was not checked.`,
      };
    }
    // WebCrypto unavailable throws here (lib/verify.ts): a verdict without
    // a real hash would be fake, so the throw propagates to the caller.
    const { verified, computedSha } = await verifyReceipt(receipt as Receipt, bytes);
    // Empty bytes never MATCH — not even against sha256(""): a zero-byte
    // body is not a proof of anything.
    const match = bytes.byteLength > 0 && verified;
    return {
      status: match ? "match" : "mismatch",
      computedSha,
      recordedSha,
      auditRawUrl: url,
      reason:
        bytes.byteLength === 0
          ? "The audit endpoint served zero bytes — empty bytes never match a recorded digest."
          : match
            ? "SHA-256 of the miner's stored raw bytes equals the receipt's recorded digest."
            : "SHA-256 of the miner's stored raw bytes does NOT equal the receipt's recorded digest.",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
