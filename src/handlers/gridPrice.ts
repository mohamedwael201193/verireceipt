// GET /v1/grid-price — wholesale electricity LMP from the SQLite cache only.
// The handler never fetches an upstream feed and never fabricates a price:
// a cache miss is a 502 GRID_CACHE_MISS. Prices are written to the cache by
// src/jobs/gridIngester.ts from verified keyless ISO feeds (Elering, NYISO,
// CAISO). Settlement windows come from SUPPORTED_ZONES (NYISO 5 min,
// Elering 15 min, CAISO 60 min); the default 1h window applies only if a
// zone ever lacks one.

import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { getGridPrice } from "../core/db";
import { SUPPORTED_ZONES, getGridSource } from "../jobs/gridIngester";

/** ISO-8601 UTC only: trailing Z or +00:00/-00:00 required, no bare local time. */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]00:00)$/;

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
  const start = new Date(rawInterval);
  if (Number.isNaN(start.getTime())) {
    throw badRequest("INVALID_INTERVAL", "interval_start is not a valid datetime");
  }

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
  const intervalEndMs = start.getTime() + windowMin * 60_000;
  if (intervalEndMs > nowMs) {
    const retryAfterSec = Math.max(1, Math.ceil((intervalEndMs - nowMs) / 1000));
    throw unprocessable(
      "FUTURE_INTERVAL",
      "settlement interval starting " + intervalStart + " has not finished yet",
      retryAfterSec,
    );
  }

  const row = getGridPrice(nodeOrZone, intervalStart);
  if (!row) {
    throw upstreamUnavailable(
      "GRID_CACHE_MISS",
      "no cached price for " + nodeOrZone + " at " + intervalStart,
    );
  }

  const upstreamUrl = getGridSource(nodeOrZone, intervalStart) ?? zone.url;
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
