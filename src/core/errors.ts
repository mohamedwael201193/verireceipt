export class ApiError extends Error {
  status: number;
  code: string;
  retryAfterSec?: number;
  /** Internal fixed-vocabulary diagnostic label (which closed branch refused),
   * threaded to the refusal_param_class log line only. Set from string
   * literals in this codebase, never from request or upstream text, and never
   * serialized into the response: errorBody picks its fields explicitly. */
  logLabel?: string;
  /** When set, the server sends this body verbatim instead of errorBody
   * (used by the ROUTE unavailable-envelope path, 2026-11-22). */
  responseBody?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (retryAfterSec !== undefined) {
      this.retryAfterSec = retryAfterSec;
    }
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export function badRequest(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

export function unprocessable(code: string, message: string, retryAfterSec?: number): ApiError {
  return new ApiError(422, code, message, retryAfterSec);
}

export function upstreamUnavailable(code: string, message: string): ApiError {
  return new ApiError(502, code, message);
}

function errorNameFor(err: ApiError): string {
  // Derive the `error` label from the code (snake_case), not the status:
  // e.g. 400/RATE_LIMITED must be "rate_limited", not "invalid_params".
  // The three status names survive only as fallbacks when the code is empty.
  const fromCode = err.code
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
  if (fromCode) return fromCode;
  if (err.status === 400) return "invalid_params";
  if (err.status === 422) return "unverifiable_input";
  if (err.status === 502) return "upstream_unavailable";
  return "upstream_unavailable";
}

export function errorBody(err: unknown): {
  error: string;
  code: string;
  message: string;
  retry_after_sec?: number;
} {
  if (err instanceof ApiError) {
    const body: { error: string; code: string; message: string; retry_after_sec?: number } = {
      error: errorNameFor(err),
      code: err.code,
      message: err.message,
    };
    if (err.retryAfterSec !== undefined) {
      body.retry_after_sec = err.retryAfterSec;
    }
    return body;
  }
  return { error: "upstream_unavailable", code: "INTERNAL", message: "internal error" };
}
