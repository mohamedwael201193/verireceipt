// VeriReceipt API client.
// All calls go to the SAME ORIGIN under /api/* — the Vite dev server proxies
// to the live Render miner and Vercel rewrites /api/* to it in production
// (see vite.config.ts / vercel.json). The frontend never calls the Render
// origin directly, so it does not depend on CORS.

import type {
  FilingsResponse,
  GridPriceResponse,
  HealthResponse,
  CorporateRegistryResponse,
  RouteResponse,
  PoolLiquidityResponse,
  ReserveAttestationResponse,
  SanctionsScreenResponse,
  StockPriceResponse,
  TokenHoldersResponse,
  TokenSupplyResponse,
  TvlResponse,
  TxResponse,
  ValidatorResponse,
} from "./types";
import { hasVisibleCharacter } from "./format";

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

/**
 * Length caps for the other receipt fields (J2 R3): only receipt_id was
 * capped, so a 1 MB fetched_at passed validation and rendered verbatim,
 * a 1 MB upstream_url rendered as plain text, and a 1 MB sha sat in the
 * title= attribute. Caps are generous against every legit live value —
 * fetched_at is an ISO timestamp (~24–32 chars), upstream_url is a real
 * upstream URL (live values are well under 200 chars; 2048 is the common
 * URL-length bound), and raw_response_sha256 is 64 bare hex chars (66 with an optional "0x")
 * (128 leaves ~2x headroom) — so no legit live receipt can trip them.
 */
export const MAX_RECEIPT_FETCHED_AT_LENGTH = 128;
export const MAX_RECEIPT_UPSTREAM_URL_LENGTH = 2048;
export const MAX_RECEIPT_SHA_LENGTH = 128;

/**
 * Maximum miner-response body accepted (J2 R3): the miner returns a
 * small JSON envelope — never the 16 MB upstream payload it hashes —
 * so an unbounded parse lets a garbage / hostile multi-MB body through
 * to JSON.parse and the UI. 1 MiB is comfortably above the largest legit
 * live envelope, measured live 2026-11-20: filings (the largest, 95
 * filings) is 25,709 bytes; tvl 726, route 808, grid 795, health 70 —
 * so the cap is ~40x the largest legit envelope and no legit live
 * response can trip it. Anything larger is INVALID_RESPONSE.
 */
export const MAX_RESPONSE_BODY_BYTES = 1_048_576;

/** Shared retry-delay validation: finite, non-negative, sane upper bound. */
export function isValidRetryAfterSec(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RETRY_AFTER_SEC
  );
}

/**
 * Parse a `Retry-After` response header as a fallback when the error
 * body carries no usable retry_after_sec (J2 R3: only the body was
 * read, so a 429 that signals the delay via the standard header was
 * silently dropped). Accepts delay-seconds ("120") and HTTP-dates
 * ("Fri, 20 Nov 2026 10:30:00 GMT", converted to seconds-from-now);
 * anything unparseable or outside [0, 86400] is absent, exactly like
 * an invalid body value.
 */
export function parseRetryAfterHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  // A header of only invisible format characters (J2 R5 B-1) is blank,
  // not a delay: trim() does not strip U+200B etc.
  if (!hasVisibleCharacter(value)) return undefined;
  const trimmed = value.trim();
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && isValidRetryAfterSec(asSeconds)) return asSeconds;
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const deltaSec = Math.floor((asDate - Date.now()) / 1000);
    if (isValidRetryAfterSec(deltaSec)) return deltaSec;
  }
  return undefined;
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
  // Invisible-format-only strings (J2 R5 B-1) are blank, not params:
  // trim() does not strip U+200B etc., so hasVisibleCharacter decides.
  if (typeof value !== "string" || !hasVisibleCharacter(value)) {
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
      isNonEmptyReceiptString(
        (receipt as Record<string, unknown>)["raw_response_sha256"],
        MAX_RECEIPT_SHA_LENGTH,
      ) &&
      isNonEmptyReceiptString(
        (receipt as Record<string, unknown>)["fetched_at"],
        MAX_RECEIPT_FETCHED_AT_LENGTH,
      ) &&
      isNonEmptyReceiptString(
        (receipt as Record<string, unknown>)["upstream_url"],
        MAX_RECEIPT_UPSTREAM_URL_LENGTH,
      );
    if (!fieldsValid) {
      throw new ApiError(
        "Invalid response from server: missing or malformed receipt",
        status,
        "INVALID_RESPONSE",
      );
    }
  }
  // Payload fields beyond the receipt (J2 R3 §8b): a 200 with a valid
  // receipt but `filings: "not-an-array"` used to pass straight through
  // to a consumer that iterates filings. Only type checks that are
  // clearly safe are applied — "if present, it must be the declared
  // type" — and every one was verified against live responses
  // 2026-11-20 (filings is a 95-item array, urls a string array,
  // filing_count/tvl_usd/amount_out/lmp_usd_per_mwh finite numbers,
  // chain_tvl_usd/block_number numbers or null). Nested entry shapes
  // are NOT validated: that would be over-engineering for fields no
  // consumer in this branch iterates.
  if (!arePayloadFieldsValid(body as Record<string, unknown>)) {
    throw new ApiError(
      "Invalid response from server: malformed payload fields",
      status,
      "INVALID_RESPONSE",
    );
  }
}

/**
 * "If present, it must be the declared type" for the payload fields a
 * consumer iterates or formats. Absent fields are fine (not every
 * endpoint returns every field); null is allowed only where the type
 * declares it (chain_tvl_usd, block_number).
 */
function arePayloadFieldsValid(body: Record<string, unknown>): boolean {
  if ("filings" in body && !Array.isArray(body["filings"])) return false;
  if ("urls" in body && !Array.isArray(body["urls"])) return false;
  for (const key of ["filing_count", "tvl_usd", "amount_out", "lmp_usd_per_mwh"]) {
    if (key in body && (typeof body[key] !== "number" || !Number.isFinite(body[key] as number))) {
      return false;
    }
  }
  for (const key of ["chain_tvl_usd", "block_number"]) {
    if (
      key in body &&
      body[key] !== null &&
      (typeof body[key] !== "number" || !Number.isFinite(body[key] as number))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A receipt field is usable only as a non-empty (after trim), non-blank
 * string, optionally capped in length. Non-strings (numbers, objects,
 * null), whitespace-only strings, and strings of only invisible format
 * characters (U+200B etc. — J2 R5 B-1, trim() does not strip them) are
 * malformed.
 */
function isNonEmptyReceiptString(value: unknown, maxLength = Number.POSITIVE_INFINITY): boolean {
  return (
    typeof value === "string" && hasVisibleCharacter(value) && value.length <= maxLength
  );
}

/**
 * First candidate that is a string with a visible character (J2 R7
 * M-1b): an empty / whitespace-only / invisible-only candidate is
 * skipped, so a blank `message` can never hide a real `error`, and a
 * body with no usable message falls back to the caller's default.
 * Non-strings are skipped (a JSON body may carry `message: 123`).
 */
function firstVisibleMessage(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && hasVisibleCharacter(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Cross-realm-safe error message (J2 R5 m2): `err instanceof Error`
 * fails for an Error thrown from another realm (a vm context, an
 * iframe, jsdom's fetch), so such an error fell through to UNKNOWN
 * instead of NETWORK_ERROR. Any object carrying a string `message`
 * is error-like — the shape, not the prototype chain, decides.
 * Returns undefined for non-errors (thrown strings, nulls, objects
 * without a string message), which stay UNKNOWN.
 *
 * Guarded reads (J2 R6 M-2): a `.message` getter that throws must not
 * escape fetchJson as a raw Error — a throwing accessor means "no
 * usable message", so it returns undefined exactly like a missing one.
 * Empty / whitespace-only messages (J2 R6 M-1) are absent too:
 * fetch() throwing `{message: ""}` used to surface NETWORK_ERROR with
 * an empty message; it is UNKNOWN instead. Invisible-only messages
 * (J2 R7 M-1a) are absent the same way: trim() does not strip U+200B
 * etc., so hasVisibleCharacter decides, not trim(). U+FEFF still
 * reaches UNKNOWN — it is Cf, stripped by hasVisibleCharacter.
 * (api.ts already imports hasVisibleCharacter from format.ts;
 * format.ts imports nothing from api.ts, so there is no cycle.)
 */
function errorMessage(err: unknown): string | undefined {
  let message: unknown;
  try {
    message =
      typeof err === "object" && err !== null
        ? (err as { message?: unknown }).message
        : undefined;
  } catch {
    return undefined;
  }
  if (typeof message !== "string" || !hasVisibleCharacter(message)) return undefined;
  return message;
}

/**
 * Abort classification by error NAME, not instanceof (J2 R4 M-3): a
 * non-DOMException error with name === "AbortError" (e.g. a plain Error
 * thrown by res.text(), or a cross-realm DOMException that fails
 * instanceof) is an abort all the same. The name check covers both
 * DOMException and plain-Error aborts; instanceof alone missed the
 * latter and swallowed it to body = null -> INVALID_RESPONSE.
 *
 * Guarded read (J2 R6 M-2): a `.name` getter that throws must not
 * escape fetchJson as a raw Error — a throwing accessor is simply
 * not an abort (false), and the message read in the same catch path
 * is guarded the same way by errorMessage.
 */
function isAbortError(err: unknown): boolean {
  try {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "AbortError"
    );
  } catch {
    return false;
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
      // Body is read as text (not res.json()) so the response can be
      // size-capped before it is parsed: the miner returns a small JSON
      // envelope, never the upstream payload, so anything over
      // MAX_RESPONSE_BODY_BYTES (1 MiB) is garbage, not data.
      // Non-JSON / empty body: body stays null and is rejected below
      // on 2xx, or reported with the HTTP status on an error status.
      // An AbortError from text() is rethrown (never swallowed to null):
      // swallowing it would turn a timeout/abort into INVALID_RESPONSE.
      let body: unknown = null;
      try {
        const text = await res.text();
        // Abort during the body read (J2 R3 M-6): the fetch resolved but
        // the body was still pending when the caller aborted — returning
        // the data now would hand the caller a response it cancelled.
        // Throwing AbortError lets the outer catch classify it exactly
        // like a fetch-time abort (external ABORTED, timeout TIMEOUT
        // with one retry, spurious ABORTED).
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        // Size cap (J2 R3): text.length already bounds UTF-8 bytes from
        // below (every char is >= 1 byte), so a longer string is over
        // the cap without encoding it; the exact byte length is checked
        // for multi-byte text that fits in chars but not in bytes.
        if (
          text.length > MAX_RESPONSE_BODY_BYTES ||
          new TextEncoder().encode(text).length > MAX_RESPONSE_BODY_BYTES
        ) {
          throw new ApiError(
            `Response body exceeds the ${MAX_RESPONSE_BODY_BYTES} byte limit`,
            res.status,
            "INVALID_RESPONSE",
          );
        }
        if (text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (err instanceof ApiError) throw err;
        // A non-abort failure reading the body (J1 R3 m3): the body
        // never arrived, so nothing about it was invalid — a mid-body
        // network failure is a NETWORK_ERROR, not INVALID_RESPONSE.
        // On an error status the HTTP status is still real information,
        // so only a 2xx body-read failure is reclassified; otherwise
        // the body stays null and the status error below surfaces.
        if (res.ok) {
          throw new ApiError(
            errorMessage(err) ?? "Failed to read response body",
            0,
            "NETWORK_ERROR",
          );
        }
        body = null;
      }
      if (!res.ok) {
        const err = body as {
          error?: string;
          code?: string;
          message?: string;
          retry_after_sec?: unknown;
        } | null;
        // First candidate with a visible character wins (J2 R7 M-1b):
        // `??` let an empty / whitespace-only / invisible-only
        // `message` through verbatim ("" / "   " / "\u200B"), and let
        // a blank `message` hide a real `error` ("  " over "Real
        // error"). Non-string candidates are skipped the same way.
        // When no candidate has a visible character, the default
        // status message is used — never an invisible one.
        const message =
          firstVisibleMessage(err?.message, err?.error) ??
          `Request failed with status ${res.status}`;
        // 422 bodies carry retry_after_sec: surface it instead of dropping
        // it, so the UI can tell the user how long to wait. Only a finite
        // non-negative number within the sane bound counts (shared
        // isValidRetryAfterSec); anything else is ignored. When the body
        // value is absent/invalid, the standard Retry-After response
        // header is the fallback (J2 R3) — a 429 that signals its delay
        // only via the header must not lose it. Guarded with optional
        // chaining (J1 dashboard re-review): a real fetch Response
        // always has headers, but hand-rolled stubs in other branches'
        // tests return {ok, status, json, text} with NO headers — an
        // unguarded read threw TypeError, wrapped as NETWORK_ERROR
        // (status 0), masking the real error status/code. A missing
        // headers object (or a headers without .get) simply means no
        // header fallback, never a network error. And a THROWING .get
        // (J2 R5 m1) must not mask the real status either: the header
        // read is wrapped so a throw falls back to "no header" and the
        // body code/status survive.
        let retryAfterHeader: string | null = null;
        try {
          retryAfterHeader = res.headers?.get?.("Retry-After") ?? null;
        } catch {
          retryAfterHeader = null;
        }
        const retryAfterSec = isValidRetryAfterSec(err?.retry_after_sec)
          ? err?.retry_after_sec
          : parseRetryAfterHeader(retryAfterHeader);
        throw new ApiError(message, res.status, err?.code, retryAfterSec);
      }
      assertValidBody(body, res.status, expectReceipt);
      return body as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (isAbortError(err)) {
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
      // A fetch() failure is a network error — including a cross-realm
      // Error (J2 R5 m2), which fails `instanceof Error`: errorMessage
      // classifies by the message shape, not the prototype chain.
      const networkMessage = errorMessage(err);
      if (networkMessage !== undefined) {
        throw new ApiError(networkMessage, 0, "NETWORK_ERROR");
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
  params: { entity: string; period: string; form_type?: string },
  signal?: AbortSignal,
): Promise<FilingsResponse> {
  assertValidParamsObject(params, "getFilings");
  assertValidParam(params.entity, "entity");
  assertValidParam(params.period, "period");
  // QA-02: the optional EDGAR form filter is sent when the caller names
  // one (the 10-K preset must actually ask for 10-Ks). Absent = all forms.
  const query: Record<string, string> = { entity: params.entity, period: params.period };
  if (params.form_type !== undefined) {
    assertValidParam(params.form_type, "form_type");
    query.form_type = params.form_type;
  }
  return fetchJson<FilingsResponse>(buildUrl("/v1/filings", query), { expectReceipt: true, signal });
}

export async function getSanctionsScreen(
  params: { name: string },
  signal?: AbortSignal,
): Promise<SanctionsScreenResponse> {
  assertValidParamsObject(params, "getSanctionsScreen");
  assertValidParam(params.name, "name");
  return fetchJson<SanctionsScreenResponse>(buildUrl("/v1/sanctions-screen", { name: params.name }), {
    expectReceipt: true,
    signal,
  });
}

export async function getReserveAttestation(
  params: { asset: string },
  signal?: AbortSignal,
): Promise<ReserveAttestationResponse> {
  assertValidParamsObject(params, "getReserveAttestation");
  assertValidParam(params.asset, "asset");
  return fetchJson<ReserveAttestationResponse>(buildUrl("/v1/reserve-attestation", { asset: params.asset }), {
    expectReceipt: true,
    signal,
  });
}

export async function getCorporateRegistry(
  params: { company: string; jurisdiction: string },
  signal?: AbortSignal,
): Promise<CorporateRegistryResponse> {
  assertValidParamsObject(params, "getCorporateRegistry");
  assertValidParam(params.company, "company");
  assertValidParam(params.jurisdiction, "jurisdiction");
  return fetchJson<CorporateRegistryResponse>(
    buildUrl("/v1/corporate-registry", { company: params.company, jurisdiction: params.jurisdiction }),
    { expectReceipt: true, signal },
  );
}

export async function getStockPrice(
  params: { ticker: string },
  signal?: AbortSignal,
): Promise<StockPriceResponse> {
  assertValidParamsObject(params, "getStockPrice");
  assertValidParam(params.ticker, "ticker");
  return fetchJson<StockPriceResponse>(buildUrl("/v1/stock-price", { ticker: params.ticker }), {
    expectReceipt: true,
    signal,
  });
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

export async function getValidator(
  params: { validator_index: string },
  signal?: AbortSignal,
): Promise<ValidatorResponse> {
  assertValidParamsObject(params, "getValidator");
  assertValidParam(params.validator_index, "validator_index");
  return fetchJson<ValidatorResponse>(
    buildUrl("/v1/validator", { validator_index: params.validator_index }),
    { expectReceipt: true, signal },
  );
}

export async function getTokenHolders(
  params: { token: string; chain: string },
  signal?: AbortSignal,
): Promise<TokenHoldersResponse> {
  assertValidParamsObject(params, "getTokenHolders");
  assertValidParam(params.token, "token");
  assertValidParam(params.chain, "chain");
  return fetchJson<TokenHoldersResponse>(
    buildUrl("/v1/token-holders", { token: params.token, chain: params.chain }),
    { expectReceipt: true, signal },
  );
}

export async function getPoolLiquidity(
  params: { pool: string; chain: string },
  signal?: AbortSignal,
): Promise<PoolLiquidityResponse> {
  assertValidParamsObject(params, "getPoolLiquidity");
  assertValidParam(params.pool, "pool");
  assertValidParam(params.chain, "chain");
  return fetchJson<PoolLiquidityResponse>(
    buildUrl("/v1/liquidity", { pool: params.pool, chain: params.chain }),
    { expectReceipt: true, signal },
  );
}

export async function getTokenSupply(
  params: { token: string },
  signal?: AbortSignal,
): Promise<TokenSupplyResponse> {
  assertValidParamsObject(params, "getTokenSupply");
  assertValidParam(params.token, "token");
  return fetchJson<TokenSupplyResponse>(
    buildUrl("/v1/token-supply", { token: params.token }),
    { expectReceipt: true, signal },
  );
}
