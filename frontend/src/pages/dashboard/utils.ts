// Pure helpers for the dashboard. No network, no canned data.

import { useEffect, useRef, type RefObject } from "react";
import { ApiError } from "../../lib/api";
import type { LiveReceipt, ProbeOutcome, Receipt } from "./types";

/** Live miner origin (the /api proxy rewrites to this in dev and production). */
export const MINER_ORIGIN = "https://verireceipt.onrender.com";
/** Verified on-chain registration bond (DESIGN-SPEC §8 A3). */
export const MINER_BOND_USDC = "$1.40 Test USDC";
export const DIAMOND_ADDRESS = "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b";
export const DIAMOND_SHORT = "0x72a70e…a08b";

export function shortHash(h: string | null | undefined): string {
  if (!h || h.length < 16) return h || "—";
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

export function shortAddr(a: string | null | undefined): string {
  if (!a) return "—";
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return usd0.format(v);
}

export function formatUsdPrecise(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return usd2.format(v);
}

/** 1.7418 ETH — up to 6 decimals, trailing zeros trimmed; accepts the API's string|number. */
export function formatEth(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (Number.isNaN(n)) return "—";
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  return `${Math.round(ms)}ms`;
}

/** ISO timestamp -> "20 Nov 2026, 07:37 UTC" (UTC, deterministic). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hh}:${mm} UTC`;
}

/** "HH:MM:SS" UTC clock. */
export function utcClock(d = new Date()): string {
  return d.toISOString().slice(11, 19);
}

/** Relative age ("42s ago", "3m ago") from an ISO timestamp, or "—". */
export function relativeAge(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * A grid interval the live API accepts: 2 hours ago, floored to the hour,
 * ISO-8601 UTC with millis. Past intervals are settled; future ones 422.
 */
export function recentGridInterval(now = new Date()): string {
  const d = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/** A future grid interval (used by the 422 refusal probe / benchmark F01). */
export function futureGridInterval(): string {
  const d = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * Run one live API call and measure real browser-side latency.
 * Never fabricates: a timeout / network failure is returned as an outcome
 * with status 0, never as a fake 200.
 *
 * The optional AbortSignal is passed through to the fetcher, which must
 * forward it to the underlying get* call: a cancelled run (Cancel button
 * or unmount) aborts the in-flight fetch instead of letting it settle
 * into state afterwards. A fetcher that ignores the signal still works —
 * the caller guards onRecord/setState with the run token — but every
 * built-in fetcher forwards it.
 */
export async function probe<T>(
  fetcher: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const start = performance.now();
  try {
    const body = (await fetcher(signal)) as unknown;
    const latencyMs = performance.now() - start;
    const receipt =
      body !== null && typeof body === "object" && "receipt" in body
        ? ((body as { receipt?: unknown }).receipt as Receipt | null) ?? null
        : null;
    return { ok: true, body, receipt, latencyMs };
  } catch (err) {
    const latencyMs = performance.now() - start;
    if (err instanceof ApiError) {
      // Surface a server-advised retry delay when the API sent one (the
      // 422 refusal cases assert on retry_after_sec — dropping it here
      // made F01 unpassable even when the live API answered correctly).
      const body: Record<string, unknown> = { error: err.code ?? "request_failed", message: err.message };
      if (err.retry_after_sec !== undefined) body.retry_after_sec = err.retry_after_sec;
      return {
        ok: false,
        body,
        latencyMs,
        status: err.status,
        errorCode: err.code,
        errorMessage: err.message,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      body: { error: "request_failed", message },
      latencyMs,
      status: 0,
      errorCode: "NETWORK_ERROR",
      errorMessage: message,
    };
  }
}

/** Session ledger cap: keep the latest 200 receipts, drop older ones. */
export const LEDGER_CAP = 200;

/** Prepend one receipt to the session ledger, enforcing the cap. */
export function appendToLedger(prev: LiveReceipt[], next: LiveReceipt): LiveReceipt[] {
  return [next, ...prev].slice(0, LEDGER_CAP);
}

let refusalSeq = 0;
let liveReceiptSeq = 0;

/**
 * Build a session-ledger row from a probe outcome.
 *
 * The row key is client-generated (a per-session counter + the server
 * receipt_id): the server receipt_id alone must never be a React key —
 * two calls can legitimately share one receipt_id (e.g. the same
 * not_found answer), which duplicates keys and drops rows.
 */
export function toLiveReceipt(
  intent: string,
  query: string,
  requestUrl: string,
  outcome: ProbeOutcome,
): LiveReceipt {
  liveReceiptSeq += 1;
  if (outcome.ok) {
    const receipt = outcome.receipt;
    const serverId = receipt ? receipt.receipt_id : null;
    return {
      key: `lr-${liveReceiptSeq}-${serverId ?? "ok"}`,
      id: serverId ?? `ok-${Date.now().toString(36)}`,
      ts: receipt ? receipt.fetched_at : new Date().toISOString(),
      intent,
      query,
      requestUrl,
      status: 200,
      latencyMs: outcome.latencyMs,
      body: outcome.body,
      receipt,
    };
  }
  refusalSeq += 1;
  return {
    key: `lr-${liveReceiptSeq}-refusal-${refusalSeq}`,
    id: `refusal-${Date.now().toString(36)}-${refusalSeq}`,
    ts: new Date().toISOString(),
    intent,
    query,
    requestUrl,
    status: outcome.status,
    latencyMs: outcome.latencyMs,
    body: outcome.body,
    receipt: null,
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
  };
}

/** Median of measured latencies, or null when there are no samples. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** p95 of measured latencies, or null when there are no samples. */
export function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/**
 * SHA-256 of raw bytes via Web Crypto. Returns null when Web Crypto is
 * unavailable — callers must show an error, never a fallback fake hash
 * (DESIGN-SPEC §8 A19).
 */
export async function sha256Hex(data: ArrayBuffer | string): Promise<string | null> {
  try {
    if (!window.crypto?.subtle || !window.TextEncoder) return null;
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    const digest = await window.crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return (
      "0x" +
      Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
  } catch {
    return null;
  }
}

/** Copy text with the design's textarea fallback; returns whether it worked. */
export function copyText(str: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

/** Download a text blob (ledger JSONL export). */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Escape + syntax-highlight a JSON value for the drawer viewer. */
export function highlightJson(value: unknown): string {
  const s = JSON.stringify(value, null, 2)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return s.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (m) => {
      let c = "jn";
      if (/^"/.test(m)) c = /:$/.test(m) ? "jk" : "js";
      else if (/true|false/.test(m)) c = "jb";
      else if (/null/.test(m)) c = "j0";
      return `<span class="${c}">${m}</span>`;
    },
  );
}

/** Build the direct (non-proxied) Render URL for a GET endpoint call. */
export function directUrl(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `${MINER_ORIGIN}${path}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Drawer accessibility (shared by AuthDrawer + ReceiptDrawer).
// ---------------------------------------------------------------------------

/**
 * Drawer focus management: when the drawer opens, move focus into it;
 * when it closes, return focus to whatever had it before. The drawer
 * element itself must carry tabIndex={-1} so it is focusable but not in
 * the tab order, and inert={!open} so a closed (off-canvas) drawer is
 * not tabbable at all.
 */
export function useDrawerFocus(open: boolean, panelRef: RefObject<HTMLElement | null>): void {
  const previousFocus = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const prev = previousFocus.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open, panelRef]);
}