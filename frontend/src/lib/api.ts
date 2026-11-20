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

export const REQUEST_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function buildUrl(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `${API_BASE}${path}?${query.toString()}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = body as { error?: string; code?: string; message?: string } | null;
      const message =
        err?.message ?? err?.error ?? `Request failed with status ${res.status}`;
      throw new ApiError(message, res.status, err?.code);
    }
    return body as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(
        `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
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
  }
}

export async function getHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>(`${API_BASE}/health`);
}

export async function getTx(params: {
  tx_hash: string;
  chain: string;
}): Promise<TxResponse> {
  return fetchJson<TxResponse>(
    buildUrl("/v1/tx", { tx_hash: params.tx_hash, chain: params.chain }),
  );
}

export async function getFilings(params: {
  entity: string;
  period: string;
}): Promise<FilingsResponse> {
  return fetchJson<FilingsResponse>(
    buildUrl("/v1/filings", { entity: params.entity, period: params.period }),
  );
}

export async function getTvl(params: { protocol: string }): Promise<TvlResponse> {
  return fetchJson<TvlResponse>(
    buildUrl("/v1/tvl", { protocol: params.protocol }),
  );
}

export async function getRoute(params: { pair: string }): Promise<RouteResponse> {
  return fetchJson<RouteResponse>(buildUrl("/v1/route", { pair: params.pair }));
}

export async function getGridPrice(params: {
  node_or_zone: string;
  interval_start: string;
}): Promise<GridPriceResponse> {
  return fetchJson<GridPriceResponse>(
    buildUrl("/v1/grid-price", {
      node_or_zone: params.node_or_zone,
      interval_start: params.interval_start,
    }),
  );
}
