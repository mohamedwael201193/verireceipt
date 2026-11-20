// GET /v1/grid-price — wholesale electricity LMP from the SQLite cache only.
// The handler never fetches an upstream feed and never fabricates a price:
// a cache miss is a 502 GRID_CACHE_MISS, and a cache row older than the
// staleness bound is a 502 GRID_CACHE_STALE (never served as verified).
// Prices are written to the cache by src/jobs/gridIngester.ts from verified
// keyless ISO feeds (Elering, NYISO, CAISO). Settlement windows come from
// SUPPORTED_ZONES (NYISO 5 min, Elering 15 min, CAISO 60 min); the default
// 1h window applies only if a zone ever lacks one.
//
// Freshness: GRID_CACHE_TTL_MS is 1 hour. It covers all three zone windows
// (5/15/60 min) with margin — a 1h-old NYISO row is already 12 windows
// stale. The receipt's fetched_at is the row's ingested_at (when the
// ingester wrote it), NOT the response time, so a receipt never claims a
// stale row was fetched fresh.
// Upstream URL: read from the row's persisted upstream_url (written at
// ingest time, so it survives restarts). The fallback for legacy rows with
// no stored URL is the dated-file / full-query URL pattern — never the bare
// NYISO directory (HTTP 403) or the bare SingleZip endpoint (HTTP 429).

import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { getGridPrice } from "../core/db";
import {
  SUPPORTED_ZONES,
  gridFallbackUrl,
  resolveGridAlias,
} from "../jobs/gridIngester";

/** ISO-8601 UTC only: trailing Z or +00:00/-00:00 required, no bare local time. */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]00:00)$/;

/** Max age of a cache row served as verified: 1 hour. */
export const GRID_CACHE_TTL_MS = 60 * 60 * 1000;

function hhmmUtc(ms: number): string {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}

export async function handleGridPrice(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const nodeOrZone = query.node_or_zone;
  if (!nodeOrZone) {
    throw badRequest("INVALID_NODE", "node_or_zone is required");
  }
  const rawInterval = query.interval_start;
  if (!rawInterval) {
    throw badRequest("INVALID_INTERVAL", "interval_start is required");
  }
  if (!ISO_UTC_RE.test(rawInterval)) {
    throw badRequest(
      "INVALID_INTERVAL",
      "interval_start must be ISO-8601 UTC (e.g. 2026-11-20T05:00:00Z)",
    );
  }
  const parsed = new Date(rawInterval);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest("INVALID_INTERVAL", "interval_start is not a valid datetime");
  }
  // Normalise: truncate fractional seconds to whole seconds before lookup
  // (a query for 05:15:00.123Z names the 05:15:00 interval, it is not a miss).
  const startMs = Math.floor(parsed.getTime() / 1000) * 1000;
  const start = new Date(startMs);

  const zone = SUPPORTED_ZONES[nodeOrZone];
  if (!zone) {
    throw unprocessable(
      "UNSUPPORTED_ZONE",
      "node_or_zone " + nodeOrZone + " is not covered by any supported ISO feed",
    );
  }

  const intervalStart = start.toISOString();
  const nowMs = Date.now();
  const windowMin = zone.windowMin ?? 60;
  const intervalEndMs = startMs + windowMin * 60_000;
  if (intervalEndMs > nowMs) {
    const retryAfterSec = Math.max(1, Math.ceil((intervalEndMs - nowMs) / 1000));
    throw unprocessable(
      "FUTURE_INTERVAL",
      "settlement interval starting " + intervalStart + " has not finished yet",
      retryAfterSec,
    );
  }

  // Window alignment: the interval must start on a settlement boundary.
  // Checked after the future-interval check so an unfinished interval still
  // reports FUTURE_INTERVAL (with retry_after_sec) rather than alignment.
  const windowMs = windowMin * 60_000;
  if (startMs % windowMs !== 0) {
    const containingStartMs = Math.floor(startMs / windowMs) * windowMs;
    throw unprocessable(
      "OFF_BOUNDARY_INTERVAL",
      "interval " +
        hhmmUtc(startMs) +
        " is not on a " +
        windowMin +
        "-minute boundary; containing window starts " +
        hhmmUtc(containingStartMs),
    );
  }

  // Alias fallback: a row stored under the paired spelling (e.g. ZONE_J)
  // serves a query for the other spelling (e.g. N.Y.C.) and vice versa.
  // The ingester writes both keys in production, but the handler must not
  // depend on that.
  let row = getGridPrice(nodeOrZone, intervalStart);
  if (!row) {
    const alias = resolveGridAlias(nodeOrZone);
    if (alias) row = getGridPrice(alias, intervalStart);
  }
  if (!row) {
    throw upstreamUnavailable(
      "GRID_CACHE_MISS",
      "no cached price for " + nodeOrZone + " at " + intervalStart,
    );
  }

  // Staleness bound: a row older than GRID_CACHE_TTL_MS is refused, and a
  // legacy row with no ingested_at at all is refused too (its freshness
  // cannot be proven). Neither is ever served as verified 1.0.
  const ingestedMs = Date.parse(row.ingested_at);
  if (!row.ingested_at || Number.isNaN(ingestedMs) || nowMs - ingestedMs > GRID_CACHE_TTL_MS) {
    throw upstreamUnavailable(
      "GRID_CACHE_STALE",
      "cached price for " +
        nodeOrZone +
        " at " +
        intervalStart +
        " is stale (ingested " +
        (row.ingested_at || "unknown") +
        ", older than 1 hour)",
    );
  }

  const upstreamUrl = row.upstream_url || gridFallbackUrl(nodeOrZone, intervalStart);
  const rawBody = JSON.stringify({
    node_or_zone: nodeOrZone,
    interval_start: intervalStart,
    lmp_usd_per_mwh: row.lmp_usd_per_mwh,
    market: row.market,
  });
  const receipt = makeReceipt(
    "GRID_POWER_PRICE_GENERAL",
    upstreamUrl,
    rawBody,
    "1/1 cache row from verified ISO feed",
  );
  // The receipt's fetched_at is the cache-ingest time, not the response
  // time: it states when the upstream row was actually fetched.
  receipt.fetched_at = row.ingested_at;
  const answer =
    "The LMP at " +
    nodeOrZone +
    " was $" +
    row.lmp_usd_per_mwh.toFixed(2) +
    " per MWh for the interval starting " +
    intervalStart +
    ".";
  return envelope(
    "GRID_POWER_PRICE_GENERAL",
    {
      lmp_usd_per_mwh: row.lmp_usd_per_mwh,
      node_or_zone: nodeOrZone,
      market: row.market,
      interval_start: intervalStart,
      currency: "USD",
    },
    receipt,
    { answer, verdict: "verified", confidence: 1.0, source: zone.source },
  );
}
