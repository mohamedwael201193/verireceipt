// THE ONE receipt verifier (PLAN.md C2).
//
// This module is THE ONE receipt verifier (PLAN.md C2): every call
// site (Receipts VerifyPanel, ReceiptDrawer recompute, landing
// VerifyBadge) calls verifyReceipt() here. lib/verify.ts is the hash-
// primitive attack suite, not a UI verifier. pages/landing/verify.ts
// (envelope-digest, which can never match) has been deleted.
//
// How it verifies, in order:
//   1. RAW BYTES FIRST: GET /api/receipts/:id/raw (same-origin; the
//      Vercel rewrite proxies it to the miner) as an ArrayBuffer, SHA-256
//      it with WebCrypto, compare with the receipt's recorded
//      raw_response_sha256. The miner hashed exactly those bytes when it
//      minted the receipt, so a match here is a real verification — for
//      every endpoint, including route (the stored bytes ARE the quoter
//      request/response the miner hashed) and grid (the stored bytes are
//      whatever the miner hashed — the canonical evidence JSON, NOT the
//      CAISO zip; see the grid note below).
//   2. LIVE RE-CHECK FALLBACK: if /raw is unavailable (non-OK), the
//      per-endpoint live re-check runs instead, labelled mode
//      "live_recheck": tx replays
//      the exact JSON-RPC call, grid re-hashes the canonical evidence
//      JSON, filings/tvl re-fetch the upstream URL. Route has no live
//      re-check (the API response does not carry the quoter bytes) and
//      returns not-reproducible until /raw lands.
//   The result always says WHICH path was used (mode + method, and the
//   X-Evidence-Kind response header when the miner sends one), because
//   a raw_bytes mismatch and a live_recheck mismatch mean different
//   things: the first says the stored bytes do not hash to the recorded
//   digest; the second says the upstream moved after the receipt was
//   issued (proven for DeFiLlama TVL) — neither by itself proves
//   tampering, and the UI must not conflate them.
//
// One shared deadline (default 45 s, the data-layer budget) covers the
// raw attempt AND the fallback — a hung upstream must never leave a
// "Verifying…" stuck, and a second 45 s budget on the fallback would
// double the worst case. An outer AbortSignal (Cancel button, new
// receipt, unmount) aborts the same controller and returns "cancelled"
// so the caller can go back to idle; a fired deadline returns
// "unverifiable" with a timeout reason. WebCrypto unavailable returns
// "no-crypto" — verification refuses, never a fake hash (no FNV-1a
// fallback, DESIGN-SPEC §8 A16/A19).
//
// Grid bytes semantics (do not "fix" by re-pointing blindly): the miner
// hashed JSON.stringify({node_or_zone, interval_start, lmp_usd_per_mwh,
// market}) built from the answer fields (src/handlers/gridPrice.ts) —
// NOT the CAISO zip bytes. So if the miner's /raw serves the zip, a
// raw_bytes grid check would MISMATCH a receipt that the live re-check
// MATCHes. The raw path is correct only when the miner stores the exact
// bytes it hashed; per-intent stored-bytes semantics must be confirmed
// with the miner team (C1) before treating a raw grid mismatch as a
// failed receipt.

import { sha256Hex } from "./receipt";
import { isSafeUpstreamUrl } from "../components/ReceiptCard";
import type { SessionReceiptEndpoint } from "./sessionReceipts";
import type { Receipt } from "./types";

export type VerifyEndpoint = SessionReceiptEndpoint;

export type VerifyMode = "raw_bytes" | "live_recheck" | "not_applicable";

export type VerifyResult =
  | {
      kind: "verified";
      computed: string;
      method: string;
      mode: "raw_bytes" | "live_recheck";
      evidenceKind?: string;
    }
  | {
      kind: "mismatch";
      computed: string;
      method: string;
      mode: "raw_bytes" | "live_recheck";
      evidenceKind?: string;
    }
  | { kind: "unverifiable"; reason: string; mode: VerifyMode }
  | { kind: "not-reproducible"; reason: string; mode: "not_applicable" }
  | { kind: "cancelled"; mode: "not_applicable" }
  | { kind: "no-crypto"; mode: "not_applicable" };

/** Fields the live re-check reads from a full response envelope (try-it
 *  results) or from a stored receipt's verifyData (ledger rows). */
export interface VerifyData extends Record<string, unknown> {
  tx_hash?: unknown;
  node_or_zone?: unknown;
  interval_start?: unknown;
  lmp_usd_per_mwh?: unknown;
  market?: unknown;
}

export interface VerifyOptions {
  /** Outer abort (Cancel button, new receipt, unmount). */
  signal?: AbortSignal;
  /** Shared deadline for the raw attempt + the live re-check. */
  timeoutMs?: number;
}

/** Same 45 s budget as the data path (lib/api.ts): cold starts on the
 *  free tier are documented at 25–56 s, so a shorter budget would time
 *  the check out on every cold start. */
export const VERIFY_TIMEOUT_MS = 45_000;

/** Same-origin raw-bytes URL (Vercel rewrites /api/* to the miner). */
export function rawReceiptUrl(receiptId: string): string {
  return `/api/receipts/${encodeURIComponent(receiptId)}/raw`;
}

const INTENT_TO_ENDPOINT: Record<string, SessionReceiptEndpoint> = {
  ONCHAIN_TX_LOOKUP_GENERAL: "tx",
  REGULATORY_FILING_MONITOR_GENERAL: "filings",
  TVL_LOOKUP_GENERAL: "tvl",
  OPTIMAL_EXECUTION_ROUTE_GENERAL: "route",
  GRID_POWER_PRICE_GENERAL: "grid",
  VALIDATOR_PERFORMANCE_VERIFY_GENERAL: "validator",
  // Short landing keys (pages/landing/*) map to the same endpoints.
  tx: "tx",
  sec: "filings",
  filings: "filings",
  tvl: "tvl",
  route: "route",
  grid: "grid",
  validator: "validator",
};

export function endpointForIntent(intent: string): SessionReceiptEndpoint | undefined {
  return INTENT_TO_ENDPOINT[intent];
}

function normaliseHash(hash: string): string {
  return hash.trim().toLowerCase().replace(/^0x/, "");
}

function timeoutReason(timeoutMs: number): string {
  return (
    `Verification timed out after ${timeoutMs / 1000}s — the raw endpoint ` +
    `and the live re-check did not answer in time. Try again, or verify from a terminal with curl.`
  );
}

export function verifyMethodNote(endpoint: SessionReceiptEndpoint): string {
  const raw =
    "Fetches the stored raw bytes for this receipt (/api/receipts/:id/raw) and hashes them. ";
  if (endpoint === "tx") {
    return (
      raw +
      "If stored raw bytes are not served, replays the miner's exact JSON-RPC call instead — POST eth_getTransactionReceipt to the receipt's upstream RPC URL — and hashes the exact response text."
    );
  }
  if (endpoint === "grid") {
    return (
      raw +
      "If stored raw bytes are not served, re-hashes the canonical evidence JSON the miner hashed: JSON.stringify({node_or_zone, interval_start, lmp_usd_per_mwh, market}). (The CAISO zip bytes are NOT what was hashed, so re-fetching the zip can never match.)"
    );
  }
  if (endpoint === "route") {
    return (
      raw +
      "The stored bytes ARE the quoter request/response the miner hashed, so this becomes verifiable once the miner serves them. If they are not served, this receipt cannot be re-hashed in the browser — the API response does not carry the raw quoter bytes."
    );
  }
  return (
    raw +
    "If stored raw bytes are not served, re-fetches the receipt's upstream URL and hashes the exact bytes. Verified only on a match."
  );
}

type RawAttempt =
  | { outcome: "compared"; result: VerifyResult }
  | { outcome: "unavailable" }
  | { outcome: "error" }
  | { outcome: "aborted" };

async function tryRawBytes(
  receipt: Receipt,
  signal: AbortSignal,
): Promise<RawAttempt> {
  let res: Response;
  try {
    res = await fetch(rawReceiptUrl(receipt.receipt_id), { signal });
  } catch {
    return signal.aborted ? { outcome: "aborted" } : { outcome: "error" };
  }
  // Any non-OK status means the miner does not serve /raw (yet) — fall
  // through to the live re-check, do not verdict on it.
  if (!res.ok) return { outcome: "unavailable" };
  try {
    const computed = await sha256Hex(new Uint8Array(await res.arrayBuffer()));
    // Display-only: a contradictory or spoofed value cannot change
    // the verdict.
    const evidenceKind = res.headers.get("x-evidence-kind") ?? undefined;
    // Computed is shown 0x-prefixed (the recorded digest's format);
    // the comparison normalises both sides, so the prefix is display.
    const shown = `0x${computed}`;
    const result: VerifyResult = normaliseHash(computed) === normaliseHash(receipt.raw_response_sha256)
      ? {
          kind: "verified",
          computed: shown,
          method: "Stored raw bytes",
          mode: "raw_bytes",
          ...(evidenceKind ? { evidenceKind } : {}),
        }
      : {
          kind: "mismatch",
          computed: shown,
          method: "Stored raw bytes",
          mode: "raw_bytes",
          ...(evidenceKind ? { evidenceKind } : {}),
        };
    return { outcome: "compared", result };
  } catch {
    return signal.aborted ? { outcome: "aborted" } : { outcome: "error" };
  }
}

type FallbackAttempt = { outcome: "done"; result: VerifyResult } | { outcome: "aborted" };

async function liveRecheck(
  receipt: Receipt,
  endpoint: SessionReceiptEndpoint,
  data: VerifyData | undefined,
  signal: AbortSignal,
): Promise<FallbackAttempt> {
  // --- /v1/route: evidence not carried by the API response. ---
  if (endpoint === "route") {
    return {
      outcome: "done",
      result: {
        kind: "not-reproducible",
        reason:
          "The receipt hash covers the winning quoter's raw request/response at the pinned block (src/handlers/optimalRoute.ts), which the API response does not carry — so this receipt cannot be independently re-hashed in the browser.",
        mode: "not_applicable",
      },
    };
  }

  // --- /v1/grid-price: canonical evidence re-hash (proven MATCH live). ---
  if (endpoint === "grid") {
    const node = data?.node_or_zone;
    const interval = data?.interval_start;
    const lmp = data?.lmp_usd_per_mwh;
    const market = data?.market;
    if (
      typeof node !== "string" ||
      typeof interval !== "string" ||
      typeof lmp !== "number" ||
      typeof market !== "string"
    ) {
      return {
        outcome: "done",
        result: {
          kind: "unverifiable",
          reason:
            "The grid evidence fields (node_or_zone, interval_start, lmp_usd_per_mwh, market) are missing from this record, so the canonical evidence JSON cannot be rebuilt.",
          mode: "live_recheck",
        },
      };
    }
    try {
      const canonical = JSON.stringify({
        node_or_zone: node,
        interval_start: interval,
        lmp_usd_per_mwh: lmp,
        market,
      });
      const computed = await sha256Hex(canonical);
      if (normaliseHash(computed) === normaliseHash(receipt.raw_response_sha256)) {
        return {
          outcome: "done",
          result: {
            kind: "verified",
            computed: `0x${computed}`,
            method: "Canonical evidence re-hash (live re-check)",
            mode: "live_recheck",
          },
        };
      }
      return {
        outcome: "done",
        result: {
          kind: "mismatch",
          computed: `0x${computed}`,
          method: "Canonical evidence re-hash (live re-check)",
          mode: "live_recheck",
        },
      };
    } catch (err) {
      return {
        outcome: "done",
        result: {
          kind: "unverifiable",
          reason: `Canonical re-hash failed: ${err instanceof Error ? err.message : "unknown error"}`,
          mode: "live_recheck",
        },
      };
    }
  }

  // --- /v1/tx: exact JSON-RPC replay (proven MATCH live). ---
  if (endpoint === "tx") {
    const txHash = data?.tx_hash;
    if (typeof txHash !== "string" || !txHash) {
      return {
        outcome: "done",
        result: {
          kind: "unverifiable",
          reason:
            "The transaction hash is missing from this record, so the JSON-RPC call cannot be replayed.",
          mode: "live_recheck",
        },
      };
    }
    if (!isSafeUpstreamUrl(receipt.upstream_url)) {
      return {
        outcome: "done",
        result: {
          kind: "unverifiable",
          reason:
            "The receipt's upstream URL is not a safe https URL, so the replay was refused — nothing was fetched. (A data:, http:, or otherwise unsafe upstream can never verify.)",
          mode: "live_recheck",
        },
      };
    }
    try {
      const res = await fetch(receipt.upstream_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [txHash],
        }),
        signal,
      });
      if (!res.ok) {
        return {
          outcome: "done",
          result: {
            kind: "unverifiable",
            reason: `RPC replay returned HTTP ${res.status} — the hash was not checked, not confirmed.`,
            mode: "live_recheck",
          },
        };
      }
      const computed = await sha256Hex(new Uint8Array(await res.arrayBuffer()));
      if (normaliseHash(computed) === normaliseHash(receipt.raw_response_sha256)) {
        return {
          outcome: "done",
          result: {
            kind: "verified",
            computed: `0x${computed}`,
            method: "JSON-RPC replay (live re-check)",
            mode: "live_recheck",
          },
        };
      }
      return {
        outcome: "done",
        result: {
          kind: "mismatch",
          computed: `0x${computed}`,
          method: "JSON-RPC replay (live re-check)",
          mode: "live_recheck",
        },
      };
    } catch (err) {
      if (signal.aborted) return { outcome: "aborted" };
      const msg = err instanceof Error ? err.message : "fetch failed";
      return {
        outcome: "done",
        result: {
          kind: "unverifiable",
          reason:
            /Failed to fetch|NetworkError|CORS|blocked/i.test(msg) || err instanceof TypeError
              ? "RPC replay was blocked by the browser (CORS / network) — the hash was not checked, not confirmed."
              : `RPC replay failed: ${msg} — the hash was not checked, not confirmed.`,
          mode: "live_recheck",
        },
      };
    }
  }

  // --- /v1/filings + /v1/tvl: upstream GET re-fetch. ---
  if (!isSafeUpstreamUrl(receipt.upstream_url)) {
    return {
      outcome: "done",
      result: {
        kind: "unverifiable",
        reason:
          "The receipt's upstream URL is not a safe https URL, so the re-fetch was refused — nothing was fetched. (A data:, http:, or otherwise unsafe upstream can never verify.)",
        mode: "live_recheck",
      },
    };
  }
  try {
    const res = await fetch(receipt.upstream_url, { signal });
    if (!res.ok) {
      return {
        outcome: "done",
        result: {
          kind: "unverifiable",
          reason: `Upstream re-fetch returned HTTP ${res.status} — the hash was not checked, not confirmed.`,
          mode: "live_recheck",
        },
      };
    }
    const computed = await sha256Hex(new Uint8Array(await res.arrayBuffer()));
    if (normaliseHash(computed) === normaliseHash(receipt.raw_response_sha256)) {
      return {
        outcome: "done",
        result: {
          kind: "verified",
          computed: `0x${computed}`,
          method: "Upstream re-fetch (live re-check)",
          mode: "live_recheck",
        },
      };
    }
    return {
      outcome: "done",
      result: {
        kind: "mismatch",
        computed: `0x${computed}`,
        method: "Upstream re-fetch (live re-check)",
        mode: "live_recheck",
      },
    };
  } catch (err) {
    if (signal.aborted) return { outcome: "aborted" };
    const msg = err instanceof Error ? err.message : "fetch failed";
    return {
      outcome: "done",
      result: {
        kind: "unverifiable",
        reason:
          /Failed to fetch|NetworkError|CORS|blocked/i.test(msg) || err instanceof TypeError
            ? "Upstream fetch was blocked by the browser (CORS / network) — the hash was not checked, not confirmed."
            : `Upstream re-fetch failed: ${msg} — the hash was not checked, not confirmed.`,
        mode: "live_recheck",
      },
    };
  }
}

/**
 * THE ONE receipt verifier. Tries the stored raw bytes first
 * (/api/receipts/:id/raw), falls back to the per-endpoint live re-check
 * when /raw is unavailable. Never throws
 * for a verification outcome — every outcome is a returned result
 * (verified / mismatch / unverifiable / not-reproducible / cancelled /
 * no-crypto). The caller renders result.mode + result.method so the
 * user can see exactly what was compared.
 */
export async function verifyReceipt(
  receipt: Receipt,
  endpoint: SessionReceiptEndpoint,
  data?: VerifyData,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  // WebCrypto is checked first on purpose: an unavailable WebCrypto
  // must refuse loudly even before any fetch.
  if (!globalThis.crypto?.subtle) {
    return { kind: "no-crypto", mode: "not_applicable" };
  }
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const controller = new AbortController();
  // A plain flag (not signal.reason instanceof DOMException): the reason
  // can come from another realm, where instanceof fails — the flag is
  // set only by this timer, so it cannot misclassify a cancel.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    if (opts.signal?.aborted) return { kind: "cancelled", mode: "not_applicable" };
    const signal = controller.signal;

    const raw = await tryRawBytes(receipt, signal);
    if (raw.outcome === "compared") return raw.result;
    if (raw.outcome === "aborted") {
      if (timedOut) {
        return { kind: "unverifiable", reason: timeoutReason(timeoutMs), mode: "raw_bytes" };
      }
      return { kind: "cancelled", mode: "not_applicable" };
    }
    // Raw unavailable (404) or errored (network): fall through to the
    // live re-check — unless the deadline already fired, in which case
    // the fallback fetches would abort instantly anyway.
    if (signal.aborted) {
      if (timedOut) {
        return { kind: "unverifiable", reason: timeoutReason(timeoutMs), mode: "raw_bytes" };
      }
      return { kind: "cancelled", mode: "not_applicable" };
    }

    const fallback = await liveRecheck(receipt, endpoint, data, signal);
    if (fallback.outcome === "aborted") {
      if (timedOut) {
        return { kind: "unverifiable", reason: timeoutReason(timeoutMs), mode: "live_recheck" };
      }
      return { kind: "cancelled", mode: "not_applicable" };
    }
    return fallback.result;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}
