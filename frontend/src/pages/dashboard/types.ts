// Shared types for the VeriReceipt Dashboard & Proof Hub.
//
// Response shapes come from the data-layer lib (`../lib/types`, contract
// source: miner.yaml + live responses from https://verireceipt.onrender.com).
// This page re-exports the shapes it renders so it does not depend on the
// lib's internal type names beyond the mandated imports.

import type {
  FilingsResponse,
  GridPriceResponse,
  HealthResponse,
  Receipt,
  RouteResponse,
  TvlResponse,
  TxResponse,
} from "../../lib/types";

export type {
  FilingsResponse,
  GridPriceResponse,
  HealthResponse,
  Receipt,
  RouteResponse,
  TvlResponse,
  TxResponse,
};

/** One row of the session ledger: a real call the browser made, nothing else. */
export interface LiveReceipt {
  /** receipt.receipt_id when the call returned one; `refusal-<rand>` for 422/4xx. */
  id: string;
  /** receipt.fetched_at when present, else the client time the call settled. */
  ts: string;
  intent: string;
  /** Human-readable query, e.g. `0x1b9e…a9d3 (ethereum)` or `protocol=aave-v3`. */
  query: string;
  /** Direct Render URL of the call (used by Copy curl). */
  requestUrl: string;
  /** HTTP status actually returned (0 = network/timeout, never a guess). */
  status: number;
  /** Measured browser-side latency in ms (performance.now around the fetch). */
  latencyMs: number;
  /** Full response body (envelope on 2xx, error body on 4xx/5xx). */
  body: unknown;
  /** The receipt block, or null when the call was refused before receipting. */
  receipt: Receipt | null;
  /** Short error code from the API error body / lib ApiError, if any. */
  errorCode?: string;
  /** Human-readable error message, if any. */
  errorMessage?: string;
}

/** One live probe outcome, before it is recorded as a LiveReceipt. */
export type ProbeOutcome =
  | { ok: true; body: unknown; receipt: Receipt | null; latencyMs: number }
  | {
      ok: false;
      body: unknown;
      latencyMs: number;
      status: number;
      errorCode?: string;
      errorMessage?: string;
    };

export type DashboardView = "desk" | "receipts" | "benchmarks" | "status";

/** Latency samples per endpoint series, feeding the Status oscilloscope. */
export interface ScopeSamples {
  tx: number[];
  grid: number[];
  tvl: number[];
  route: number[];
}

export type ScopeSeriesKey = keyof ScopeSamples;

/** Auth mode (3-tier drawer). Values are kept in memory only, never persisted. */
export type AuthMode = "sponsored" | "byok" | "mcp";
