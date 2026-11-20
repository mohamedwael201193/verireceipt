export class ApiError extends Error {
  status: number;
  code: string;
  retryAfterSec?: number;

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
  if (err.status === 400) return "invalid_params";
  if (err.status === 422) return "unverifiable_input";
  if (err.status === 502) return "upstream_unavailable";
  // Fallback: snake_case of the code (e.g. RATE_LIMITED -> rate_limited).
  return err.code
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
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
