// Grid handler + ingester tests (vitest).
// Unit tests use a temp-file SQLite fixture via SQLITE_PATH (set before any
// getDb() call; getDb() reads the env lazily). The last test is a LIVE test:
// it runs runIngesterOnce() against the real Elering / NYISO / CAISO feeds
// (no mocks) and serves one fetched row through the handler.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDb = join(mkdtempSync(join(tmpdir(), "grid-test-")), "test.sqlite");
process.env.SQLITE_PATH = tmpDb;

import { ApiError } from "../src/core/errors";
import { getDb, saveGridPrice } from "../src/core/db";
import { handleGridPrice } from "../src/handlers/gridPrice";
import {
  eleringMissingZones,
  nyWallString,
  nyWallToUtcMs,
  runIngesterOnce,
  SUPPORTED_ZONES,
} from "../src/jobs/gridIngester";

/** Past instant floored to a 15-min boundary (also a 5-min and 60-min boundary). */
function pastIso(hoursAgo: number): string {
  const ms = Math.floor((Date.now() - hoursAgo * 3600_000) / 900_000) * 900_000;
  return new Date(ms).toISOString();
}

function futureIso(hoursAhead: number): string {
  const ms = Math.floor((Date.now() + hoursAhead * 3600_000) / 900_000) * 900_000;
  return new Date(ms).toISOString();
}

/** ISO instant N minutes ago (exact, for ingested_at values). */
function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(status);
    expect(apiErr.code).toBe(code);
    return apiErr;
  }
  throw new Error("expected ApiError " + status + " " + code + " but call succeeded");
}

describe("handleGridPrice validation", () => {
  it("malformed interval_start -> 400 INVALID_INTERVAL", async () => {
    for (const bad of ["not-a-date", "2026-11-20 05:00:00", "2026-11-20T05:00:00", "2026-13-45T99:99:99Z", ""]) {
      const err = await expectApiError(
        handleGridPrice({ node_or_zone: "EE", interval_start: bad }),
        400,
        "INVALID_INTERVAL",
      );
      expect(err.message).toBeTruthy();
    }
  });

  it("missing params -> 400", async () => {
    await expectApiError(handleGridPrice({ interval_start: pastIso(2) }), 400, "INVALID_NODE");
    await expectApiError(handleGridPrice({ node_or_zone: "EE" }), 400, "INVALID_INTERVAL");
    await expectApiError(handleGridPrice({}), 400, "INVALID_NODE");
  });

  it("future interval -> 422 FUTURE_INTERVAL with retry_after_sec", async () => {
    const err = await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: futureIso(2) }),
      422,
      "FUTURE_INTERVAL",
    );
    expect(typeof err.retryAfterSec).toBe("number");
    expect(err.retryAfterSec as number).toBeGreaterThan(0);
    // 2h ahead + 15-min Elering window: retry is roughly 2h15m in seconds.
    expect(err.retryAfterSec as number).toBeGreaterThan(2 * 3600);
    expect(err.retryAfterSec as number).toBeLessThan(3 * 3600);
  });

  it("unfinished interval (started, not yet settled) -> 422 FUTURE_INTERVAL", async () => {
    // EE window is 15 min: an interval that started 5 min ago has not finished.
    const started = new Date(Date.now() - 5 * 60_000).toISOString();
    const err = await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: started }),
      422,
      "FUTURE_INTERVAL",
    );
    expect(err.retryAfterSec as number).toBeGreaterThan(0);
    expect(err.retryAfterSec as number).toBeLessThanOrEqual(10 * 60);
  });

  it("unsupported zone -> 422 UNSUPPORTED_ZONE", async () => {
    for (const zone of ["MARS_ZONE", "HB_NORTH", "PJM", ""]) {
      if (!zone) continue;
      await expectApiError(
        handleGridPrice({ node_or_zone: zone, interval_start: pastIso(2) }),
        422,
        "UNSUPPORTED_ZONE",
      );
    }
  });

  it("cache miss -> 502 GRID_CACHE_MISS (never fabricates a price)", async () => {
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: "2026-01-01T00:00:00.000Z" }),
      502,
      "GRID_CACHE_MISS",
    );
  });

  it("off-boundary interval -> 422 OFF_BOUNDARY_INTERVAL naming the containing window", async () => {
    const err = await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: "2026-11-19T05:17:00Z" }),
      422,
      "OFF_BOUNDARY_INTERVAL",
    );
    expect(err.message).toContain("05:17");
    expect(err.message).toContain("15-minute");
    expect(err.message).toContain("05:15");
  });

  it("off-boundary NYISO interval names the 5-minute containing window", async () => {
    const err = await expectApiError(
      handleGridPrice({ node_or_zone: "ZONE_J", interval_start: "2026-11-19T05:17:00Z" }),
      422,
      "OFF_BOUNDARY_INTERVAL",
    );
    expect(err.message).toContain("5-minute");
    expect(err.message).toContain("05:15");
  });
});

describe("handleGridPrice cache hit + envelope", () => {
  it("returns exact root fields and a 0x sha256 receipt", async () => {
    const interval = pastIso(2);
    saveGridPrice("EE", interval, 123.45, "Elering EE");
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(123.45);
    expect(res.node_or_zone).toBe("EE");
    expect(res.market).toBe("Elering EE");
    expect(res.interval_start).toBe(interval);
    expect(res.currency).toBe("USD");
    expect(res.verdict).toBe("verified");
    expect(res.confidence).toBe(1.0);
    expect(typeof res.answer).toBe("string");
    expect(res.answer as string).toContain("EE");
    expect(res.answer as string).toContain("123.45");
    expect(res.answer as string).toContain(interval);
    expect(res.source).toBe("Elering dashboard API");
    expect(typeof res.checked_at).toBe("string");
    const receipt = res.receipt as Record<string, unknown>;
    expect(receipt).toBeTruthy();
    expect(receipt.intent).toBe("GRID_POWER_PRICE_GENERAL");
    expect(receipt.receipt_id as string).toMatch(/^rcpt_[A-Z0-9]{26}$/);
    expect(receipt.raw_response_sha256 as string).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.upstream_url as string).toContain("dashboard.elering.ee");
    expect(receipt.quorum_votes).toBe("1/1 cache row from verified ISO feed");
    expect(typeof receipt.fetched_at).toBe("string");
    expect(receipt.audit_url as string).toContain(receipt.receipt_id as string);
  });

  it("NYISO zone aliases resolve through SUPPORTED_ZONES", async () => {
    expect(SUPPORTED_ZONES["ZONE_J"]).toBeTruthy();
    expect(SUPPORTED_ZONES["N.Y.C."]).toBeTruthy();
    expect(SUPPORTED_ZONES["TH_NP15_GEN-APND"]).toBeTruthy();
    const interval = pastIso(3);
    saveGridPrice("ZONE_J", interval, 39.92, "NYISO");
    const res = await handleGridPrice({ node_or_zone: "ZONE_J", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(39.92);
    expect(res.market).toBe("NYISO");
    expect(res.source).toBe("NYISO MIS realtime LBMP CSV");
  });

  it("fractional seconds are normalised to whole seconds before lookup", async () => {
    const interval = pastIso(4);
    saveGridPrice("EE", interval, 77.7, "Elering EE");
    const withMillis = interval.replace("Z", "").replace(/\.000$/, "") + ".123Z";
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: withMillis });
    expect(res.lmp_usd_per_mwh).toBe(77.7);
    expect(res.interval_start).toBe(interval);
  });

  it("two intervals for one zone: each returns its own price, unseeded neighbour is a miss", async () => {
    const t0 = "2026-11-19T05:00:00.000Z";
    const t1 = "2026-11-19T05:15:00.000Z";
    const t2 = "2026-11-19T05:30:00.000Z";
    saveGridPrice("EE", t0, 111.11, "Elering EE");
    saveGridPrice("EE", t1, 222.22, "Elering EE");
    const r0 = await handleGridPrice({ node_or_zone: "EE", interval_start: t0 });
    expect(r0.lmp_usd_per_mwh).toBe(111.11);
    const r1 = await handleGridPrice({ node_or_zone: "EE", interval_start: t1 });
    expect(r1.lmp_usd_per_mwh).toBe(222.22);
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: t2 }),
      502,
      "GRID_CACHE_MISS",
    );
  });

  it("N.Y.C. query serves a row stored only under ZONE_J (alias fallback)", async () => {
    const interval = pastIso(5);
    saveGridPrice("ZONE_J", interval, 39.92, "NYISO");
    const res = await handleGridPrice({ node_or_zone: "N.Y.C.", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(39.92);
    expect(res.market).toBe("NYISO");
  });

  it("ZONE_J query serves a row stored only under N.Y.C. (reverse alias fallback)", async () => {
    const interval = pastIso(6);
    saveGridPrice("N.Y.C.", interval, 41.5, "NYISO");
    const res = await handleGridPrice({ node_or_zone: "ZONE_J", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(41.5);
  });

  it("a price of exactly 0 is served (Nord Pool can clear at 0)", async () => {
    const interval = pastIso(7);
    saveGridPrice("EE", interval, 0, "Elering EE");
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(0);
    expect(res.verdict).toBe("verified");
  });
});

describe("handleGridPrice staleness bound (1 hour)", () => {
  it("59-minute-old row serves as verified", async () => {
    const interval = pastIso(2);
    saveGridPrice("EE", interval, 99.99, "Elering EE", minutesAgoIso(59));
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(99.99);
    expect(res.verdict).toBe("verified");
  });

  it("61-minute-old row -> 502 GRID_CACHE_STALE", async () => {
    const interval = pastIso(3);
    saveGridPrice("EE", interval, 99.99, "Elering EE", minutesAgoIso(61));
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: interval }),
      502,
      "GRID_CACHE_STALE",
    );
  });

  it("48-hour-old and 1-year-old rows -> 502 GRID_CACHE_STALE (never verified 1.0)", async () => {
    const interval48 = pastIso(50);
    saveGridPrice("EE", interval48, 99.99, "Elering EE", minutesAgoIso(48 * 60));
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: interval48 }),
      502,
      "GRID_CACHE_STALE",
    );
    const intervalYear = "2025-11-19T05:00:00.000Z";
    saveGridPrice(
      "EE",
      intervalYear,
      99.99,
      "Elering EE",
      new Date(Date.now() - 365 * 24 * 3600_000).toISOString(),
    );
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: intervalYear }),
      502,
      "GRID_CACHE_STALE",
    );
  });

  it("receipt fetched_at is the row's ingested_at, not the response time", async () => {
    const interval = pastIso(8);
    const ingestedAt = minutesAgoIso(30);
    saveGridPrice("EE", interval, 55.55, "Elering EE", ingestedAt);
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    const receipt = res.receipt as Record<string, unknown>;
    expect(receipt.fetched_at).toBe(ingestedAt);
  });
});

describe("handleGridPrice persisted upstream_url (restart-safe)", () => {
  it("receipt upstream_url is the exact stored URL (no in-memory map needed)", async () => {
    // Simulates a restart: the row was written by an earlier process and
    // this process never ran the ingester, so no in-memory source map exists.
    const interval = pastIso(9);
    const storedUrl =
      "https://mis.nyiso.com/public/csv/realtime/20261119realtime_zone.csv";
    saveGridPrice("ZONE_J", interval, 39.92, "NYISO", minutesAgoIso(10), storedUrl);
    const res = await handleGridPrice({ node_or_zone: "ZONE_J", interval_start: interval });
    const receipt = res.receipt as Record<string, unknown>;
    expect(receipt.upstream_url).toBe(storedUrl);
  });

  it("legacy row with no stored URL falls back to the dated-file pattern, never the bare directory", async () => {
    const interval = "2026-11-19T05:05:00.000Z";
    saveGridPrice("ZONE_J", interval, 39.92, "NYISO", minutesAgoIso(10), "");
    const res = await handleGridPrice({ node_or_zone: "ZONE_J", interval_start: interval });
    const receipt = res.receipt as Record<string, unknown>;
    const url = receipt.upstream_url as string;
    expect(url).toContain("realtime_zone.csv");
    expect(url).not.toBe("https://mis.nyiso.com/public/csv/realtime/");
  });

  it("legacy CAISO row falls back to the full SingleZip URL with query params", async () => {
    const interval = "2026-11-19T03:00:00.000Z";
    saveGridPrice("TH_NP15_GEN-APND", interval, 67.57, "CAISO", minutesAgoIso(10), "");
    const res = await handleGridPrice({
      node_or_zone: "TH_NP15_GEN-APND",
      interval_start: interval,
    });
    const receipt = res.receipt as Record<string, unknown>;
    const url = receipt.upstream_url as string;
    expect(url).toContain("oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP");
    expect(url).toContain("TH_NP15_GEN-APND");
  });
});

describe("NYISO DST conversion (nyWallToUtcMs)", () => {
  function wallTimes(date: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < 288; i++) {
      const mins = i * 5;
      const hh = String(Math.floor(mins / 60)).padStart(2, "0");
      const mm = String(mins % 60).padStart(2, "0");
      out.push(date + " " + hh + ":" + mm + ":00");
    }
    return out;
  }

  it("all 288 wall times round-trip on fall-back day 2026-11-01", () => {
    for (const wall of wallTimes("11/01/2026")) {
      const utcMs = nyWallToUtcMs(wall);
      expect(utcMs).not.toBeNull();
      expect(nyWallString(utcMs as number)).toBe(wall);
    }
  });

  it("all 288 wall times round-trip on control day 2026-10-15", () => {
    for (const wall of wallTimes("10/15/2026")) {
      const utcMs = nyWallToUtcMs(wall);
      expect(utcMs).not.toBeNull();
      expect(nyWallString(utcMs as number)).toBe(wall);
    }
  });

  it("ambiguous 01:30 on fall-back day resolves to the second occurrence (EST, 06:30Z)", () => {
    expect(new Date(nyWallToUtcMs("11/01/2026 01:30:00") as number).toISOString()).toBe(
      "2026-11-01T06:30:00.000Z",
    );
    // First occurrence would have been 05:30Z (EDT); the second wins.
    expect(new Date(nyWallToUtcMs("11/01/2026 01:00:00") as number).toISOString()).toBe(
      "2026-11-01T06:00:00.000Z",
    );
  });
});

describe("Elering missing-zone reporting", () => {
  it("a zone with zero rows appears in failed[]; all zones present -> []", () => {
    const failed = eleringMissingZones({ ee: 38, fi: 0, lv: 38, lt: 38 });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("FI");
    expect(eleringMissingZones({ ee: 38, fi: 38, lv: 38, lt: 38 })).toEqual([]);
  });
});

describe("live ingester (real feeds, no mocks)", () => {
  it(
    "runIngesterOnce fetches real rows and the handler serves one",
    async () => {
      const result = await runIngesterOnce();
      console.log("[grid-test] live ingester result: " + JSON.stringify(result));
      const db = getDb();
      const byMarket = db
        .prepare("SELECT market, COUNT(*) AS n FROM grid_cache GROUP BY market ORDER BY market")
        .all() as Array<{ market: string; n: number }>;
      console.log("[grid-test] rows by market: " + JSON.stringify(byMarket));
      expect(result.fetched).toBeGreaterThan(0);
      const total = byMarket.reduce((sum, r) => sum + r.n, 0);
      expect(total).toBeGreaterThan(0);

      // One fetched row whose settlement interval has finished (cutoff: 1h ago).
      const cutoff = new Date(Date.now() - 3600_000).toISOString();
      const row = db
        .prepare(
          "SELECT node_or_zone, interval_start, lmp_usd_per_mwh, market FROM grid_cache " +
            "WHERE interval_start <= ? ORDER BY interval_start DESC LIMIT 1",
        )
        .get(cutoff) as
        | { node_or_zone: string; interval_start: string; lmp_usd_per_mwh: number; market: string }
        | undefined;
      expect(row).toBeTruthy();
      console.log("[grid-test] serving fetched row: " + JSON.stringify(row));
      const res = await handleGridPrice({
        node_or_zone: row!.node_or_zone,
        interval_start: row!.interval_start,
      });
      expect(res.lmp_usd_per_mwh).toBe(row!.lmp_usd_per_mwh);
      expect(res.node_or_zone).toBe(row!.node_or_zone);
      expect(res.market).toBe(row!.market);
      expect(res.currency).toBe("USD");
      expect(res.verdict).toBe("verified");
      console.log(
        "[grid-test] handler returned LMP " +
          String(res.lmp_usd_per_mwh) +
          " USD/MWh for " +
          row!.node_or_zone +
          " @ " +
          row!.interval_start,
      );
    },
    120_000,
  );
});
