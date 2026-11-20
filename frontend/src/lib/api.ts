// VeriReceipt API client.
// All calls go to the SAME ORIGIN under /api/* — the Vite dev server proxies
// to the live Render miner and Vercel rewrites /api/* to it in production
// (see vite.config.ts / vercel.json). The frontend never calls the Render
// origin directly, so it does not depend on CORS.

import type {
  FilingsResponse,
  GridPriceResponse,
  HealthResponse,
  RouteResponse,
  TvlResponse,
  TxResponse,
} from "./types";

export const API_BASE = "/api";

// 45s: the Render miner cold-starts (free tier spins down), so a 20s
// budget timed out legitimate first requests after idle periods.
export const REQUEST_TIMEOUT_MS = 45_000;

// /v1/route is the slowest endpoint: the dashboard worker observed >25s
// on a cold start (4.4s warm) — it quotes across venues and pins a block,
// so its cold path does strictly more upstream work than the other four
// endpoints. 45s would leave only ~20s of headroom over the slowest
// observed cold start; the route call gets 60s instead. Both budgets
// still retry exactly once on timeout, so worst-case time-to-error is
// 2x the per-attempt budget — a cold start that slow is retried rather
// than surfaced as a failure.
export const ROUTE_TIMEOUT_MS = 60_000;

/** Idempotent GETs get exactly one retry, and only on timeout. */
const MAX_ATTEMPTS = 2;

/** Client-side cap on any single string query parameter. */
export const MAX_PARAM_LENGTH = 512;

/** Server error messages are truncated to this length in ApiError. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

export class ApiError extends Error {
  status: number;
  code?: string;
  /** Seconds to wait before retrying, when the server says so (422s). */
  retry_after_sec?: number;

  constructor(message: string, status: number, code?: string, retryAfterSec?: number) {
    // Truncate: an upstream can return an arbitrarily long error body and
    // the UI renders ApiError.message verbatim.
    super(
      message.length > MAX_ERROR_MESSAGE_LENGTH
        ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
        : message,
    );
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retry_after_sec = retryAfterSec;
  }
}

function buildUrl(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `${API_BASE}${path}?${query.toString()}`;
}

/**
 * Client-side validation for a required string query parameter.
 * Throws ApiError (never sends "undefined" / "" / a multi-KB value to the
 * server) when the value is not a non-empty string within the length cap.
 */
export function assertValidParam(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(
      `Invalid parameter "${name}": must be a non-empty string`,
      400,
      "INVALID_PARAM",
    );
  }
  if (value.length > MAX_PARAM_LENGTH) {
    throw new ApiError(
      `Invalid parameter "${name}": exceeds ${MAX_PARAM_LENGTH} characters`,
      400,
      "INVALID_PARAM",
    );
  }
}

export interface FetchJsonOptions {
  /** Receipted endpoints must return an object with a receipt block. */
  expectReceipt?: boolean;
  /** External abort signal (e.g. from useLiveQuery unmount/refetch). */
  signal?: AbortSignal;
  /** Per-call timeout override (defaults to REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Validate a 2xx body: it must be a non-null JSON object, and when
 * `expectReceipt` is set it must carry a receipt object whose receipt_id
 * is a non-empty string. A 200 with an HTML/empty/array body is a broken
 * response, not a success — it throws ApiError instead of returning null.
 */
function assertValidBody(
  body: unknown,
  status: number,
  expectReceipt: boolean,
): asserts body is Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(
      "Invalid response from server: expected a JSON object",
      status,
      "INVALID_RESPONSE",
    );
  }
  if (expectReceipt) {
    const receipt = (body as Record<string, unknown>)["receipt"];
    if (
      receipt === null ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      typeof (receipt as Record<string, unknown>)["receipt_id"] !== "string" ||
      ((receipt as Record<string, unknown>)["receipt_id"] as string).length === 0
    ) {
      throw new ApiError(
        "Invalid response from server: missing or malformed receipt",
        status,
        "INVALID_RESPONSE",
      );
    }
  }
}

async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { expectReceipt = false, signal: externalSignal } = options;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        throw new ApiError("Request aborted", 0, "ABORTED");
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Non-JSON / empty body: body stays null and is rejected below
        // on 2xx, or reported with the HTTP status on an error status.
        body = null;
      }
      if (!res.ok) {
        const err = body as {
          error?: string;
          code?: string;
          message?: string;
          retry_after_sec?: unknown;
        } | null;
        const message =
          err?.message ?? err?.error ?? `Request failed with status ${res.status}`;
        // 422 bodies carry retry_after_sec: surface it instead of dropping
        // it, so the UI can tell the user how long to wait. Only a finite
        // non-negative number counts; anything else is ignored.
        const retryAfterSec =
          typeof err?.retry_after_sec === "number" &&
          Number.isFinite(err.retry_after_sec) &&
          err.retry_after_sec >= 0
            ? err.retry_after_sec
            : undefined;
        throw new ApiError(message, res.status, err?.code, retryAfterSec);
      }
      assertValidBody(body, res.status, expectReceipt);
      return body as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        // An external abort (unmount / refetch) is not a timeout and is
        // never retried: the caller deliberately cancelled this request.
        if (externalSignal?.aborted) {
          throw new ApiError("Request aborted", 0, "ABORTED");
        }
        // Timeout: exactly one retry for these idempotent GETs.
        if (timedOut && attempt + 1 < MAX_ATTEMPTS) continue;
        throw new ApiError(
          `Request timed out after ${timeoutMs / 1000}s`,
          0,
          "TIMEOUT",
        );
      }
      if (err instanceof Error) {
        throw new ApiError(err.message, 0, "NETWORK_ERROR");
      }
      throw new ApiError("Unknown request failure", 0, "UNKNOWN");
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
  // Unreachable: the loop either returns or throws on every path.
  throw new ApiError("Unknown request failure", 0, "UNKNOWN");
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return fetchJson<HealthResponse>(`${API_BASE}/health`, { signal });
}

export async function getTx(
  params: { tx_hash: string; chain: string },
  signal?: AbortSignal,
): Promise<TxResponse> {
  assertValidParam(params.tx_hash, "tx_hash");
  assertValidParam(params.chain, "chain");
  return fetchJson<TxResponse>(
    buildUrl("/v1/tx", { tx_hash: params.tx_hash, chain: params.chain }),
    { expectReceipt: true, signal },
  );
}

export async function getFilings(
  params: { entity: string; period: string },
  signal?: AbortSignal,
): Promise<FilingsResponse> {
  assertValidParam(params.entity, "entity");
  assertValidParam(params.period, "period");
  return fetchJson<FilingsResponse>(
    buildUrl("/v1/filings", { entity: params.entity, period: params.period }),
    { expectReceipt: true, signal },
  );
}

export async function getTvl(
  params: { protocol: string },
  signal?: AbortSignal,
): Promise<TvlResponse> {
  assertValidParam(params.protocol, "protocol");
  return fetchJson<TvlResponse>(
    buildUrl("/v1/tvl", { protocol: params.protocol }),
    { expectReceipt: true, signal },
  );
}

export async function getRoute(
  params: { pair: string },
  signal?: AbortSignal,
): Promise<RouteResponse> {
  assertValidParam(params.pair, "pair");
  // The miner only quotes ETH/USDC (live 422 for anything else); refuse
  // client-side instead of sending a pair the server must reject.
  if (params.pair !== "ETH/USDC") {
    throw new ApiError('Invalid parameter "pair": only "ETH/USDC" is supported', 422, "UNSUPPORTED_PAIR");
  }
  return fetchJson<RouteResponse>(buildUrl("/v1/route", { pair: params.pair }), {
    expectReceipt: true,
    signal,
    // Slowest endpoint (cold start >25s observed): 60s per attempt.
    timeoutMs: ROUTE_TIMEOUT_MS,
  });
}

export async function getGridPrice(
  params: { node_or_zone: string; interval_start: string },
  signal?: AbortSignal,
): Promise<GridPriceResponse> {
  assertValidParam(params.node_or_zone, "node_or_zone");
  assertValidParam(params.interval_start, "interval_start");
  return fetchJson<GridPriceResponse>(
    buildUrl("/v1/grid-price", {
      node_or_zone: params.node_or_zone,
      interval_start: params.interval_start,
    }),
    { expectReceipt: true, signal },
  );
}
