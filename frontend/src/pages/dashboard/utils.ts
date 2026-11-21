// Pure helpers for the dashboard. No network, no canned data.

import { useEffect, useRef, type RefObject } from "react";
import { ApiError } from "../../lib/api";
import { MINER_BOND_USD_TEXT } from "../../lib/minerBond";
import {
  appendSessionReceipt,
  readLedgerGeneration,
  type SessionReceipt,
  type SessionReceiptEndpoint,
} from "../../lib/sessionReceipts";
import type { LiveReceipt, ProbeOutcome, Receipt } from "./types";

/** Live miner origin (the /api proxy rewrites to this in dev and production). */
export const MINER_ORIGIN = "https://verireceipt.onrender.com";
/** On-chain registration bond: minerBond(6152) = quoteMinerBond(6) (lib/minerBond.ts). */
export const MINER_BOND_USDC = `${MINER_BOND_USD_TEXT} Test USDC`;
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
  // The shared-ledger clear generation at probe start (J2 R6 cross-tab):
  // a Clear — in this tab or another — while this call is in flight must
  // drop its row instead of resurrecting it into the cleared ledger.
  const ledgerGenAtStart = readLedgerGeneration();
  const start = performance.now();
  try {
    const body = (await fetcher(signal)) as unknown;
    const latencyMs = performance.now() - start;
    const receipt =
      body !== null && typeof body === "object" && "receipt" in body
        ? ((body as { receipt?: unknown }).receipt as Receipt | null) ?? null
        : null;
    return { ok: true, body, receipt, latencyMs, ledgerGenAtStart };
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

/**
 * The ONE display predicate for "verified / OK" on RECEIPTED intents
 * (J2 R3 B-J2-1): a receipted call counts as verified only when HTTP
 * 200 arrived AND the lib minted a receipt for it. A bare 200 with no
 * receipt is a refusal — the lib fails it as ApiError INVALID_RESPONSE
 * carrying status 200 — and must never render as verified, OK,
 * answered, or a receipt age. Every display site for a receipted
 * endpoint that renders "200", "OK", "Verified", "Answered", or a
 * receipt age MUST key on this, never on status alone.
 *
 * Scope note (J1 R3 B-1): this predicate is for RECEIPTED intents only.
 * /health is non-receipted by contract (getHealth passes no
 * expectReceipt; HealthResponse has no receipt field), so a healthy
 * /health answers 200 {status:"ok"} with no receipt — that MUST render
 * ok via isHealthOk below, never "refused".
 */
export function isVerified(r: { status: number; receipt: Receipt | null }): boolean {
  return r.status === 200 && r.receipt !== null;
}

/**
 * The display predicate for /health ONLY (J1 R3 B-1): /health is a
 * non-receipted liveness endpoint by contract, so "ok" is HTTP 200
 * AND body.status === "ok" — no receipt is ever minted for it, and
 * requiring one called every healthy miner "refused". A 200 whose
 * body is not {status:"ok"} (e.g. the lib refused it as
 * INVALID_RESPONSE, status 200, error body) is NOT ok.
 */
export function isHealthOk(r: { status: number; body: unknown }): boolean {
  if (r.status !== 200) return false;
  const b = r.body as { status?: unknown } | null;
  return b !== null && typeof b === "object" && b.status === "ok";
}

/** Session ledger cap: keep the latest 200 receipts, drop older ones. */
export const LEDGER_CAP = 200;

/** Prepend one receipt to the session ledger, enforcing the cap. */
export function appendToLedger(prev: LiveReceipt[], next: LiveReceipt): LiveReceipt[] {
  return [next, ...prev].slice(0, LEDGER_CAP);
}

/**
 * Dashboard intent → /receipts ledger endpoint. Only the six receipted
 * intents map; /health, MCP probes and anything else have no receipt
 * block and are never written to the shared ledger (they stay in the
 * dashboard's own in-memory ledger only).
 */
const INTENT_TO_LEDGER_ENDPOINT: Record<string, SessionReceiptEndpoint> = {
  ONCHAIN_TX_LOOKUP_GENERAL: "tx",
  REGULATORY_FILING_MONITOR_GENERAL: "filings",
  TVL_LOOKUP_GENERAL: "tvl",
  OPTIMAL_EXECUTION_ROUTE_GENERAL: "route",
  GRID_POWER_PRICE_GENERAL: "grid",
  VALIDATOR_PERFORMANCE_VERIFY_GENERAL: "validator",
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function summaryFor(endpoint: SessionReceiptEndpoint, body: unknown, query?: string): string {
  const b = asRecord(body);
  const answer = b?.answer;
  // Live bodies always carry answer (filings J2 R5 N2): the filings
  // branch below is fallback-only, for an answer-less response.
  if (typeof answer === "string" && answer.length > 0) return answer;
  if (!b) return `${endpoint} — live call`;
  if (endpoint === "filings" && typeof b.filing_count === "number") {
    // The count carries its window (filings J1 R3 M1): read the entity
    // + period from the call's own query string (the dashboard filings
    // preset asks entity=AAPL&period=last 12 months) and omit the
    // window only if the call genuinely asked without one.
    // Shape first (filings J2 R6): the query is EITHER a real query
    // string ("entity=AAPL&period=last 12 months", from a parseable
    // requestUrl) OR the human-readable form ("AAPL · last 12
    // months", receipt.query when the URL is unparseable) — and the
    // two shapes must never be mixed. URLSearchParams decodes %3D to
    // `=` and splits on `&`, so parsing the human form as params
    // invents values: "AAPL · last 12 months&entity=MSFT" yields
    // entity MSFT from a trailing fragment, and "entity%3DAAPL · last
    // 12 months" yields a key the old guard could not see. A query
    // string is therefore only recognised when EVERY `&`-separated
    // segment is a key=value pair; anything else is the human form
    // and is parsed only as `entity · period`.
    const rawQuery = query ?? "";
    const isQueryString =
      rawQuery !== "" && rawQuery.split("&").every((seg) => seg.includes("="));
    const q = isQueryString ? new URLSearchParams(rawQuery) : null;
    let entity = q?.get("entity") ?? null;
    let period = q?.get("period") ?? null;
    if (!entity || !period) {
      // Fallback for the human-readable query form ("AAPL · last 12
      // months"): persistLiveReceiptToSessionLedger falls back to
      // receipt.query when requestUrl is unparseable, and that string
      // has no `=` pairs for URLSearchParams — without this, the
      // summary would render a bare count (filings J1/J2 R4 M1).
      // Parse it as `entity · period` instead.
      const parts = rawQuery
        .split("·")
        .map((s) => s.trim())
        .filter(Boolean);
      // Guard (filings J2 R5 N1 + J2 R6): the human form is exactly two
      // segments with no `=` — a segment containing `=` is a query
      // string fragment, not an entity/period, and filling from it
      // would silently misattribute the window (e.g. "period=last ·
      // 12 months" → entity "period=last"). The check covers the
      // percent-encoded form too: URLSearchParams decodes %3D to `=`,
      // so "foo%3Dbar" is the same fragment as "foo=bar" and is
      // rejected the same way. Anything else falls through to a bare
      // count — honest rather than wrong.
      if (
        parts.length === 2 &&
        !parts.some((p) => p.includes("=") || /%3d/i.test(p))
      ) {
        entity = entity ?? parts[0];
        period = period ?? parts[1];
      }
    }
    return `${b.filing_count} filings${entity ? ` · ${entity}` : ""}${period ? ` · ${period}` : ""}`;
  }
  if (endpoint === "tvl" && typeof b.tvl_usd === "number")
    return `TVL $${Number(b.tvl_usd).toLocaleString("en-US")}`;
  if (endpoint === "route" && b.amount_out !== undefined)
    return `amount_out ${String(b.amount_out)}`;
  if (endpoint === "grid" && b.lmp_usd_per_mwh !== undefined)
    return `LMP $${String(b.lmp_usd_per_mwh)}/MWh`;
  if (endpoint === "tx")
    return `status ${String(b.status ?? "—")}, block ${String(b.block_number ?? "—")}`;
  if (endpoint === "validator" && b.effective_balance !== undefined)
    return `effective_balance ${String(b.effective_balance)} gwei`;
  return `${endpoint} — live call`;
}

/**
 * Persist a dashboard LiveReceipt into the SHARED session ledger
 * (src/lib/sessionReceipts.ts) so it appears on /receipts after
 * navigation. Before this, dashboard receipts lived in React state only
 * and never reached the ledger — the /receipts page showed "0 receipts
 * this session" after a dashboard run despite promising the ledger
 * "survives navigation" (2026-11-20 browser click-test, defect 2).
 * Returns 'persisted' on success, 'skipped' when there is nothing
 * persistable (no receipt block, or an unmapped intent such as HEALTH),
 * or when the ledger was cleared — in this tab or another — while the
 * call was in flight (J2 R6 cross-tab: the row's ledgerGenAtStart
 * predates the current stored generation; 'skipped', not 'failed', so
 * the caller stays silent), and 'failed' when the shared ledger
 * refused the write (corrupt stored value, unavailable storage, or a
 * full quota) — the caller surfaces 'failed' (J2 R2 M2), the
 * dashboard's own in-memory ledger is unaffected in every case.
 */
export function persistLiveReceiptToSessionLedger(
  receipt: LiveReceipt,
): "persisted" | "skipped" | "failed" {
  if (!receipt.receipt) return "skipped";
  const endpoint = INTENT_TO_LEDGER_ENDPOINT[receipt.intent];
  if (!endpoint) return "skipped";
  // Cross-tab Clear gate (J2 R6): a Clear in another tab while this
  // call was in flight bumps the stored generation; persisting now
  // would resurrect the receipt into a ledger the user just cleared.
  if (
    receipt.ledgerGenAtStart !== undefined &&
    receipt.ledgerGenAtStart !== readLedgerGeneration()
  ) {
    return "skipped";
  }
  let params = receipt.query;
  try {
    params = new URL(receipt.requestUrl).search.slice(1) || receipt.query;
  } catch {
    // Unparseable request URL — the human-readable query is the params;
    // summaryFor parses its "entity · period" form (filings J1/J2 R4 M1).
  }
  const b = asRecord(receipt.body);
  const verifyData =
    endpoint === "tx"
      ? { tx_hash: typeof b?.tx_hash === "string" ? b.tx_hash : undefined }
      : endpoint === "grid"
        ? {
            node_or_zone: typeof b?.node_or_zone === "string" ? b.node_or_zone : undefined,
            interval_start:
              typeof b?.interval_start === "string" ? b.interval_start : undefined,
            lmp_usd_per_mwh:
              typeof b?.lmp_usd_per_mwh === "number" ? b.lmp_usd_per_mwh : undefined,
            market: typeof b?.market === "string" ? b.market : undefined,
          }
        : undefined;
  const entry: SessionReceipt = {
    // The dashboard's LiveReceipt.key is unique per call (lr-<tab>-<seq>-…,
    // per-tab random id + counter): dedupe is by key, never by receipt_id
    // — two legitimate calls can share one receipt_id (same not_found
    // answer, bursts) and must not collapse to one row (J2 R2 B1).
    key: receipt.key,
    endpoint,
    label: `${endpoint} ${receipt.query}`,
    params,
    fetchedAt: receipt.ts,
    receipt: receipt.receipt,
    summary: summaryFor(endpoint, receipt.body, params),
    verifyData,
  };
  // Pass the generation captured at probe start so append can refuse
  // or roll back if a Clear landed in the write window (P-LEDGER-XTAB).
  return appendSessionReceipt(entry, receipt.ledgerGenAtStart) ? "persisted" : "failed";
}

let refusalSeq = 0;
let liveReceiptSeq = 0;

/** Random per-tab id, same reason as SESSION_TAB_ID in
 *  lib/sessionReceipts.ts: the counter alone is per module instance, so
 *  two tabs could mint the same lr- key for the same receipt_id and the
 *  shared ledger's dedupe would drop a legitimate receipt. */
const LIVE_RECEIPT_TAB_ID = Math.random().toString(36).slice(2, 10);

/**
 * Build a session-ledger row from a probe outcome.
 *
 * The row key is client-generated (a per-tab random id + per-session
 * counter + the server receipt_id): the server receipt_id alone must
 * never be a React key — two calls can legitimately share one receipt_id
 * (e.g. the same not_found answer), which duplicates keys and drops rows.
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
      key: `lr-${LIVE_RECEIPT_TAB_ID}-${liveReceiptSeq}-${serverId ?? "ok"}`,
      id: serverId ?? `ok-${Date.now().toString(36)}`,
      ts: receipt ? receipt.fetched_at : new Date().toISOString(),
      intent,
      query,
      requestUrl,
      status: 200,
      latencyMs: outcome.latencyMs,
      body: outcome.body,
      receipt,
      ledgerGenAtStart: outcome.ledgerGenAtStart,
    };
  }
  refusalSeq += 1;
  return {
    key: `lr-${LIVE_RECEIPT_TAB_ID}-${liveReceiptSeq}-refusal-${refusalSeq}`,
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
  // Latent guard (J2 R3 M-3): JSON.stringify(undefined) returns
  // undefined (not a string), so the .replace chain threw a TypeError.
  // Unreachable via probe() (body is always set), but a drawer body of
  // undefined/null must render empty, never throw.
  if (value === undefined || value === null) return "";
  // Hardening (J2 R4 M3): JSON.stringify THROWS on BigInt and circular
  // input instead of returning undefined — catch and render empty.
  let raw: string | undefined;
  try {
    raw = JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
  if (typeof raw !== "string") return "";
  const s = raw
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