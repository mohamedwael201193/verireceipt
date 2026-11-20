// Small pure helpers for the landing page.
import { ApiError } from "../../lib/api";
import { formatUsdPrecise } from "../../lib/format";
import type { IntentKey } from "./data";
import { PRESETS } from "./data";

/** Human-readable message for anything thrown by the lib. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code ? `${err.message} (${err.code})` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** HTTP status for anything thrown by the lib (0 = network/timeout). */
export function errorStatus(err: unknown): number {
  if (err instanceof ApiError) return err.status;
  return 0;
}

/** amount_out is 6-decimal USDC base units: 1739260358 -> "1,739.260358 USDC". */
export function formatUsdcBaseUnits(amountOut: number | null | undefined): string {
  if (amountOut === null || amountOut === undefined || Number.isNaN(amountOut)) return "—";
  const usdc = amountOut / 1_000_000;
  return `${usdc.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })} USDC`;
}

/** LMP with unit: 66.94117 -> "$66.94 / MWh". */
export function formatLmp(lmp: number | null | undefined): string {
  if (lmp === null || lmp === undefined || Number.isNaN(lmp)) return "—";
  return `${formatUsdPrecise(lmp)} / MWh`;
}

/** Truncate a hash for display: first 6 + ellipsis + last 4. */
export function shortHash(value: string | null | undefined): string {
  if (!value) return "—";
  if (value.length <= 13) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

const ENDPOINT_PATH: Record<IntentKey, string> = {
  tx: "/v1/tx",
  sec: "/v1/filings",
  tvl: "/v1/tvl",
  route: "/v1/route",
  grid: "/v1/grid-price",
};

/** Same-origin API URL for an intent + params (mirrors lib/api buildUrl). */
export function apiUrlFor(key: IntentKey, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `/api${ENDPOINT_PATH[key]}?${query.toString()}`;
}

/** Absolute public URL for an intent + params (used in curl snippets). */
export function publicUrlFor(key: IntentKey, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `https://verireceipt.onrender.com${ENDPOINT_PATH[key]}?${query.toString()}`;
}

/** Real GET curl for an intent + params (the design's POST curls were wrong). */
export function curlFor(key: IntentKey, params: Record<string, string>): string {
  return `curl -s "${publicUrlFor(key, params)}"`;
}

/** Default curl for an intent (its live preset). */
export function curlForPreset(key: IntentKey): string {
  return curlFor(key, PRESETS[key]);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Syntax-highlighted JSON as an HTML string (same palette as the design:
 * .jk key, .js string, .jn number, .jb boolean, .j0 null). The input is
 * escaped before highlighting, so this is safe for dangerouslySetInnerHTML.
 */
export function hlJSON(obj: unknown): string {
  const s = escapeHtml(JSON.stringify(obj, null, 2));
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
