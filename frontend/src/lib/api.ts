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

/**
 * Upper bound for a server-advised retry delay. A 422 body may carry
 * retry_after_sec, but the value is untrusted: -5 / NaN / Infinity /
 * 1e21 / "soon" must never reach the UI (J2 M1). Anything outside
 * [0, 86400] (24h) is treated as absent.
 */
export const MAX_RETRY_AFTER_SEC = 86_400;

/** A receipt_id longer than this is rejected as malformed (B-1a / M-5). */
export const MAX_RECEIPT_ID_LENGTH = 512;

/** Shared retry-delay validation: finite, non-negative, sane upper bound. */
export function isValidRetryAfterSec(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RETRY_AFTER_SEC
  );
}

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
    // Validate: the constructor must never trust retry_after_sec blindly
    // (J2 M1) — -5/NaN/Infinity/1e21/"soon" would render insanely, and
    // a non-number ({} cast in) would crash the retry display.
    this.retry_after_sec = isValidRetryAfterSec(retryAfterSec)
      ? retryAfterSec
      : undefined;
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

/**
 * Guard the params object itself at the top of every get* (J2 M-2):
 * getTx(null) / getTx(undefined) used to throw a raw TypeError from
 * `params.tx_hash` instead of an ApiError, and still cost a fetch.
 * A null/undefined/non-object params argument is INVALID_PARAM with
 * zero fetch calls.
 */
export function assertValidParamsObject(
  params: unknown,
  fnName: string,
): asserts params is Record<string, unknown> {
  if (params === null || params === undefined || typeof params !== "object" || Array.isArray(params)) {
    throw new ApiError(
      `Invalid parameter for ${fnName}: expected a params object`,
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
 * `expectReceipt` is set it must carry a receipt object whose fields are
 * all usable. B-1a: checking only receipt_id let a validation-PASSING
 * response such as `{receipt_id:"rcpt_OK", raw_response_sha256:12345}`
 * through to ReceiptCard, which then crashed (shortenSha does
 * value.slice on a number). So every field the card renders must be a
 * non-empty string here: receipt_id (also trimmed non-empty and capped
 * at 512 chars — M-5: whitespace-only and 1 MB ids passed before),
 * raw_response_sha256, fetched_at and upstream_url.
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
    const fieldsValid =
      receipt !== null &&
      typeof receipt === "object" &&
      !Array.isArray(receipt) &&
      isNonEmptyReceiptString(
        (receipt as Record<string, unknown>)["receipt_id"],
        MAX_RECEIPT_ID_LENGTH,
      ) &&
      isNonEmptyReceiptString((receipt as Record<string, unknown>)["raw_response_sha256"]) &&
      isNonEmptyReceiptString((receipt as Record<string, unknown>)["fetched_at"]) &&
      isNonEmptyReceiptString((receipt as Record<string, unknown>)["upstream_url"]);
    if (!fieldsValid) {
      throw new ApiError(
        "Invalid response from server: missing or malformed receipt",
        status,
        "INVALID_RESPONSE",
      );
    }
  }
}

/**
 * A receipt field is usable only as a non-empty (after trim), non-blank
 * string, optionally capped in length. Non-strings (numbers, objects,
 * null) and whitespace-only strings are malformed.
 */
function isNonEmptyReceiptString(value: unknown, maxLength = Number.POSITIVE_INFINITY): boolean {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
  );
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
        // non-negative number within the sane bound counts (shared
        // isValidRetryAfterSec); anything else is ignored.
        const retryAfterSec = isValidRetryAfterSec(err?.retry_after_sec)
          ? err?.retry_after_sec
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
        if (timedOut) {
          throw new ApiError(
            `Request timed out after ${timeoutMs / 1000}s`,
            0,
            "TIMEOUT",
          );
        }
        // Spurious abort (J2 M-6): no timeout fired and no external abort
        // was requested — e.g. the runtime aborted the request on its own.
        // It is NOT a timeout, so it must never be reported as
        // "timed out after 45s", and it is never retried.
        throw new ApiError("Request aborted", 0, "ABORTED");
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
  assertValidParamsObject(params, "getTx");
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
  assertValidParamsObject(params, "getFilings");
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
  assertValidParamsObject(params, "getTvl");
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
  assertValidParamsObject(params, "getRoute");
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
  assertValidParamsObject(params, "getGridPrice");
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
