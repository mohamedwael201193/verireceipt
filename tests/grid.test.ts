// Grid handler + ingester tests (vitest).
// Unit tests use a temp-file SQLite fixture via SQLITE_PATH (set before any
// getDb() call; getDb() reads the env lazily). The last test is a LIVE test:
// it runs runIngesterOnce() against the real Elering / NYISO / CAISO feeds
// (no mocks) and serves one fetched row through the handler.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDir = mkdtempSync(join(tmpdir(), "grid-test-"));
const tmpDb = join(tmpDir, "test.sqlite");
process.env.SQLITE_PATH = tmpDb;

// Round-2 J2: remove the temp DB dir after the file's tests run — each
// run used to leak ~6 MB into /tmp (a 512 MB tmpfs shared by every
// agent on this VM), which eventually trips the DB disk guard.
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

import { ApiError } from "../src/core/errors";
import { primaryUpstreamForGridZone } from "../src/core/upstreams";
import { sha256Hex } from "../src/core/receipt";
import { getDb, getGridRevalidate, saveGridPrice } from "../src/core/db";
import {
  handleGridPrice,
  CAISO_SYSTEM_MARKET,
  CAISO_SYSTEM_NODE,
  resolveCaisoHubAlias,
  GRID_UNCONFIRMED_CONFIDENCE,
  GRID_UNCONFIRMED_VERDICT,
} from "../src/handlers/gridPrice";
import {
  eleringMissingZones,
  CAISO_EMPTY_ARCHIVE_ATTEMPTS,
  CAISO_LIVE_ATTEMPTS,
  CAISO_RETRY_DELAY_MS,
  CaisoEmptyArchiveError,
  fetchBuffer,
  fetchCaisoDamLmp,
  fetchText,
  gridFallbackUrl,
  isAllowedGridUpstreamUrl,
  isSettledGridInterval,
  oasisErrorCodeFromPayload,
  nyWallString,
  nyWallToUtcMs,
  parseCaisoIntervalStart,
  resetCaisoLiveInflightForTests,
  resetNyisoLiveInflightForTests,
  runIngesterOnce,
  SUPPORTED_ZONES,
} from "../src/jobs/gridIngester";
// Round-2 pinning-test-only imports (additive; no existing test touched).
import { vi } from "vitest";
import { getGridPrice, purgeGridCacheOverflow } from "../src/core/db";
import { saveGridPriceBatch } from "../src/jobs/gridIngester";
import {
  CAISO_CORRECTION_BUSINESS_DAYS,
  CAISO_DAM_PROVISIONAL_BUSINESS_DAYS,
  GRID_CACHE_MAX_ROWS,
  GRID_REFERENCE_CAISO_NODES,
  GRID_REFERENCE_INTERVAL,
  correctionCloseMs,
  easterSunday,
  gridFinalityPhase,
  GRID_REVALIDATE_COOLDOWN_MS,
  isCaisoBusinessDay,
  isEstonianPublicHoliday,
  isEvictionProtectedRow,
  isStoreableGridIntervalKey,
  isUsFederalOrDayAfterThanksgiving,
  needsGridRevalidation,
  provisionalCloseMs,
  ymdKey,
} from "../src/jobs/gridFinality";

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

/** Start of the last completed CAISO hour (ended 0–60 min ago; not yet settled). */
function lastCompletedCaisoHourIso(nowMs: number = Date.now()): string {
  const windowMs = 3600_000;
  return new Date(Math.floor(nowMs / windowMs) * windowMs - windowMs).toISOString();
}

function isoToCaisoGmt(iso: string): string {
  return iso.replace(".000Z", "-00:00").replace(/Z$/, "-00:00");
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

  it("future interval -> latest finished interval served, honestly labelled", async () => {
    // Ruling (owner, 2026-11-23 02:17 EET): serve the latest FINISHED
    // interval instead of 422 FUTURE_INTERVAL; the answer names the
    // interval actually served and states the requested one was still in
    // progress.
    const servedMs = Math.floor(Date.now() / 900_000) * 900_000 - 900_000;
    const served = new Date(servedMs).toISOString();
    saveGridPrice("EE", served, 88.5, "Elering EE");
    const requested = futureIso(2);
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: requested });
    expect(res.verdict).toBe("verified");
    expect(res.lmp_usd_per_mwh).toBe(88.5);
    expect(res.interval_start).toBe(served);
    expect(res.requested_interval_start).toBe(requested);
    expect(res.interval_substitution).toBe("latest_finished");
    expect(String(res.answer)).toContain("still in progress");
    expect(String(res.answer)).toContain(served);
    // The served interval is never presented as the asked one.
    expect(String(res.answer)).toContain(requested);
  });

  it("unfinished interval (started, not yet settled) -> latest finished interval served", async () => {
    // EE window is 15 min: an interval that started 5 min ago has not finished.
    const servedMs = Math.floor(Date.now() / 900_000) * 900_000 - 900_000;
    const served = new Date(servedMs).toISOString();
    saveGridPrice("EE", served, 77.25, "Elering EE");
    const started = new Date(Math.floor((Date.now() - 5 * 60_000) / 1000) * 1000).toISOString();
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: started });
    expect(res.verdict).toBe("verified");
    expect(res.interval_start).toBe(served);
    expect(res.requested_interval_start).toBe(started);
    expect(String(res.answer)).toContain("latest finished interval starting " + served);
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
  it("returns exact root fields and a bare-64 sha256 receipt", async () => {
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
    // Round-7 O1: hardened prose names the market and the USD code.
    expect(res.answer as string).toContain("Elering EE");
    expect(res.answer as string).toContain("USD");
    expect(res.source).toBe("Elering dashboard API");
    expect(typeof res.checked_at).toBe("string");
    const receipt = res.receipt as Record<string, unknown>;
    expect(receipt).toBeTruthy();
    expect(receipt.intent).toBe("GRID_POWER_PRICE_GENERAL");
    expect(receipt.receipt_id as string).toMatch(/^rcpt_[A-Z0-9]{26}$/);
    expect(receipt.raw_response_sha256 as string).toMatch(/^[0-9a-f]{64}$/);
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
    // Round-7 triple: node + currency + market on the ZONE_J success path.
    expect(res.node_or_zone).toBe("ZONE_J");
    expect(res.market).toBe("NYISO");
    expect(res.currency).toBe("USD");
    expect(res.answer as string).toContain("NYISO");
    expect(res.answer as string).toContain("USD");
    expect(res.source).toBe("NYISO MIS realtime LBMP CSV");
  });

  it("fractional seconds are normalised to whole seconds before lookup", async () => {
    const interval = pastIso(4);
    saveGridPrice("EE", interval, 77.7, "Elering EE");
    const withMillis = interval.replace("Z", "").replace(/\.000$/, "") + ".123Z";
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: withMillis });
    expect(res.lmp_usd_per_mwh).toBe(77.7);
    expect(res.interval_start).toBe(interval);
    // Round-7 triple: fractional-second normalisation keeps node/market/currency.
    expect(res.node_or_zone).toBe("EE");
    expect(res.market).toBe("Elering EE");
    expect(res.currency).toBe("USD");
  });

  it("two intervals for one zone: each returns its own price, unseeded neighbour is a miss", async () => {
    const t0 = "2026-11-19T05:00:00.000Z";
    const t1 = "2026-11-19T05:15:00.000Z";
    const t2 = "2026-11-19T05:30:00.000Z";
    saveGridPrice("EE", t0, 111.11, "Elering EE");
    saveGridPrice("EE", t1, 222.22, "Elering EE");
    const r0 = await handleGridPrice({ node_or_zone: "EE", interval_start: t0 });
    expect(r0.lmp_usd_per_mwh).toBe(111.11);
    // Round-7 triple on both intervals.
    expect(r0.node_or_zone).toBe("EE");
    expect(r0.market).toBe("Elering EE");
    expect(r0.currency).toBe("USD");
    const r1 = await handleGridPrice({ node_or_zone: "EE", interval_start: t1 });
    expect(r1.lmp_usd_per_mwh).toBe(222.22);
    expect(r1.node_or_zone).toBe("EE");
    expect(r1.market).toBe("Elering EE");
    expect(r1.currency).toBe("USD");
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
    // Round-7 triple: alias query emits the QUERY spelling as node.
    expect(res.node_or_zone).toBe("N.Y.C.");
    expect(res.market).toBe("NYISO");
    expect(res.currency).toBe("USD");
  });

  it("ZONE_J query serves a row stored only under N.Y.C. (reverse alias fallback)", async () => {
    const interval = pastIso(6);
    saveGridPrice("N.Y.C.", interval, 41.5, "NYISO");
    const res = await handleGridPrice({ node_or_zone: "ZONE_J", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(41.5);
    // Round-7 triple: reverse-alias query emits the QUERY spelling as node.
    expect(res.node_or_zone).toBe("ZONE_J");
    expect(res.market).toBe("NYISO");
    expect(res.currency).toBe("USD");
  });

  it("a price of exactly 0 is served (Nord Pool can clear at 0)", async () => {
    const interval = pastIso(7);
    saveGridPrice("EE", interval, 0, "Elering EE");
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(0);
    expect(res.verdict).toBe("verified");
    // Round-7 triple: a 0-price row still carries node/market/currency.
    expect(res.node_or_zone).toBe("EE");
    expect(res.market).toBe("Elering EE");
    expect(res.currency).toBe("USD");
  });
});

describe("handleGridPrice staleness bound (1 hour)", () => {
  it("59-minute-old row serves as verified", async () => {
    const interval = pastIso(2);
    saveGridPrice("EE", interval, 99.99, "Elering EE", minutesAgoIso(59));
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(99.99);
    expect(res.verdict).toBe("verified");
    // Round-7 triple: a 59-minute-fresh row still carries node/market/currency.
    expect(res.node_or_zone).toBe("EE");
    expect(res.market).toBe("Elering EE");
    expect(res.currency).toBe("USD");
  });

  it("61-minute-old row on a recent (unsettled) interval -> 502 GRID_CACHE_STALE", async () => {
    const interval = pastIso(2);
    saveGridPrice("EE", interval, 99.99, "Elering EE", minutesAgoIso(61));
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: interval }),
      502,
      "GRID_CACHE_STALE",
    );
  });

  it("48-hour-old ingest on a recent (unsettled) interval -> 502 GRID_CACHE_STALE", async () => {
    // The interval itself is only ~2 h old, so the official provisional
    // window (days, not hours) has not closed; an aged ingested_at is
    // still a freshness failure.
    const interval48 = pastIso(2);
    saveGridPrice("EE", interval48, 99.99, "Elering EE", minutesAgoIso(48 * 60));
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: interval48 }),
      502,
      "GRID_CACHE_STALE",
    );
  });

  it("settled historical Elering row older than the TTL is served (A9)", async () => {
    const intervalYear = "2025-11-19T05:00:00.000Z";
    saveGridPrice(
      "EE",
      intervalYear,
      99.99,
      "Elering EE",
      new Date(Date.now() - 365 * 24 * 3600_000).toISOString(),
    );
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: intervalYear });
    expect(res.lmp_usd_per_mwh).toBe(99.99);
    // Ingested a year ago, before the 3-BD close of 2025-11-19, and
    // Elering has no historical re-fetch: served, but not as verified 1.0 (r3).
    expect(res.verdict).toBe(GRID_UNCONFIRMED_VERDICT);
    expect(res.confidence).toBe(GRID_UNCONFIRMED_CONFIDENCE);
    expect(String(res.source)).toContain("no historical re-fetch");
    expect(String(res.answer)).toMatch(/^Unverified cached price:/);
    expect(String(res.answer)).toContain("no historical re-fetch");
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
    // Round-7 triple: CAISO handler success carries node/market/currency.
    expect(res.node_or_zone).toBe("TH_NP15_GEN-APND");
    expect(res.market).toBe("CAISO");
    expect(res.currency).toBe("USD");
    expect(res.lmp_usd_per_mwh).toBe(67.57);
    const receipt = res.receipt as Record<string, unknown>;
    const url = receipt.upstream_url as string;
    expect(url).toContain("oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP");
    expect(url).toContain("TH_NP15_GEN-APND");
  });
});

// ---------------------------------------------------------------------------
// ROUND-7 GUARD-CRITERION FIX (F1, 2026-11-20). A cache row with market ""
// was stored without complaint and served as verified 1.0 — the handler
// emitted row.market verbatim with no non-empty check. These tests pin the
// three layers: (1) the emission guard refuses a corrupt row at serve
// time, (2) both writers refuse to store one, (3) a rejected batch stores
// nothing, not even its clean rows.
// ---------------------------------------------------------------------------

describe("GRID round-7: empty-market guard (F1)", () => {
  /** Seed a corrupt row the writers would now refuse — direct DB insert,
   *  exactly as the guard-criterion audit's probe did. */
  function seedCorruptRow(node: string, interval: string, market: string): void {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO grid_cache
         (node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(node, interval, 55.55, market, new Date().toISOString(), "");
  }

  it("empty-market cache row -> 502 GRID_CACHE_INVALID, never served as verified", async () => {
    const interval = pastIso(10);
    seedCorruptRow("EE", interval, "");
    // The corrupt row IS in the DB (direct insert bypassed the writers)…
    expect(getGridPrice("EE", interval)?.market).toBe("");
    // …but the handler refuses it at the emission point.
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: interval }),
      502,
      "GRID_CACHE_INVALID",
    );
  });

  it("whitespace-only market cache row -> 502 GRID_CACHE_INVALID", async () => {
    const interval = pastIso(11);
    seedCorruptRow("EE", interval, "   ");
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: interval }),
      502,
      "GRID_CACHE_INVALID",
    );
  });

  it("saveGridPrice with empty market throws and stores nothing", async () => {
    // Fixed far-past interval (2026-01-04), NOT pastIso(12): the live
    // Elering window spans ~24 h, so a pastIso(12) interval IS seedable
    // by the suite's live ingester test (:504, runs before this
    // describe) and this "nothing stored" assertion would see a
    // genuine live row. Same precedent as the F3 interval fix.
    const interval = "2026-01-04T04:00:00.000Z";
    expect(() => saveGridPrice("EE", interval, 55.55, "")).toThrow(/empty/);
    expect(() => saveGridPrice("EE", interval, 55.55, "   ")).toThrow(/empty/);
    expect(() => saveGridPrice("", interval, 55.55, "Elering EE")).toThrow(/empty/);
    expect(getGridPrice("EE", interval)).toBeNull();
  });

  it("saveGridPriceBatch with an empty-market row throws and stores nothing (not even its clean rows)", async () => {
    // Fixed far-past intervals (2026-01-04), NOT pastIso(13/15) — see
    // the comment on the test above: the live Elering window can seed
    // pastIso(13/15) intervals.
    const t0 = "2026-01-04T05:00:00.000Z";
    const t1 = "2026-01-04T06:00:00.000Z";
    const now = new Date().toISOString();
    expect(() =>
      saveGridPriceBatch([
        { node: "EE", intervalStart: t0, lmp: 11.11, market: "Elering EE", ingestedAt: now, upstreamUrl: "" },
        { node: "EE", intervalStart: t1, lmp: 22.22, market: "", ingestedAt: now, upstreamUrl: "" },
      ]),
    ).toThrow(/empty/);
    expect(getGridPrice("EE", t0)).toBeNull();
    expect(getGridPrice("EE", t1)).toBeNull();
    // Empty node in a batch fails the same way.
    expect(() =>
      saveGridPriceBatch([
        { node: "", intervalStart: t0, lmp: 11.11, market: "Elering EE", ingestedAt: now, upstreamUrl: "" },
      ]),
    ).toThrow(/empty/);
    expect(getGridPrice("EE", t0)).toBeNull();
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

// ---------------------------------------------------------------------------
// ROUND-2 PINNING TESTS (Render slowness, 2026-11-20). Additions only:
// no existing test above was edited. Each test kills the mutant named
// in its title; see JUDGE.md §12.4 for the measured basis of every bound.
// ---------------------------------------------------------------------------

describe("nyWallToUtcMs perf budget (round-2 F2 pin)", () => {
  // Bound basis (measured on this VM, round 2, distinct real wall strings):
  // hoisted nyWallToUtcMs 24-79 us/call; the pre-fix shape (fresh
  // Intl.DateTimeFormat per call, replicated below) 141-792 us/call.
  // An absolute bound alone is load-fragile — both sides slow ~2-3x
  // together under load — so the pin is a RATIO measured back-to-back
  // in the same process: the shipped function must be >= 3x faster
  // than the fresh-formatter replica (observed ratio 5.4-6.7x).
  // Mutant A (hoist reverted: fresh formatter per call in the shipped
  // code) makes the shipped function identical to the replica, ratio
  // ~1x, and fails. Each side takes the MIN of 2 reps: a transient
  // load spike can only slow a rep, never speed the fixed code below
  // its true cost.

  /** Pre-fix shape, faithful replica: a fresh formatter per tzOffsetMs call. */
  function nyWallToUtcMsFresh(wall: string): number | null {
    const tzOffsetMs = (utcMs: number): number => {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const parts = fmt.formatToParts(new Date(utcMs));
      const v = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
      return Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second")) - utcMs;
    };
    const nyWallStringFresh = (utcMs: number): string => {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const parts = fmt.formatToParts(new Date(utcMs));
      const v = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
      return v("month") + "/" + v("day") + "/" + v("year") + " " + v("hour") + ":" + v("minute") + ":" + v("second");
    };
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(wall.trim());
    if (!m) return null;
    const wallAsUtc = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]));
    let utcMs = wallAsUtc - tzOffsetMs(wallAsUtc);
    for (let i = 0; i < 4; i++) {
      const next = wallAsUtc - tzOffsetMs(utcMs);
      if (next === utcMs) break;
      utcMs = next;
    }
    const wallNorm =
      m[1].padStart(2, "0") + "/" + m[2].padStart(2, "0") + "/" + m[3] + " " +
      m[4].padStart(2, "0") + ":" + m[5] + ":" + m[6];
    if (
      tzOffsetMs(utcMs) !== tzOffsetMs(utcMs + 3600_000) &&
      nyWallStringFresh(utcMs + 3600_000) === wallNorm
    ) {
      utcMs += 3600_000;
    }
    return utcMs;
  }

  /** 1,152 distinct wall times: 4 days x 288 five-minute slots (incl. fall-back day). */
  function perfWalls(): string[] {
    const out: string[] = [];
    for (const date of ["01/15/2026", "07/04/2026", "10/15/2026", "11/01/2026"]) {
      for (let i = 0; i < 288; i++) {
        const mins = i * 5;
        out.push(
          date + " " +
          String(Math.floor(mins / 60)).padStart(2, "0") + ":" +
          String(mins % 60).padStart(2, "0") + ":00",
        );
      }
    }
    return out;
  }

  function meanUsPerCall(fn: (w: string) => number | null, walls: string[]): number {
    const t0 = process.hrtime.bigint();
    let n = 0;
    for (const w of walls) {
      if (fn(w) !== null) n++;
    }
    const t1 = process.hrtime.bigint();
    // Every wall parses (and the call count keeps the loop honest).
    expect(n).toBe(walls.length);
    return Number(t1 - t0) / 1000 / walls.length;
  }

  it("hoisted nyWallToUtcMs is >=3x faster than the fresh-formatter replica (mutant A)", () => {
    const walls = perfWalls();
    // Identity: the replica computes the same instants as the shipped code.
    for (const w of walls.slice(0, 100)) {
      expect(nyWallToUtcMsFresh(w)).toBe(nyWallToUtcMs(w));
    }
    const shipped = Math.min(
      meanUsPerCall(nyWallToUtcMs, walls),
      meanUsPerCall(nyWallToUtcMs, walls),
    );
    const fresh = Math.min(
      meanUsPerCall(nyWallToUtcMsFresh, walls),
      meanUsPerCall(nyWallToUtcMsFresh, walls),
    );
    console.log(
      "[grid-test] perf pin: shipped=" + shipped.toFixed(1) + "us/call fresh-replica=" +
      fresh.toFixed(1) + "us/call ratio=" + (fresh / shipped).toFixed(2) + "x",
    );
    expect(fresh / shipped).toBeGreaterThanOrEqual(3);
    // Loose absolute sanity ceiling: ~3x above the worst hoisted mean
    // observed on this VM (79 us/call). The ratio above is the real
    // pin; this only guards against absurd absolute slowness.
    expect(shipped).toBeLessThan(200);
  });
});

describe("saveGridPriceBatch transaction (round-2 J1 remedy pin)", () => {
  it("a failing insert mid-batch rolls the whole batch back (mutant C: autocommit)", () => {
    const seedAt = "2026-11-18T05:00:00.000Z";
    saveGridPriceBatch([
      { node: "EE", intervalStart: seedAt, lmp: 1.5, market: "Elering EE", ingestedAt: seedAt, upstreamUrl: "seed" },
    ]);
    expect(getGridPrice("EE", seedAt)?.lmp_usd_per_mwh).toBe(1.5);
    expect(() =>
      saveGridPriceBatch([
        { node: "EE", intervalStart: "2026-11-18T05:15:00.000Z", lmp: 2.5, market: "Elering EE", ingestedAt: seedAt, upstreamUrl: "batch" },
        // NULL into a NOT NULL column: the batch must throw...
        { node: "EE", intervalStart: null as unknown as string, lmp: 3.5, market: "Elering EE", ingestedAt: seedAt, upstreamUrl: "batch" },
        { node: "EE", intervalStart: "2026-11-18T05:30:00.000Z", lmp: 4.5, market: "Elering EE", ingestedAt: seedAt, upstreamUrl: "batch" },
      ]),
    ).toThrow();
    // ...and roll back: neither the row before nor after the bad row is present.
    // (With the transaction removed / autocommit restored, the first row
    // would already be committed and this assertion would fail.)
    expect(getGridPrice("EE", "2026-11-18T05:15:00.000Z")).toBeNull();
    expect(getGridPrice("EE", "2026-11-18T05:30:00.000Z")).toBeNull();
    // The earlier committed batch survives untouched.
    expect(getGridPrice("EE", seedAt)?.lmp_usd_per_mwh).toBe(1.5);
  });

  it("a batch writes every row, re-running it replaces values, empty batch is a no-op", () => {
    const at = "2026-11-18T06:00:00.000Z";
    saveGridPriceBatch([
      { node: "EE", intervalStart: at, lmp: 10, market: "Elering EE", ingestedAt: at, upstreamUrl: "batch" },
      { node: "FI", intervalStart: at, lmp: 20, market: "Elering FI", ingestedAt: at, upstreamUrl: "batch" },
    ]);
    expect(getGridPrice("EE", at)?.lmp_usd_per_mwh).toBe(10);
    expect(getGridPrice("FI", at)?.lmp_usd_per_mwh).toBe(20);
    // INSERT OR REPLACE, like saveGridPrice: same keys, new value wins.
    saveGridPriceBatch([
      { node: "EE", intervalStart: at, lmp: 99, market: "Elering EE", ingestedAt: at, upstreamUrl: "batch" },
    ]);
    expect(getGridPrice("EE", at)?.lmp_usd_per_mwh).toBe(99);
    expect(getGridPrice("FI", at)?.lmp_usd_per_mwh).toBe(20);
    expect(() => saveGridPriceBatch([])).not.toThrow();
  });
});

describe("NYISO yield pin (round-2 F3/M3)", () => {
  it("an all-bad NYISO file still yields to the loop every 250 lines (mutant B / M3)", async () => {
    // 600 data lines, ALL bad, covering all three bad-row paths: an
    // unparseable timestamp on a real zone name, a non-finite LBMP,
    // and an unknown interface name. Before the M3 fix, bad rows
    // `continue`d past the yield check, so an all-bad file never
    // yielded; with the yields removed (mutant B) nothing yields either.
    // Either regression shows up here as zero setImmediate calls.
    // NOTE: the zone name MUST be a real CSV Name ("N.Y.C."), not the
    // "ZONE_J" alias — the CSV never carries "ZONE_J", so that spelling
    // takes the unknown-interface branch and would yield via it,
    // defeating the M3 half of this pin.
    const header =
      '"Time Stamp","Name","PTID","LBMP ($/MWHr)","Marginal Cost Losses ($/MWHr)","Marginal Cost Congestion ($/MWHr)"';
    const lines = [header];
    for (let i = 0; i < 400; i++) lines.push('"not-a-time","N.Y.C.",61757,35.39,1.26,0.00');
    for (let i = 0; i < 100; i++) lines.push('"11/19/2026 00:05:00","N.Y.C.",61757,abc,1.26,0.00');
    for (let i = 0; i < 100; i++) lines.push('"11/19/2026 00:05:00","H Q",61757,35.39,1.26,0.00');
    const csv = lines.join("\n");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("realtime_zone.csv")) return new Response(csv, { status: 200 });
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    // Structural pin, not a wall-clock bound: count the setImmediate
    // yields the ingester awaits. A wall-clock heartbeat bound would be
    // flaky by design on this loaded VM; counting the yields is
    // deterministic and kills mutant B exactly.
    const origSetImmediate = globalThis.setImmediate;
    let yieldCalls = 0;
    (globalThis as unknown as { setImmediate: typeof setImmediate }).setImmediate = ((
      cb: (...a: unknown[]) => void,
      ...args: unknown[]
    ) => {
      yieldCalls++;
      return (origSetImmediate as (...a: unknown[]) => unknown)(cb, ...args) as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      const result = await runIngesterOnce();
      // Nothing usable: NYISO fails (all rows bad), FX/Elering/CAISO
      // are stubbed to fail. The cycle still completes and logs.
      expect(result.fetched).toBe(0);
      expect(result.failed.join(" ")).toContain("NYISO");
    } finally {
      globalThis.setImmediate = origSetImmediate;
      globalThis.fetch = realFetch;
    }
    // 600 lines x 2 day files = 1,200 processed lines -> a yield at
    // every 250th line: 2 per file, 4 total.
    expect(yieldCalls).toBeGreaterThanOrEqual(4);
  });
});

describe("ingester guard: run.end() throwing (round-2 M1)", () => {
  it("a throwing run.end() does not permanently kill the ingester", async () => {
    vi.useFakeTimers();
    const { startIngester } = await import("../src/jobs/gridIngester");
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls++;
      return Promise.reject(new Error("stubbed upstream failure"));
    }) as typeof fetch;
    // recordJobDuration() logs its completion line via console.log;
    // make ONLY that line throw, so run.end() throws. (The skip line
    // must not throw: on mutant code the skipped ticks would then throw
    // out of recordJobSkipped instead of being counted.)
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("completed in")) {
        throw new Error("log boom");
      }
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const timer = startIngester(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      // One full cycle makes 6 fetch calls (FX + 2x NYISO + 3x CAISO).
      // Initial run + 3 ticks = 4 cycles = 24 calls when healthy; if
      // the flag stuck after the first throwing end() (mutant E), later
      // ticks are skipped and the count stays at 6.
      expect(fetchCalls).toBeGreaterThanOrEqual(12);
      clearInterval(timer);
    } finally {
      globalThis.fetch = realFetch;
      logSpy.mockRestore();
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// ROUND-2 J2 FIXES (F1 blocker + M1-M6). Additions only: no existing test
// above was edited. Each test pins the finding named in its title; see
// JUDGE.md §4 (grid receipt exception) and §6 (grid notes).
// ---------------------------------------------------------------------------

describe("GRID round-2 J2: receipt hash covers constructed row JSON (F1)", () => {
  it("raw_response_sha256 recomputes from the four answer fields, exact key order", async () => {
    const interval = pastIso(10);
    saveGridPrice("EE", interval, 123.45, "Elering EE");
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    const receipt = res.receipt as Record<string, unknown>;
    // Exactly the object the handler stringifies (src/handlers/gridPrice.ts):
    // key order node_or_zone, interval_start, lmp_usd_per_mwh, market.
    // This is the recomputation procedure documented in JUDGE.md §4.
    expect(receipt.raw_response_sha256).toBe(
      sha256Hex(
        JSON.stringify({
          node_or_zone: "EE",
          interval_start: interval,
          lmp_usd_per_mwh: 123.45,
          market: "Elering EE",
        }),
      ),
    );
  });

  it("recomputation also holds for a zero price (number-formatting pin)", async () => {
    const interval = pastIso(11);
    saveGridPrice("EE", interval, 0, "Elering EE");
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    const receipt = res.receipt as Record<string, unknown>;
    expect(receipt.raw_response_sha256).toBe(
      sha256Hex(
        JSON.stringify({
          node_or_zone: "EE",
          interval_start: interval,
          lmp_usd_per_mwh: 0,
          market: "Elering EE",
        }),
      ),
    );
  });
});

describe("GRID round-2 J2: future ingested_at is refused (M1)", () => {
  it("row ingested 60 minutes in the future -> 502 GRID_CACHE_STALE (never verified)", async () => {
    const interval = pastIso(12);
    saveGridPrice(
      "EE",
      interval,
      99.99,
      "Elering EE",
      new Date(Date.now() + 60 * 60_000).toISOString(),
    );
    const err = await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: interval }),
      502,
      "GRID_CACHE_STALE",
    );
    expect(err.message).toContain("future");
  });

  it("row ingested 5 seconds in the future -> 502 GRID_CACHE_STALE (no tolerance)", async () => {
    const interval = pastIso(13);
    saveGridPrice(
      "EE",
      interval,
      99.99,
      "Elering EE",
      new Date(Date.now() + 5_000).toISOString(),
    );
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: interval }),
      502,
      "GRID_CACHE_STALE",
    );
  });

  it("row ingested just now still serves (control: the guard refuses only the future)", async () => {
    const interval = pastIso(14);
    saveGridPrice("EE", interval, 99.99, "Elering EE", new Date().toISOString());
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(99.99);
    expect(res.verdict).toBe("verified");
    // Round-7 triple (same success shape as the 59-minute-fresh path).
    expect(res.node_or_zone).toBe("EE");
    expect(res.market).toBe("Elering EE");
    expect(res.currency).toBe("USD");
  });
});

describe("GRID round-2 J2: CAISO datetime parsing (M2)", () => {
  it("accepts the live CAISO shape (full ISO with explicit zone)", () => {
    expect(parseCaisoIntervalStart("2026-11-19T21:00:00-00:00")).toBe(
      Date.UTC(2026, 10, 19, 21, 0, 0),
    );
    expect(parseCaisoIntervalStart("2026-11-19T21:00:00Z")).toBe(
      Date.UTC(2026, 10, 19, 21, 0, 0),
    );
    expect(parseCaisoIntervalStart("2026-11-19T21:00:00+00:00")).toBe(
      Date.UTC(2026, 10, 19, 21, 0, 0),
    );
    expect(parseCaisoIntervalStart("2026-11-19T21:00:00.000-00:00")).toBe(
      Date.UTC(2026, 10, 19, 21, 0, 0),
    );
    // A non-UTC offset is honoured as written (CAISO emits -00:00; the
    // parser takes the offset, it does not assume UTC).
    expect(parseCaisoIntervalStart("2026-11-19T21:00:00-05:00")).toBe(
      Date.UTC(2026, 10, 20, 2, 0, 0),
    );
  });

  it("rejects every shape a bare Date.parse() would silently accept or misread", () => {
    for (const bad of [
      "",
      "garbage",
      "2026-11-19", // date-only: Date.parse takes it as midnight UTC
      "11/19/2026 21:00:00", // US format: Date.parse takes it as LOCAL time
      "2026-11-19T21:00:00", // naive: Date.parse takes it as LOCAL time
      "2026-11-19T25:00:00-00:00", // invalid hour
      "2026-13-19T21:00:00-00:00", // invalid month
      "2026-11-19 21:00:00-00:00", // space separator, not the CAISO shape
    ]) {
      expect(parseCaisoIntervalStart(bad)).toBeNull();
    }
  });

  it("legacy CAISO fallback URL carries the interval's 1-hour window", () => {
    const url = gridFallbackUrl("TH_NP15_GEN-APND", "2026-11-19T03:00:00.000Z");
    expect(url).toContain("oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP");
    expect(url).toContain("startdatetime=20261119T03:00-0000");
    expect(url).toContain("enddatetime=20261119T04:00-0000");
    expect(url).toContain("TH_NP15_GEN-APND");
  });
});

describe("GRID round-2 J2: Elering missing-zone on throw (M3)", () => {
  it("Elering fetch throwing names all four missing zones, writes nothing, cycle survives", async () => {
    const realFetch = globalThis.fetch;
    const db = getDb();
    const before = (
      db
        .prepare("SELECT COUNT(*) AS n FROM grid_cache WHERE market LIKE 'Elering%'")
        .get() as { n: number }
    ).n;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("open.er-api.com")) {
        return new Response(JSON.stringify({ rates: { USD: 1.09 } }), { status: 200 });
      }
      if (u.includes("elering")) throw new Error("boom: Elering down");
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const result = await runIngesterOnce();
      // No crash: the cycle returns, and the other sources still ran
      // (their stub failures are recorded too).
      expect(result.fetched).toBe(0);
      const eleringEntry = result.failed.find((f) => f.startsWith("Elering:"));
      expect(eleringEntry).toBeTruthy();
      expect(eleringEntry as string).toContain("EE, FI, LV, LT");
      expect(result.failed.join(" ")).toContain("NYISO");
      expect(result.failed.join(" ")).toContain("CAISO");
      const after = (
        db
          .prepare("SELECT COUNT(*) AS n FROM grid_cache WHERE market LIKE 'Elering%'")
          .get() as { n: number }
      ).n;
      expect(after).toBe(before);
    } finally {
      globalThis.fetch = realFetch;
    }
    // And the handler serves no Elering price for an unseeded interval:
    // 502 GRID_CACHE_MISS, never a wrong zone's price.
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: "2026-01-03T00:00:00.000Z" }),
      502,
      "GRID_CACHE_MISS",
    );
  });

  it("Elering returning zero rows for every zone names the zones in failed[]", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("open.er-api.com")) {
        return new Response(JSON.stringify({ rates: { USD: 1.09 } }), { status: 200 });
      }
      if (u.includes("elering")) {
        return new Response(
          JSON.stringify({ success: true, data: { ee: [], fi: [], lv: [], lt: [] } }),
          { status: 200 },
        );
      }
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const result = await runIngesterOnce();
      expect(result.fetched).toBe(0);
      const eleringEntry = result.failed.find((f) => f.startsWith("Elering:"));
      expect(eleringEntry).toBeTruthy();
      for (const zone of ["EE", "FI", "LV", "LT"]) {
        expect(eleringEntry as string).toContain("zone " + zone + " yielded zero rows");
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID round-2 J2: NYISO spring-forward gap (M4)", () => {
  it("gap wall times map forward onto the 03:xx EDT hour (never a made-up instant)", () => {
    expect(new Date(nyWallToUtcMs("03/08/2026 02:00:00") as number).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(new Date(nyWallToUtcMs("03/08/2026 02:30:00") as number).toISOString()).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(new Date(nyWallToUtcMs("03/08/2026 02:55:00") as number).toISOString()).toBe(
      "2026-03-08T07:55:00.000Z",
    );
  });

  it("gap wall times do NOT round-trip, and collide 1:1 with the real 03:xx rows", () => {
    for (let i = 0; i < 12; i++) {
      const mm = String(i * 5).padStart(2, "0");
      const gapMs = nyWallToUtcMs("03/08/2026 02:" + mm + ":00") as number;
      // The wall string of the mapped instant is the 03:xx hour, not the input.
      expect(nyWallString(gapMs)).toBe("03/08/2026 03:" + mm + ":00");
      // The mapped instant IS the real 03:xx instant: in the ingester the
      // chronological CSV lets the later real row win the INSERT OR REPLACE.
      expect(gapMs).toBe(nyWallToUtcMs("03/08/2026 03:" + mm + ":00"));
    }
  });

  it("every non-gap wall time on spring-forward day round-trips", () => {
    for (let i = 0; i < 288; i++) {
      const mins = i * 5;
      const hh = String(Math.floor(mins / 60)).padStart(2, "0");
      const mm = String(mins % 60).padStart(2, "0");
      if (hh === "02") continue; // the 12 gap slots, covered above
      const wall = "03/08/2026 " + hh + ":" + mm + ":00";
      const utcMs = nyWallToUtcMs(wall);
      expect(utcMs).not.toBeNull();
      expect(nyWallString(utcMs as number)).toBe(wall);
    }
  });
});

describe("GRID round-2 J2: upstream allowlist (M5)", () => {
  it("the four upstream origins pass; lookalikes, downgrades and garbage are refused", () => {
    for (const ok of [
      "https://dashboard.elering.ee/api/nps/price",
      "https://mis.nyiso.com/public/csv/realtime/20261120realtime_zone.csv",
      "https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP&market_run_id=DAM&node=TH_NP15_GEN-APND&resultformat=6",
      "https://open.er-api.com/v6/latest/EUR",
    ]) {
      expect(isAllowedGridUpstreamUrl(ok)).toBe(true);
    }
    for (const bad of [
      "https://evil.example.com/x",
      "http://mis.nyiso.com/public/csv/realtime/20261120realtime_zone.csv", // http, not https
      "https://mis.nyiso.com.evil.com/x", // suffix lookalike
      "https://dashboard.elering.ee.evil.com/api/nps/price",
      "https://oasis.caiso.com@evil.com/oasisapi/SingleZip", // userinfo trick: host is evil.com
      "ftp://mis.nyiso.com/x",
      "not-a-url",
      "",
    ]) {
      expect(isAllowedGridUpstreamUrl(bad)).toBe(false);
    }
  });

  it("fetchText/fetchBuffer refuse an off-list URL without performing any fetch", async () => {
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("should never be fetched", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(fetchText("https://evil.example.com/steal")).rejects.toThrow(
        /non-allowlisted/,
      );
      await expect(fetchBuffer("https://evil.example.com/steal.zip")).rejects.toThrow(
        /non-allowlisted/,
      );
      expect(fetchCalls).toBe(0);
      // And an allowlisted URL DOES go through the fetch.
      await expect(fetchText("https://dashboard.elering.ee/api/nps/price")).resolves.toBe(
        "should never be fetched",
      );
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID round-2 J2: refusal-matrix gaps (M6)", () => {
  it("CAISO off-boundary interval -> 422 OFF_BOUNDARY_INTERVAL naming the 60-minute window", async () => {
    const err = await expectApiError(
      handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-19T03:30:00Z" }),
      422,
      "OFF_BOUNDARY_INTERVAL",
    );
    expect(err.message).toContain("03:30");
    expect(err.message).toContain("60-minute");
    expect(err.message).toContain("03:00");
  });

  it("non-UTC offset interval -> 400 INVALID_INTERVAL; +00:00 is accepted", async () => {
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: "2026-11-20T05:00:00+02:00" }),
      400,
      "INVALID_INTERVAL",
    );
    const interval = pastIso(15);
    saveGridPrice("EE", interval, 42.42, "Elering EE");
    const plusZero = interval.replace("Z", "+00:00");
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: plusZero });
    expect(res.lmp_usd_per_mwh).toBe(42.42);
    expect(res.interval_start).toBe(interval);
  });

  it("lowercase Elering zone resolves to the same canonical cached source row", async () => {
    const interval = pastIso(2);
    saveGridPrice("EE", interval, 42.42, "Elering EE");
    const canonical = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    const lower = await handleGridPrice({ node_or_zone: "ee", interval_start: interval });
    for (const key of ["node_or_zone", "market", "interval_start", "currency", "lmp_usd_per_mwh"]) {
      expect(lower[key]).toEqual(canonical[key]);
    }
    expect(lower.node_or_zone).toBe("EE");
    expect(lower.lmp_usd_per_mwh).toBe(42.42);
  });

  it("legacy row with empty ingested_at -> 502 GRID_CACHE_STALE (freshness unprovable)", async () => {
    const interval = pastIso(16);
    saveGridPrice("EE", interval, 99.99, "Elering EE", "");
    await expectApiError(
      handleGridPrice({ node_or_zone: "EE", interval_start: interval }),
      502,
      "GRID_CACHE_STALE",
    );
  });

  it("cold start on an unseeded zone -> 502 GRID_CACHE_MISS (empty DB, never fabricated)", async () => {
    // LT at 2026-01-02 was never seeded by any test in this file: on the
    // fresh temp DB this is the empty-DB path (the first-run ingester
    // has not written anything for it either).
    await expectApiError(
      handleGridPrice({ node_or_zone: "LT", interval_start: "2026-01-02T00:00:00.000Z" }),
      502,
      "GRID_CACHE_MISS",
    );
  });
});

// ---------------------------------------------------------------------------
// ROUND-3 FIXES (J2 round-2 FAILs M2/M5/M3 + secondaries M4/F1).
// Additions only: no existing test above was edited. Each test pins the
// finding named in its title; see JUDGE.md §4 (grid receipt exception)
// and §6 (grid notes, round-3 bullet).
// ---------------------------------------------------------------------------

import { deflateRawSync } from "zlib";

// PG-MIGRATE (2026-11-21): this file is SQLite white-box — it seeds grid_cache through raw SQLite SQL and the sync SQLite writers.
// Pinned to the SQLite backend even when the suite runs with DATABASE_URL;
// the same semantics are asserted on Postgres in tests/pg-store.test.ts.
import { __setStorageBackendForTests } from "../src/core/storage";
__setStorageBackendForTests("sqlite");

/** Minimal one-file deflate zip (local header + central dir + EOCD), matching unzipSingleFile's parser. Copied from J2 probe D. */
function makeCaisoZip(name: string, content: string): Buffer {
  const data = Buffer.from(content, "utf8");
  const comp = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const nameBuf = Buffer.from(name, "utf8");
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, nameBuf, comp, cd, nameBuf, eocd]);
}
function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

describe("GRID round-3: CAISO rollover rejection (M2)", () => {
  it("the 5 rollover shapes -> null (Date.parse would roll each forward)", () => {
    for (const bad of [
      "2026-02-30T21:00:00Z", // Feb 30 -> Mar 2 under Date.parse
      "2026-11-19T24:00:00Z", // hour 24 -> next day 00:00
      "2026-11-31T21:00:00Z", // Nov 31 -> Dec 1
      "2026-04-31T21:00:00Z", // Apr 31 -> May 1
      "2026-02-29T21:00:00Z", // 2026 is not a leap year -> Mar 1
    ]) {
      expect(parseCaisoIntervalStart(bad)).toBeNull();
    }
    // Rollover with an explicit non-UTC offset is rejected too.
    expect(parseCaisoIntervalStart("2026-02-30T21:00:00-00:00")).toBeNull();
    expect(parseCaisoIntervalStart("2026-11-19T24:00:00-05:00")).toBeNull();
  });

  it("leap-year and month-end boundaries still accept (no over-rejection)", () => {
    // 2024 IS a leap year: Feb 29 is real.
    expect(parseCaisoIntervalStart("2024-02-29T21:00:00Z")).toBe(
      Date.UTC(2024, 1, 29, 21, 0, 0),
    );
    // 2000 is a leap year (divisible by 400); 1900 is not.
    expect(parseCaisoIntervalStart("2000-02-29T00:00:00Z")).toBe(
      Date.UTC(2000, 1, 29, 0, 0, 0),
    );
    expect(parseCaisoIntervalStart("1900-02-29T00:00:00Z")).toBeNull();
    expect(parseCaisoIntervalStart("2026-02-28T23:59:59Z")).toBe(
      Date.UTC(2026, 1, 28, 23, 59, 59),
    );
    expect(parseCaisoIntervalStart("2026-11-30T21:00:00Z")).toBe(
      Date.UTC(2026, 10, 30, 21, 0, 0),
    );
    // Fractional seconds and offsets still parse exactly.
    expect(parseCaisoIntervalStart("2026-11-19T21:00:00.500Z")).toBe(
      Date.UTC(2026, 10, 19, 21, 0, 0, 500),
    );
    expect(parseCaisoIntervalStart("2026-11-19T21:00:00-05:00")).toBe(
      Date.UTC(2026, 10, 20, 2, 0, 0),
    );
    // Offset components are range-checked too.
    expect(parseCaisoIntervalStart("2026-11-19T21:00:00+24:00")).toBeNull();
    expect(parseCaisoIntervalStart("2026-11-19T21:00:00+00:60")).toBeNull();
    expect(parseCaisoIntervalStart("2026-11-19T21:60:00Z")).toBeNull();
    expect(parseCaisoIntervalStart("2026-11-19T21:00:60Z")).toBeNull();
    expect(parseCaisoIntervalStart("2026-00-19T21:00:00Z")).toBeNull();
  });

  it("end-to-end: stubbed CAISO zip with Feb-30 + hour-24 rows caches neither (J2 probe D)", async () => {
    const header =
      "INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,OPR_DT,OPR_HR,OPR_INTERVAL,NODE_ID_XML,NODE_ID,NODE,MARKET_RUN_ID,LMP_TYPE,XML_DATA_ITEM,PNODE_RESMRID,GRP_TYPE,POS,MW,GROUP";
    const validRow =
      "2026-11-19T03:00:00-00:00,2026-11-19T04:00:00-00:00,2026-11-18,20,0,TH_NP15_GEN-APND,TH_NP15_GEN-APND,TH_NP15_GEN-APND,DAM,LMP,LMP_PRC,TH_NP15_GEN-APND,ALL_APNODES,0,60.16249,1";
    const feb30Row =
      "2026-02-30T21:00:00-00:00,2026-03-01T22:00:00-00:00,2026-02-28,21,0,TH_NP15_GEN-APND,TH_NP15_GEN-APND,TH_NP15_GEN-APND,DAM,LMP,LMP_PRC,TH_NP15_GEN-APND,ALL_APNODES,0,77.77,1";
    const hour24Row =
      "2026-11-19T24:00:00-00:00,2026-11-20T01:00:00-00:00,2026-11-19,24,0,TH_NP15_GEN-APND,TH_NP15_GEN-APND,TH_NP15_GEN-APND,DAM,LMP,LMP_PRC,TH_NP15_GEN-APND,ALL_APNODES,0,88.88,1";
    const zip = makeCaisoZip("PRC_LMP.csv", [header, validRow, feb30Row, hour24Row].join("\n"));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("open.er-api.com")) {
        return new Response(JSON.stringify({ rates: { USD: 1.09 } }), { status: 200 });
      }
      if (u.includes("oasis.caiso.com")) {
        return new Response(new Uint8Array(zip), {
          status: 200,
          headers: { "Content-Type": "application/x-zip-compressed" },
        });
      }
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const result = await runIngesterOnce();
      expect(result.fetched).toBe(1); // only the valid row, once (other nodes filter by node)
      const db = getDb();
      const rows = db
        .prepare(
          "SELECT node_or_zone, interval_start, lmp_usd_per_mwh FROM grid_cache WHERE market='CAISO'",
        )
        .all() as Array<{ node_or_zone: string; interval_start: string; lmp_usd_per_mwh: number }>;
      // Neither rollover row is cached under ANY interval: no row
      // carries either rollover price, and no row sits at the
      // rolled-over interval with that price. (The interval-only
      // check cannot be used here: the suite's live test may have
      // cached a genuine row at 2026-11-20T00:00Z in the shared DB.)
      expect(rows.find((r) => r.lmp_usd_per_mwh === 77.77)).toBeUndefined();
      expect(rows.find((r) => r.lmp_usd_per_mwh === 88.88)).toBeUndefined();
      expect(
        rows.find(
          (r) =>
            r.interval_start === "2026-03-02T21:00:00.000Z" && r.lmp_usd_per_mwh === 77.77,
        ),
      ).toBeUndefined();
      expect(
        rows.find(
          (r) =>
            r.interval_start === "2026-11-20T00:00:00.000Z" && r.lmp_usd_per_mwh === 88.88,
        ),
      ).toBeUndefined();
      // The valid row IS cached, at its own interval.
      const valid = rows.find(
        (r) => r.node_or_zone === "TH_NP15_GEN-APND" && r.lmp_usd_per_mwh === 60.16249,
      );
      expect(valid?.interval_start).toBe("2026-11-19T03:00:00.000Z");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID round-3: redirect allowlist (M5)", () => {
  it("allowlisted 302 -> off-list is REFUSED by fetchText and fetchBuffer; the off-list URL is never fetched", async () => {
    const realFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];
    const fetchModes: unknown[] = [];
    globalThis.fetch = (async (url: unknown, init?: { redirect?: string }) => {
      const u = String(url);
      fetchedUrls.push(u);
      fetchModes.push(init?.redirect);
      if (u === "https://mis.nyiso.com/r") {
        return new Response(null, { status: 302, headers: { location: "https://127.0.0.1:8443/secret" } });
      }
      if (u === "https://mis.nyiso.com/rb") {
        return new Response(null, { status: 302, headers: { location: "https://127.0.0.1:8443/secret.bin" } });
      }
      return new Response("SECRET-EXFILTRATED-VIA-REDIRECT", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(fetchText("https://mis.nyiso.com/r")).rejects.toThrow(/non-allowlisted/);
      await expect(fetchBuffer("https://mis.nyiso.com/rb")).rejects.toThrow(/non-allowlisted/);
      // The off-list target was never fetched: only the two allowlisted
      // initial URLs appear, and the secret body was never returned.
      expect(fetchedUrls).toEqual(["https://mis.nyiso.com/r", "https://mis.nyiso.com/rb"]);
      expect(fetchedUrls.join(" ")).not.toContain("127.0.0.1");
      // Mechanism pin: every hop is issued with redirect:"manual" — the
      // guard is the code's own loop, not undici's default follow. A
      // mutant flipping this to "follow" lets the runtime follow the
      // 302 before the code ever sees the Location, and fails here.
      expect(fetchModes).toEqual(["manual", "manual"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("allowlisted -> allowlisted redirect still works (CAISO's legitimate redirect), incl. relative Location", async () => {
    const realFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      fetchedUrls.push(u);
      if (u === "https://oasis.caiso.com/oasisapi/SingleZip") {
        return new Response(null, { status: 302, headers: { location: "/oasisapi/SingleZip?queryname=PRC_LMP" } });
      }
      if (u === "https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP") {
        return new Response("final-ok", { status: 200 });
      }
      if (u === "https://mis.nyiso.com/abs") {
        return new Response(null, { status: 301, headers: { location: "https://mis.nyiso.com/final.csv" } });
      }
      if (u === "https://mis.nyiso.com/final.csv") {
        return new Response(Buffer.from([1, 2, 3]), { status: 200 });
      }
      throw new Error("unexpected fetch: " + u);
    }) as typeof fetch;
    try {
      await expect(fetchText("https://oasis.caiso.com/oasisapi/SingleZip")).resolves.toBe("final-ok");
      const buf = await fetchBuffer("https://mis.nyiso.com/abs");
      expect(Array.from(buf)).toEqual([1, 2, 3]);
      expect(fetchedUrls).toEqual([
        "https://oasis.caiso.com/oasisapi/SingleZip",
        "https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP",
        "https://mis.nyiso.com/abs",
        "https://mis.nyiso.com/final.csv",
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("hop limit exceeded -> refused (6 allowlisted hops, max 5); redirect with no Location -> refused", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url: unknown) => {
      calls++;
      const n = calls;
      if (String(url).startsWith("https://mis.nyiso.com/noloc")) {
        return new Response(null, { status: 302 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://mis.nyiso.com/hop" + n },
      });
    }) as typeof fetch;
    try {
      await expect(fetchText("https://mis.nyiso.com/hop0")).rejects.toThrow(/hop limit/);
      expect(calls).toBe(6); // initial + 5 follows, then the limit refuses before a 7th
      calls = 0;
      await expect(fetchText("https://mis.nyiso.com/noloc")).rejects.toThrow(/no Location/);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a mid-chain off-list hop is refused even when the final hop would be allowlisted", async () => {
    const realFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      fetchedUrls.push(u);
      if (u === "https://mis.nyiso.com/start") {
        return new Response(null, { status: 302, headers: { location: "https://evil.example.com/mid" } });
      }
      if (u === "https://evil.example.com/mid") {
        return new Response(null, { status: 302, headers: { location: "https://mis.nyiso.com/final" } });
      }
      return new Response("final", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(fetchText("https://mis.nyiso.com/start")).rejects.toThrow(/non-allowlisted/);
      expect(fetchedUrls).toEqual(["https://mis.nyiso.com/start"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID round-3: FX failure names the zones (M3)", () => {
  it("FX fetch failing -> failed[] names all four zones, zero Elering rows written", async () => {
    const realFetch = globalThis.fetch;
    const db = getDb();
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM grid_cache WHERE market LIKE 'Elering%'").get() as { n: number }
    ).n;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("open.er-api.com")) throw new Error("FX down");
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const result = await runIngesterOnce();
      expect(result.fetched).toBe(0);
      const eleringEntry = result.failed.find((f) => f.startsWith("Elering:"));
      expect(eleringEntry).toBeTruthy();
      expect(eleringEntry as string).toContain("missing zones: EE, FI, LV, LT");
      const after = (
        db.prepare("SELECT COUNT(*) AS n FROM grid_cache WHERE market LIKE 'Elering%'").get() as { n: number }
      ).n;
      expect(after).toBe(before);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID round-3: NYISO fall-back positional resolution (M4)", () => {
  it("both 01:xx occurrences survive: first -> EDT (05:xxZ), second -> EST (06:xxZ)", async () => {
    const header =
      '"Time Stamp","Name","PTID","LBMP ($/MWHr)","Marginal Cost Losses ($/MWHr)","Marginal Cost Congestion ($/MWHr)"';
    const lines = [header];
    // Full repeated hour, 01:00-01:55, first occurrence (EDT) priced
    // 100+k, second occurrence (EST) priced 200+k.
    for (let k = 0; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","N.Y.C.",61757,${100 + k},1.26,0.00`);
    }
    for (let k = 0; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","N.Y.C.",61757,${200 + k},1.26,0.00`);
    }
    const csv = lines.join("\n");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("open.er-api.com")) {
        return new Response(JSON.stringify({ rates: { USD: 1.09 } }), { status: 200 });
      }
      if (u.includes("realtime_zone.csv")) return new Response(csv, { status: 200 });
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const result = await runIngesterOnce();
      expect(result.fetched).toBeGreaterThanOrEqual(48); // 24 lines x 2 keys, x2 day files
      // All 12 EDT intervals hold the FIRST price, all 12 EST intervals the second.
      for (let k = 0; k < 12; k++) {
        const mm = String(k * 5).padStart(2, "0");
        const edt = getGridPrice("ZONE_J", `2026-11-01T05:${mm}:00.000Z`);
        const est = getGridPrice("ZONE_J", `2026-11-01T06:${mm}:00.000Z`);
        expect(edt?.lmp_usd_per_mwh).toBe(100 + k);
        expect(est?.lmp_usd_per_mwh).toBe(200 + k);
      }
      // And the handler serves the rescued EDT price as verified (was a 502 before).
      const res = await handleGridPrice({
        node_or_zone: "ZONE_J",
        interval_start: "2026-11-01T05:30:00.000Z",
      });
      expect(res.lmp_usd_per_mwh).toBe(106);
      expect(res.verdict).toBe("verified");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a lone ambiguous row keeps the EST instant (never mislabelled EDT)", async () => {
    // WEST / ZONE_A, not N.Y.C.: the full-hour test above already wrote
    // the 05:30Z/06:30Z ZONE_J rows into the shared test DB, so this
    // lone-row test must use a different zone to assert 05:xx is empty.
    const header =
      '"Time Stamp","Name","PTID","LBMP ($/MWHr)","Marginal Cost Losses ($/MWHr)","Marginal Cost Congestion ($/MWHr)"';
    const csv = [
      header,
      '"11/01/2026 01:30:00","WEST",61757,555.55,1.26,0.00',
    ].join("\n");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("open.er-api.com")) {
        return new Response(JSON.stringify({ rates: { USD: 1.09 } }), { status: 200 });
      }
      if (u.includes("realtime_zone.csv")) return new Response(csv, { status: 200 });
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      await runIngesterOnce();
      expect(getGridPrice("ZONE_A", "2026-11-01T06:30:00.000Z")?.lmp_usd_per_mwh).toBe(555.55);
      expect(getGridPrice("ZONE_A", "2026-11-01T05:30:00.000Z")).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID round-4: fall-back shift gated on a provably chronological repeated hour", () => {
  const header =
    '"Time Stamp","Name","PTID","LBMP ($/MWHr)","Marginal Cost Losses ($/MWHr)","Marginal Cost Congestion ($/MWHr)"';
  async function runStubNyiso(csv: string) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("open.er-api.com")) {
        return new Response(JSON.stringify({ rates: { USD: 1.09 } }), { status: 200 });
      }
      if (u.includes("realtime_zone.csv")) return new Response(csv, { status: 200 });
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      await runIngesterOnce();
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("J2 reversed pair (EST price FIRST, EDT price SECOND): 05:30Z unserved, no swapped verified price", async () => {
    // J2's exact attack rows: EST 222.22 first in file, EDT 111.11 second.
    // Gate is OFF (only 1 of 12 slots duplicated — G1 fails), so nothing
    // is shifted: 05:30Z stays empty instead of serving swapped 222.22.
    const csv = [
      header,
      '"11/01/2026 01:30:00","WEST",61757,222.22,1.26,0.00',
      '"11/01/2026 01:30:00","WEST",61757,111.11,1.26,0.00',
    ].join("\n");
    await runStubNyiso(csv);
    expect(getGridPrice("ZONE_A", "2026-11-01T05:30:00.000Z")).toBeNull();
    // Handler fail-closes on the unserved EDT interval (502, not a price).
    await expectApiError(
      handleGridPrice({ node_or_zone: "ZONE_A", interval_start: "2026-11-01T05:30:00.000Z" }),
      502,
      "GRID_CACHE_MISS",
    );
    // 06:30Z is pre-R3 last-wins residue (111.11, the EDT price, at the
    // EST instant) — NOT a verified EDT/EST split. Pinned so no reader
    // mistakes it for one; the gate guarantees only 05:xxZ, never this.
    expect(getGridPrice("ZONE_A", "2026-11-01T06:30:00.000Z")?.lmp_usd_per_mwh).toBe(111.11);
  });

  it("ordered 12-slot hour WITH chronological neighbours still rescues all 12 EDT + 12 EST", async () => {
    // Genuine-file shape: 00:55 before the hour, 02:00 after it, both
    // blocks ascending — G1+G2+G3 all hold, so the rescue is unchanged.
    const lines = [header];
    lines.push('"11/01/2026 00:55:00","LONGIL",61757,900,1.26,0.00');
    for (let k = 0; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","LONGIL",61757,${100 + k},1.26,0.00`);
    }
    for (let k = 0; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","LONGIL",61757,${200 + k},1.26,0.00`);
    }
    lines.push('"11/01/2026 02:00:00","LONGIL",61757,300,1.26,0.00');
    await runStubNyiso(lines.join("\n"));
    for (let k = 0; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      expect(getGridPrice("ZONE_K", `2026-11-01T05:${mm}:00.000Z`)?.lmp_usd_per_mwh).toBe(100 + k);
      expect(getGridPrice("ZONE_K", `2026-11-01T06:${mm}:00.000Z`)?.lmp_usd_per_mwh).toBe(200 + k);
    }
    expect(getGridPrice("ZONE_K", "2026-11-01T04:55:00.000Z")?.lmp_usd_per_mwh).toBe(900);
    expect(getGridPrice("ZONE_K", "2026-11-01T07:00:00.000Z")?.lmp_usd_per_mwh).toBe(300);
    const res = await handleGridPrice({
      node_or_zone: "ZONE_K",
      interval_start: "2026-11-01T05:30:00.000Z",
    });
    expect(res.lmp_usd_per_mwh).toBe(106);
    expect(res.verdict).toBe("verified");
  });

  it("partial block (only 6 of 12 slots duplicated): gate OFF, EST-only", async () => {
    const lines = [header];
    for (let k = 0; k < 6; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","GENESE",61757,${100 + k},1.26,0.00`);
    }
    for (let k = 0; k < 6; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","GENESE",61757,${200 + k},1.26,0.00`);
    }
    for (let k = 6; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","GENESE",61757,${300 + k},1.26,0.00`);
    }
    await runStubNyiso(lines.join("\n"));
    expect(getGridPrice("ZONE_B", "2026-11-01T05:00:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_B", "2026-11-01T05:30:00.000Z")).toBeNull();
    // EST side keeps pre-R3 last-wins: duplicated slots hold the second
    // row's price, single slots hold their only row's price.
    expect(getGridPrice("ZONE_B", "2026-11-01T06:00:00.000Z")?.lmp_usd_per_mwh).toBe(200);
    expect(getGridPrice("ZONE_B", "2026-11-01T06:30:00.000Z")?.lmp_usd_per_mwh).toBe(306);
  });

  it("full hour with the second block REVERSED: gate OFF (G2), EST-only", async () => {
    const lines = [header];
    for (let k = 0; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","CENTRL",61757,${100 + k},1.26,0.00`);
    }
    // Second block in descending wall order: 01:55 first, 01:00 last.
    for (let j = 0; j < 12; j++) {
      const mm = String((11 - j) * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","CENTRL",61757,${200 + j},1.26,0.00`);
    }
    await runStubNyiso(lines.join("\n"));
    expect(getGridPrice("ZONE_C", "2026-11-01T05:30:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_C", "2026-11-01T05:00:00.000Z")).toBeNull();
    // 01:30's last row in file order is the reversed block's 01:30 (j=5).
    expect(getGridPrice("ZONE_C", "2026-11-01T06:30:00.000Z")?.lmp_usd_per_mwh).toBe(205);
  });

  it("complete ordered hour but a decrease ELSEWHERE in the file: gate OFF (G3), EST-only", async () => {
    const lines = [header];
    lines.push('"11/01/2026 00:55:00","NORTH",61757,900,1.26,0.00');
    for (let k = 0; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","NORTH",61757,${100 + k},1.26,0.00`);
    }
    for (let k = 0; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","NORTH",61757,${200 + k},1.26,0.00`);
    }
    lines.push('"11/01/2026 02:00:00","NORTH",61757,300,1.26,0.00');
    // Corrupt tail: wall time runs backwards (02:00 -> 00:30).
    lines.push('"11/01/2026 00:30:00","NORTH",61757,999,1.26,0.00');
    await runStubNyiso(lines.join("\n"));
    expect(getGridPrice("ZONE_D", "2026-11-01T05:30:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_D", "2026-11-01T06:30:00.000Z")?.lmp_usd_per_mwh).toBe(206);
    // Only the gate is off: the out-of-order row itself still ingests.
    expect(getGridPrice("ZONE_D", "2026-11-01T04:30:00.000Z")?.lmp_usd_per_mwh).toBe(999);
  });

  it("3 rows for one wall stay untouched (lone-row behaviour likewise unchanged)", async () => {
    // J2's 4c shape, now pinned in the suite: gate needs exactly-2
    // groups, so all three rows stay at the EST instant, last wins.
    const csv = [
      header,
      '"11/01/2026 01:30:00","CAPITL",61757,111.11,1.26,0.00',
      '"11/01/2026 01:30:00","CAPITL",61757,222.22,1.26,0.00',
      '"11/01/2026 01:30:00","CAPITL",61757,333.33,1.26,0.00',
    ].join("\n");
    await runStubNyiso(csv);
    expect(getGridPrice("ZONE_F", "2026-11-01T05:30:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_F", "2026-11-01T06:30:00.000Z")?.lmp_usd_per_mwh).toBe(333.33);
  });

  it("trailing extra 01:55 after both complete ordered runs: gate OFF via G1 alone (round-5, J2 recommendation)", async () => {
    // J2's A4b shape, now pinned in the suite: 25 repeated-hour rows —
    // two complete ordered runs, plus one trailing extra 01:55 (price
    // 300) AFTER both runs. G2 holds (runs intact) and G3 holds
    // (exactly 1 decrease, the run-boundary reset), so ONLY G1 fails
    // (01:55 occurs 3x — once per run plus the trailing extra — while
    // every other slot occurs exactly 2x). This is G1's sole
    // independently load-bearing shape in the suite: weakening G1 to
    // presence-only serves 05:30Z = 106 here instead of leaving it
    // empty. Gate OFF = EST-only: no row shifts, 05:xxZ stays empty,
    // 06:xxZ keeps pre-R3 last-wins (06:55Z = 300, the extra row).
    // NODE NOTE: J2's harness runs this shape as LONGIL / ZONE_K, but in
    // THIS file ZONE_K's 05:xxZ rows are already written by the ordered-hour
    // test above (one temp DB per file, no per-test reset — same reason the
    // round-3 lone-row test uses WEST, not N.Y.C.). Shape, prices and
    // expected values below are J2's A4b exactly; only the node label
    // changes, to the untouched MHK VL / ZONE_E.
    const lines = [header];
    lines.push('"11/01/2026 00:55:00","MHK VL",61757,900,1.26,0.00');
    for (let k = 0; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","MHK VL",61757,${100 + k},1.26,0.00`);
    }
    for (let k = 0; k < 12; k++) {
      const mm = String(k * 5).padStart(2, "0");
      lines.push(`"11/01/2026 01:${mm}:00","MHK VL",61757,${200 + k},1.26,0.00`);
    }
    lines.push('"11/01/2026 01:55:00","MHK VL",61757,300,1.26,0.00');
    lines.push('"11/01/2026 02:00:00","MHK VL",61757,400,1.26,0.00');
    await runStubNyiso(lines.join("\n"));
    expect(getGridPrice("ZONE_E", "2026-11-01T05:30:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_E", "2026-11-01T05:00:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_E", "2026-11-01T05:55:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_E", "2026-11-01T06:55:00.000Z")?.lmp_usd_per_mwh).toBe(300);
    expect(getGridPrice("ZONE_E", "2026-11-01T06:30:00.000Z")?.lmp_usd_per_mwh).toBe(206);
  });
});

describe("GRID round-3: NYISO spring-forward gap guard (M4)", () => {
  it("a gap row arriving AFTER the real row no longer overwrites the real price; chronological order still holds the real price; a lone gap row is kept", async () => {
    const header =
      '"Time Stamp","Name","PTID","LBMP ($/MWHr)","Marginal Cost Losses ($/MWHr)","Marginal Cost Congestion ($/MWHr)"';
    const csv = [
      header,
      // Out of order: real 03:30 FIRST, gap 02:30 after it (old code: gap won).
      '"03/08/2026 03:30:00","N.Y.C.",61757,222.22,1.26,0.00',
      '"03/08/2026 02:30:00","N.Y.C.",61757,111.11,1.26,0.00',
      // Chronological: gap 02:00 first, real 03:00 after it (old code: real won; must still win).
      '"03/08/2026 02:00:00","N.Y.C.",61757,111.11,1.26,0.00',
      '"03/08/2026 03:00:00","N.Y.C.",61757,222.22,1.26,0.00',
      // Lone gap row with no real 03:05 row anywhere: kept (interval stays servable).
      '"03/08/2026 02:05:00","N.Y.C.",61757,333.33,1.26,0.00',
    ].join("\n");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("open.er-api.com")) {
        return new Response(JSON.stringify({ rates: { USD: 1.09 } }), { status: 200 });
      }
      if (u.includes("realtime_zone.csv")) return new Response(csv, { status: 200 });
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      await runIngesterOnce();
      expect(getGridPrice("ZONE_J", "2026-03-08T07:30:00.000Z")?.lmp_usd_per_mwh).toBe(222.22);
      expect(getGridPrice("ZONE_J", "2026-03-08T07:00:00.000Z")?.lmp_usd_per_mwh).toBe(222.22);
      expect(getGridPrice("ZONE_J", "2026-03-08T07:05:00.000Z")?.lmp_usd_per_mwh).toBe(333.33);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID round-3: receipt hash is of the fields AS SERVED (F1)", () => {
  it("an alias query hashes the QUERY spelling, not the stored spelling — both spellings recompute from their own response", async () => {
    // Fixed far-past interval, not pastIso(): the suite's live test
    // caches real ZONE_J/N.Y.C. rows at recent intervals, and the
    // handler tries the exact spelling first — a live N.Y.C. row at a
    // pastIso() interval would serve instead of the seeded ZONE_J row.
    const interval = "2026-01-05T05:00:00.000Z";
    saveGridPrice("ZONE_J", interval, 39.92, "NYISO");
    const aliasRes = await handleGridPrice({ node_or_zone: "N.Y.C.", interval_start: interval });
    const aliasReceipt = aliasRes.receipt as Record<string, unknown>;
    expect(aliasReceipt.raw_response_sha256).toBe(
      sha256Hex(
        JSON.stringify({
          node_or_zone: "N.Y.C.",
          interval_start: interval,
          lmp_usd_per_mwh: 39.92,
          market: "NYISO",
        }),
      ),
    );
    const storedRes = await handleGridPrice({ node_or_zone: "ZONE_J", interval_start: interval });
    const storedReceipt = storedRes.receipt as Record<string, unknown>;
    expect(storedReceipt.raw_response_sha256).toBe(
      sha256Hex(
        JSON.stringify({
          node_or_zone: "ZONE_J",
          interval_start: interval,
          lmp_usd_per_mwh: 39.92,
          market: "NYISO",
        }),
      ),
    );
    // Two spellings of one row yield different hashes — that is the
    // documented behaviour, not a bug: the hash covers the fields as
    // served, and each response recomputes from its own fields.
    expect(aliasReceipt.raw_response_sha256).not.toBe(storedReceipt.raw_response_sha256);
  });

  it("answer carries the exact measured decimal while the evidence hash remains unchanged", async () => {
    // Fixed far-past interval, not pastIso(): the live test may cache
    // a real EE row at a recent pastIso() interval with a different price.
    const interval = "2026-01-05T05:00:00.000Z";
    saveGridPrice("EE", interval, 67.57882, "Elering EE");
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: interval });
    // Human wording preserves the same measured decimal as the typed field.
    expect(res.answer as string).toContain("$67.57882");
    // The hash still recomputes from the full-precision field.
    const receipt = res.receipt as Record<string, unknown>;
    expect(receipt.raw_response_sha256).toBe(
      sha256Hex(
        JSON.stringify({
          node_or_zone: "EE",
          interval_start: interval,
          lmp_usd_per_mwh: 67.57882,
          market: "Elering EE",
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// A4 (2026-11-20): on-demand CAISO OASIS day-ahead fetch + CAISO system
// request (GRID-NP15, 2026-11-21: answered for the NP15 trading hub;
// it was a 3-hub median before). Additions only: no existing test above was edited except
// the round-7 guard-code rename in the guard tests (same guard, new
// code string). The live reference test
// deletes the seeded reference rows first, so it proves the on-demand
// fetch instead of re-serving the seed.
// ---------------------------------------------------------------------------

const CAISO_HEADER =
  "INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,OPR_DT,OPR_HR,OPR_INTERVAL,NODE_ID_XML,NODE_ID,NODE,MARKET_RUN_ID,LMP_TYPE,XML_DATA_ITEM,PNODE_RESMRID,GRP_TYPE,POS,MW,GROUP";

function caisoLmpRow(node: string, startGmt: string, endGmt: string, lmp: number): string {
  return (
    startGmt + "," + endGmt + ",2026-11-18,20,0," +
    node + "," + node + "," + node + ",DAM,LMP,LMP_PRC," + node + ",ALL_APNODES,0," +
    String(lmp) + ",1"
  );
}

describe("GRID-NP15: a CAISO request with no node is answered for the NP15 hub (cached hubs, no network)", () => {
  const REF_INTERVAL = "2026-09-13T14:00:00.000Z";
  // The official GRID_POWER_PRICE_GENERAL comparator: tolerance_bps 30.
  const TOLERANCE_BPS = 30;
  // CAISO OASIS PRC_LMP DAM, LMP_PRC, 2026-09-13T14:00Z (fetched live
  // 2026-11-21 by the deployed service; receipt evidence in the build note).
  const OASIS_NP15 = 38.09459;
  const OASIS_SP15 = 36.74434;
  const OASIS_ZP26 = 36.79695;

  /** Seed the three hubs fresh with the live OASIS values for the reference hour. */
  function seedReferenceHubs(): void {
    const now = new Date().toISOString();
    saveGridPrice("TH_NP15_GEN-APND", REF_INTERVAL, OASIS_NP15, "CAISO", now);
    saveGridPrice("TH_SP15_GEN-APND", REF_INTERVAL, OASIS_SP15, "CAISO", now);
    saveGridPrice("TH_ZP26_GEN-APND", REF_INTERVAL, OASIS_ZP26, "CAISO", now);
  }

  function bps(a: number, ref: number): number {
    return (Math.abs(a - ref) / Math.abs(ref)) * 10_000;
  }

  /** No network: a CAISO request that hits a fresh cache must not call OASIS. */
  async function withNoNetwork<T>(fn: () => Promise<T>): Promise<T> {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("NETWORK MUST NOT BE CALLED"))) as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it('the official scored question ("CAISO", 2026-09-13T14:00Z) -> NP15 38.09459, within 30 bps of OASIS NP15', async () => {
    seedReferenceHubs();
    const res = await withNoNetwork(() =>
      handleGridPrice({ node_or_zone: "CAISO", interval_start: "2026-09-13T14:00:00Z" }),
    );
    expect(res.lmp_usd_per_mwh).toBe(OASIS_NP15);
    expect(bps(res.lmp_usd_per_mwh as number, OASIS_NP15)).toBeLessThanOrEqual(TOLERANCE_BPS);
    // The previous 3-hub median (36.79695) is 341 bps off NP15: outside tolerance.
    expect(bps(OASIS_ZP26, OASIS_NP15)).toBeGreaterThan(TOLERANCE_BPS);
    // Disclosure: the node used is named in node_or_zone, market and answer.
    expect(res.node_or_zone).toBe("TH_NP15_GEN-APND");
    expect(res.node_or_zone).toBe(CAISO_SYSTEM_NODE);
    expect(res.market).toBe(CAISO_SYSTEM_MARKET);
    expect(res.market as string).toContain("NP15 trading hub TH_NP15_GEN-APND");
    expect(res.market as string).toContain("request named no CAISO node");
    expect(res.market as string).not.toContain("median");
    expect(res.interval_start).toBe(REF_INTERVAL);
    expect(res.currency).toBe("USD");
    expect(res.verdict).toBe("verified");
    expect(res.confidence).toBe(1.0);
    expect(res.source).toBe("CAISO OASIS PRC_LMP DAM");
    const answer = res.answer as string;
    expect(answer).toContain("NP15 trading hub (TH_NP15_GEN-APND)");
    expect(answer).toContain("$38.09");
    expect(answer).toContain("named no CAISO pricing node");
    expect(answer).toContain("TH_SP15_GEN-APND");
    expect(answer).toContain("TH_ZP26_GEN-APND");
    expect(answer).not.toContain("median");
    // Receipt hash recomputes from the served fields.
    const receipt = res.receipt as Record<string, unknown>;
    expect(receipt.raw_response_sha256).toBe(
      sha256Hex(
        JSON.stringify({
          node_or_zone: "TH_NP15_GEN-APND",
          interval_start: REF_INTERVAL,
          lmp_usd_per_mwh: OASIS_NP15,
          market: CAISO_SYSTEM_MARKET,
        }),
      ),
    );
    expect(receipt.quorum_votes as string).toContain("answered for the NP15 trading hub TH_NP15_GEN-APND");
    expect(receipt.upstream_url as string).toContain("oasis.caiso.com");
    expect(receipt.upstream_url as string).toContain("TH_NP15_GEN-APND");
  });

  it('"CAISO system" / "caiso" / "" / whitespace / "CAISO day-ahead" all resolve to NP15', async () => {
    seedReferenceHubs();
    await withNoNetwork(async () => {
      for (const spelling of [
        "CAISO system",
        "caiso",
        "",
        "   ",
        "CAISO-SYSTEM",
        "caiso_system",
        "CAISO system hub",
        "CAISO day-ahead",
        "CAISO day ahead",
        "CAISO DAM",
        "CAISO DA",
      ]) {
        const res = await handleGridPrice({ node_or_zone: spelling, interval_start: REF_INTERVAL });
        expect(res.lmp_usd_per_mwh).toBe(OASIS_NP15);
        expect(res.node_or_zone).toBe("TH_NP15_GEN-APND");
        expect(res.market).toBe(CAISO_SYSTEM_MARKET);
      }
    });
  });

  it("unsuffixed trading-hub stems preserve each canonical hub and its evidence", async () => {
    seedReferenceHubs();
    await withNoNetwork(async () => {
      for (const [stem, node, value] of [
        ["TH_NP15_GEN", "TH_NP15_GEN-APND", OASIS_NP15],
        ["TH_SP15_GEN", "TH_SP15_GEN-APND", OASIS_SP15],
        ["TH_ZP26_GEN", "TH_ZP26_GEN-APND", OASIS_ZP26],
      ] as const) {
        expect(resolveCaisoHubAlias(stem)).toBe(node);
        const canonical = await handleGridPrice({ node_or_zone: node, interval_start: REF_INTERVAL });
        const alias = await handleGridPrice({ node_or_zone: stem, interval_start: REF_INTERVAL });
        expect(alias.node_or_zone).toBe(node);
        expect(alias.lmp_usd_per_mwh).toBe(value);
        expect(alias.answer).toBe(canonical.answer);
        expect(alias.market).toBe(canonical.market);
        expect((alias.receipt as Record<string, unknown>).raw_response_sha256).toBe(
          (canonical.receipt as Record<string, unknown>).raw_response_sha256,
        );
        expect((alias.receipt as Record<string, unknown>).upstream_url).toBe(
          (canonical.receipt as Record<string, unknown>).upstream_url,
        );
      }
    });
    for (const bad of ["TH_NP15_GEN2", "TH_SP15_GEN-BOGUS", "TH_XYZ_GEN", "TH_NP15_GEN-APND-EXTRA"]) {
      expect(resolveCaisoHubAlias(bad)).toBeUndefined();
      await expectApiError(handleGridPrice({ node_or_zone: bad, interval_start: REF_INTERVAL }), 422, "UNSUPPORTED_ZONE");
    }
  });

  it("the system answer is the NP15 value even when NP15 is the max or the min of the three hubs", async () => {
    const now = new Date().toISOString();
    const t1 = "2026-09-13T15:00:00.000Z";
    saveGridPrice("TH_NP15_GEN-APND", t1, 10, "CAISO", now);
    saveGridPrice("TH_SP15_GEN-APND", t1, 30, "CAISO", now);
    saveGridPrice("TH_ZP26_GEN-APND", t1, 20, "CAISO", now);
    const r1 = await withNoNetwork(() => handleGridPrice({ node_or_zone: "CAISO", interval_start: t1 }));
    expect(r1.lmp_usd_per_mwh).toBe(10);
    const t2 = "2026-09-13T16:00:00.000Z";
    saveGridPrice("TH_NP15_GEN-APND", t2, 50, "CAISO", now);
    saveGridPrice("TH_SP15_GEN-APND", t2, 10, "CAISO", now);
    saveGridPrice("TH_ZP26_GEN-APND", t2, 30, "CAISO", now);
    const r2 = await withNoNetwork(() => handleGridPrice({ node_or_zone: "CAISO", interval_start: t2 }));
    expect(r2.lmp_usd_per_mwh).toBe(50);
  });

  it("the system answer needs only NP15: missing SP15/ZP26 rows do not fail it and trigger no fetch", async () => {
    const t = "2026-09-13T17:00:00.000Z";
    saveGridPrice("TH_NP15_GEN-APND", t, 38.09, "CAISO", new Date().toISOString());
    const res = await withNoNetwork(() => handleGridPrice({ node_or_zone: "CAISO", interval_start: t }));
    expect(res.lmp_usd_per_mwh).toBe(38.09);
    expect(getGridPrice("TH_SP15_GEN-APND", t)).toBeNull();
    expect(getGridPrice("TH_ZP26_GEN-APND", t)).toBeNull();
  });

  it("a missing NP15 hour + failed live fetch -> 502 GRID_CACHE_MISS naming TH_NP15_GEN-APND (never another hub)", async () => {
    const now = new Date().toISOString();
    const t = "2026-09-12T20:00:00.000Z";
    saveGridPrice("TH_SP15_GEN-APND", t, 36.74, "CAISO", now);
    saveGridPrice("TH_ZP26_GEN-APND", t, 36.8, "CAISO", now);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("stubbed OASIS failure"))) as typeof fetch;
    try {
      const err = await expectApiError(
        handleGridPrice({ node_or_zone: "CAISO", interval_start: t }),
        502,
        "GRID_CACHE_MISS",
      );
      expect(err.message).toContain("TH_NP15_GEN-APND");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a settled historical NP15 row older than the TTL is used without a live re-fetch (A9)", async () => {
    const t = "2026-09-13T18:00:00.000Z";
    saveGridPrice("TH_NP15_GEN-APND", t, 38.09, "CAISO", minutesAgoIso(61));
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      fetchCalls++;
      return Promise.reject(new Error("stubbed OASIS failure"));
    }) as typeof fetch;
    try {
      const res = await handleGridPrice({ node_or_zone: "CAISO", interval_start: t });
      expect(res.lmp_usd_per_mwh).toBe(38.09);
      expect(res.verdict).toBe("verified");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a stale NP15 row on a recent unsettled hour + failed re-fetch -> 502 GRID_CACHE_STALE naming the hub", async () => {
    const t = lastCompletedCaisoHourIso();
    saveGridPrice("TH_NP15_GEN-APND", t, 38.09, "CAISO", minutesAgoIso(61));
    saveGridPrice("TH_SP15_GEN-APND", t, 36.74, "CAISO", new Date().toISOString());
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("stubbed OASIS failure"))) as typeof fetch;
    try {
      const err = await expectApiError(
        handleGridPrice({ node_or_zone: "CAISO", interval_start: t }),
        502,
        "GRID_CACHE_STALE",
      );
      expect(err.message).toContain("TH_NP15_GEN-APND");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("an unseeded system hour is fetched live for NP15 only, cached under NP15, and the hub query then hits the same row", async () => {
    const HOUR = "2026-11-18T09:00:00.000Z";
    expect(getGridPrice("TH_NP15_GEN-APND", HOUR)).toBeNull();
    const zip = makeCaisoZip(
      "PRC_LMP.csv",
      [
        CAISO_HEADER,
        caisoLmpRow("TH_NP15_GEN-APND", "2026-11-18T09:00:00-00:00", "2026-11-18T10:00:00-00:00", 41.23456),
      ].join("\n"),
    );
    const realFetch = globalThis.fetch;
    const nodesFetched: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("oasis.caiso.com")) {
        nodesFetched.push(new URL(u).searchParams.get("node") ?? "");
        return new Response(new Uint8Array(zip), { status: 200 });
      }
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const res = await handleGridPrice({ node_or_zone: "CAISO", interval_start: HOUR });
      expect(res.lmp_usd_per_mwh).toBe(41.23456);
      expect(res.node_or_zone).toBe("TH_NP15_GEN-APND");
      expect(res.market).toBe(CAISO_SYSTEM_MARKET);
      expect((res.receipt as Record<string, unknown>).quorum_votes as string).toContain("live CAISO OASIS");
      expect(nodesFetched).toEqual(["TH_NP15_GEN-APND"]);
      expect(getGridPrice("TH_NP15_GEN-APND", HOUR)?.lmp_usd_per_mwh).toBe(41.23456);
      expect(getGridPrice("CAISO", HOUR)).toBeNull();
      // Same cached row for an explicit hub query: plain hub answer, no new fetch.
      const hub = await handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: HOUR });
      expect(hub.lmp_usd_per_mwh).toBe(41.23456);
      expect(hub.market).toBe("CAISO");
      expect(nodesFetched.length).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("explicit hubs keep their own values (SP15 / ZP26 are not answered with NP15)", async () => {
    seedReferenceHubs();
    await withNoNetwork(async () => {
      const sp = await handleGridPrice({ node_or_zone: "TH_SP15_GEN-APND", interval_start: REF_INTERVAL });
      expect(sp.lmp_usd_per_mwh).toBe(OASIS_SP15);
      expect(sp.node_or_zone).toBe("TH_SP15_GEN-APND");
      expect(sp.market).toBe("CAISO");
      expect(sp.answer as string).not.toContain("named no CAISO");
      const zp = await handleGridPrice({ node_or_zone: "TH_ZP26_GEN-APND", interval_start: REF_INTERVAL });
      expect(zp.lmp_usd_per_mwh).toBe(OASIS_ZP26);
      const np = await handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: REF_INTERVAL });
      expect(np.lmp_usd_per_mwh).toBe(OASIS_NP15);
      expect(np.market).toBe("CAISO");
      expect(np.answer as string).toBe(
        `The LMP at TH_NP15_GEN-APND was $${OASIS_NP15} USD per MWh (CAISO) for the interval starting ` + REF_INTERVAL + ".",
      );
    });
  });

  it("hub short names (NP15, CAISO NP15, SP15, ZP26, ...) resolve to the canonical hub; they were 422 before", async () => {
    seedReferenceHubs();
    const cases: Array<[string, string, number]> = [
      ["NP15", "TH_NP15_GEN-APND", OASIS_NP15],
      ["np15", "TH_NP15_GEN-APND", OASIS_NP15],
      ["CAISO NP15", "TH_NP15_GEN-APND", OASIS_NP15],
      ["caiso  np15", "TH_NP15_GEN-APND", OASIS_NP15],
      ["CAISO-NP15", "TH_NP15_GEN-APND", OASIS_NP15],
      ["CAISO_NP15", "TH_NP15_GEN-APND", OASIS_NP15],
      ["NP15 hub", "TH_NP15_GEN-APND", OASIS_NP15],
      ["CAISO NP15 hub", "TH_NP15_GEN-APND", OASIS_NP15],
      ["TH_NP15", "TH_NP15_GEN-APND", OASIS_NP15],
      [" SP15 ", "TH_SP15_GEN-APND", OASIS_SP15],
      ["CAISO SP15", "TH_SP15_GEN-APND", OASIS_SP15],
      ["ZP26", "TH_ZP26_GEN-APND", OASIS_ZP26],
      ["caiso zp26", "TH_ZP26_GEN-APND", OASIS_ZP26],
    ];
    await withNoNetwork(async () => {
      for (const [spelling, node, lmp] of cases) {
        const res = await handleGridPrice({ node_or_zone: spelling, interval_start: REF_INTERVAL });
        expect(res.lmp_usd_per_mwh).toBe(lmp);
        expect(res.node_or_zone).toBe(node);
        expect(res.market).toBe("CAISO");
        const receipt = res.receipt as Record<string, unknown>;
        expect(receipt.raw_response_sha256).toBe(
          sha256Hex(JSON.stringify({ node_or_zone: node, interval_start: REF_INTERVAL, lmp_usd_per_mwh: lmp, market: "CAISO" })),
        );
      }
    });
    for (const [spelling, node] of cases) expect(resolveCaisoHubAlias(spelling)).toBe(node);
  });

  it("near-miss spellings stay 422 UNSUPPORTED_ZONE (no fuzzy match, no prototype keys)", async () => {
    for (const bad of [
      "NP16",
      "NP 15",
      "CAISO NP15X",
      "SP15 ZP26",
      "CAISO system median",
      "caiso np15 gen",
      "toString",
      "__proto__",
      "constructor",
    ]) {
      await expectApiError(
        handleGridPrice({ node_or_zone: bad, interval_start: REF_INTERVAL }),
        422,
        "UNSUPPORTED_ZONE",
      );
      expect(resolveCaisoHubAlias(bad)).toBeUndefined();
    }
  });

  it("a CAISO system request for an unfinished hour substitutes the latest finished hour and fails closed when it is not cached; off-boundary still 422", async () => {
    const future = futureIso(3);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      // No usable cached row for the latest finished hour and the live
      // fetch is down: the request fails closed, never a guess, and never
      // the old FUTURE_INTERVAL refusal.
      await expect(
        handleGridPrice({ node_or_zone: "CAISO", interval_start: future }),
      ).rejects.toMatchObject({ status: 502, code: expect.stringMatching(/^GRID_CACHE_(MISS|STALE)$/) });
    } finally {
      globalThis.fetch = realFetch;
    }
    await expectApiError(
      handleGridPrice({ node_or_zone: "CAISO", interval_start: "2026-09-13T14:15:00Z" }),
      422,
      "OFF_BOUNDARY_INTERVAL",
    );
    await expectApiError(
      handleGridPrice({ node_or_zone: "NP15", interval_start: "2026-09-13T14:15:00Z" }),
      422,
      "OFF_BOUNDARY_INTERVAL",
    );
  });

  it("error attribution: CAISO system + hub short names are attributed to caiso-oasis", () => {
    for (const z of ["CAISO", "NP15", "CAISO NP15", "SP15", "ZP26", "TH_NP15_GEN-APND"]) {
      expect(primaryUpstreamForGridZone(z)).toBe("caiso-oasis");
    }
  });

  it("NYISO aliases are unaffected: N.Y.C. still echoes its own spelling", async () => {
    const t = pastIso(30);
    // The live ingester above seeds BOTH aliases at recent intervals. This
    // fixture exercises fallback only, so remove the exact-key row first.
    // Otherwise the correct exact-key preference returns a live price.
    getDb().prepare("DELETE FROM grid_cache WHERE node_or_zone = ? AND interval_start = ?").run("N.Y.C.", t);
    saveGridPrice("ZONE_J", t, 44.4, "NYISO", new Date().toISOString());
    const res = await withNoNetwork(() => handleGridPrice({ node_or_zone: "N.Y.C.", interval_start: t }));
    expect(res.lmp_usd_per_mwh).toBe(44.4);
    expect(res.node_or_zone).toBe("N.Y.C.");
    expect(res.market).toBe("NYISO");
  });
});

describe("GRID A4: Object.hasOwn zone check (no prototype-chain lookup)", () => {
  it('prototype names -> 422 UNSUPPORTED_ZONE, never a cache miss or a hit', async () => {
    for (const zone of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      await expectApiError(
        handleGridPrice({ node_or_zone: zone, interval_start: pastIso(2) }),
        422,
        "UNSUPPORTED_ZONE",
      );
    }
  });
});

describe("GRID A4: on-demand single-hub OASIS fetch (stubbed)", () => {
  const HOUR = "2026-11-18T03:00:00.000Z";

  it("an unseeded CAISO hour is fetched live, cached, and served (2nd call is a cache hit)", async () => {
    expect(getGridPrice("TH_NP15_GEN-APND", HOUR)).toBeNull();
    const zip = makeCaisoZip(
      "PRC_LMP.csv",
      [
        CAISO_HEADER,
        caisoLmpRow("TH_NP15_GEN-APND", "2026-11-18T03:00:00-00:00", "2026-11-18T04:00:00-00:00", 60.16249),
      ].join("\n"),
    );
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("oasis.caiso.com")) {
        fetchCalls++;
        // The 1-hour-window URL for exactly this hour.
        expect(u).toContain("startdatetime=20261118T03:00-0000");
        expect(u).toContain("enddatetime=20261118T04:00-0000");
        expect(u).toContain("market_run_id=DAM");
        expect(u).toContain("node=TH_NP15_GEN-APND");
        return new Response(new Uint8Array(zip), {
          status: 200,
          headers: { "Content-Type": "application/x-zip-compressed" },
        });
      }
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const res = await handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: HOUR });
      expect(res.lmp_usd_per_mwh).toBe(60.16249);
      expect(res.node_or_zone).toBe("TH_NP15_GEN-APND");
      expect(res.market).toBe("CAISO");
      expect(res.currency).toBe("USD");
      expect(res.verdict).toBe("verified");
      const receipt = res.receipt as Record<string, unknown>;
      expect(receipt.quorum_votes as string).toContain("live CAISO OASIS");
      expect(receipt.upstream_url as string).toContain("oasis.caiso.com/oasisapi/SingleZip");
      expect(fetchCalls).toBe(1);
      // The fetched row is now cached: the second call serves it with no fetch.
      const res2 = await handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: HOUR });
      expect(res2.lmp_usd_per_mwh).toBe(60.16249);
      expect(fetchCalls).toBe(1);
      expect(getGridPrice("TH_NP15_GEN-APND", HOUR)?.lmp_usd_per_mwh).toBe(60.16249);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a failed live fetch for an unseeded CAISO hour -> 502 GRID_CACHE_MISS (never fabricated)", async () => {
    const hour = "2026-11-18T04:00:00.000Z";
    expect(getGridPrice("TH_SP15_GEN-APND", hour)).toBeNull();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("stubbed OASIS failure"))) as typeof fetch;
    try {
      await expectApiError(
        handleGridPrice({ node_or_zone: "TH_SP15_GEN-APND", interval_start: hour }),
        502,
        "GRID_CACHE_MISS",
      );
      expect(getGridPrice("TH_SP15_GEN-APND", hour)).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a stale CAISO row + failed re-fetch -> 502 GRID_CACHE_STALE; a good re-fetch replaces it", async () => {
    const hour = lastCompletedCaisoHourIso();
    const hourEnd = new Date(Date.parse(hour) + 3600_000).toISOString();
    saveGridPrice("TH_SP15_GEN-APND", hour, 11.11, "CAISO", minutesAgoIso(61));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("stubbed OASIS failure"))) as typeof fetch;
    try {
      await expectApiError(
        handleGridPrice({ node_or_zone: "TH_SP15_GEN-APND", interval_start: hour }),
        502,
        "GRID_CACHE_STALE",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // Same hour, OASIS now answers: the stale row is replaced live.
    const zip = makeCaisoZip(
      "PRC_LMP.csv",
      [
        CAISO_HEADER,
        caisoLmpRow("TH_SP15_GEN-APND", isoToCaisoGmt(hour), isoToCaisoGmt(hourEnd), 22.22),
      ].join("\n"),
    );
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("oasis.caiso.com")) {
        return new Response(new Uint8Array(zip), { status: 200 });
      }
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const res = await handleGridPrice({ node_or_zone: "TH_SP15_GEN-APND", interval_start: hour });
      expect(res.lmp_usd_per_mwh).toBe(22.22);
      expect(getGridPrice("TH_SP15_GEN-APND", hour)?.lmp_usd_per_mwh).toBe(22.22);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID A4: fetchCaisoDamLmp (stubbed zip)", () => {
  it("returns the LMP_PRC row for the requested hour and null for an absent hour", async () => {
    const zip = makeCaisoZip(
      "PRC_LMP.csv",
      [
        CAISO_HEADER,
        caisoLmpRow("TH_ZP26_GEN-APND", "2026-11-18T03:00:00-00:00", "2026-11-18T04:00:00-00:00", 36.79695),
        caisoLmpRow("TH_ZP26_GEN-APND", "2026-11-18T04:00:00-00:00", "2026-11-18T05:00:00-00:00", 37.5),
      ].join("\n"),
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("oasis.caiso.com")) {
        return new Response(new Uint8Array(zip), { status: 200 });
      }
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const hit = await fetchCaisoDamLmp("TH_ZP26_GEN-APND", "2026-11-18T03:00:00.000Z");
      expect(hit?.lmp).toBe(36.79695);
      expect(hit?.upstreamUrl).toContain("oasis.caiso.com/oasisapi/SingleZip");
      const hit2 = await fetchCaisoDamLmp("TH_ZP26_GEN-APND", "2026-11-18T04:00:00.000Z");
      expect(hit2?.lmp).toBe(37.5);
      // The zip carries no 05:00 row: null, not a neighbouring hour's price.
      const miss = await fetchCaisoDamLmp("TH_ZP26_GEN-APND", "2026-11-18T05:00:00.000Z");
      expect(miss).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("A4-FIX2 F-N2: an impossible interval (Feb 30 / hour 24) throws before any fetch", async () => {
    // The network must not be touched at all: the strict parse rejects
    // the interval before the OASIS URL is even built (pre-fix,
    // Date.parse rolled Feb 30 over to Mar 2 and returned that hour's
    // price). Leap-day control is covered by parseCaisoIntervalStart
    // tests; here the pin is throw-before-fetch for impossible dates.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("NETWORK MUST NOT BE CALLED"))) as typeof fetch;
    try {
      await expect(fetchCaisoDamLmp("TH_ZP26_GEN-APND", "2026-02-30T14:00:00.000Z")).rejects.toThrow(
        /unparseable interval/,
      );
      await expect(fetchCaisoDamLmp("TH_ZP26_GEN-APND", "2026-11-19T24:00:00.000Z")).rejects.toThrow(
        /unparseable interval/,
      );
      await expect(fetchCaisoDamLmp("TH_ZP26_GEN-APND", "2026-04-31T14:00:00.000Z")).rejects.toThrow(
        /unparseable interval/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID-NP15 LIVE: reference question 2026-09-13T14:00Z CAISO -> NP15 ~38.09", () => {
  it(
    "the CAISO answer is the live OASIS NP15 value, within 30 bps of 38.09459",
    async () => {
      const interval = "2026-09-13T14:00:00.000Z";
      // Delete any seeded reference rows first: this test must prove
      // the ON-DEMAND fetch, not re-serve the cached-hub seed.
      getDb().prepare("DELETE FROM grid_cache WHERE interval_start = ?").run(interval);
      expect(getGridPrice("TH_NP15_GEN-APND", interval)).toBeNull();
      const res = await handleGridPrice({ node_or_zone: "CAISO", interval_start: interval });
      const np15 = getGridPrice("TH_NP15_GEN-APND", interval)?.lmp_usd_per_mwh;
      console.log("[grid-test] NP15 live CAISO @ " + interval + ": " + String(res.lmp_usd_per_mwh));
      expect(typeof np15).toBe("number");
      expect(res.lmp_usd_per_mwh).toBe(np15);
      expect(res.lmp_usd_per_mwh).toBe(38.09459);
      expect((Math.abs((res.lmp_usd_per_mwh as number) - 38.09459) / 38.09459) * 10_000).toBeLessThanOrEqual(30);
      expect(res.node_or_zone).toBe("TH_NP15_GEN-APND");
      expect(res.market).toBe(CAISO_SYSTEM_MARKET);
      expect(res.answer as string).toContain("NP15 trading hub");
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// GRID A4-FIX (2026-11-20): J2 FAIL verdict — 2 SEVERE, 2 MAJOR, 3 MINOR.
// Each finding below is pinned by a test that fails on the pre-fix code
// (reproduced with J2's probes probe.ts / probe2.ts / probe3.ts) and
// passes on the fixed code. Deterministic (stubbed fetch / direct-SQL
// seeds) except where noted; no live OASIS call in this block.
// ---------------------------------------------------------------------------

describe("GRID A4-FIX F1: rollover interval_start is rejected, never served", () => {
  /** Count of minted receipts — a rejected query must mint none. */
  function receiptCount(): number {
    return (getDb().prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as { n: number }).n;
  }

  it("Feb 30 / Apr 31 / Feb 29 (non-leap) / hour 24 -> 400 INVALID_INTERVAL", async () => {
    for (const bad of [
      "2026-02-30T14:00:00Z",
      "2026-04-31T14:00:00Z",
      "2026-02-29T14:00:00Z",
      "2026-11-19T24:00:00Z",
    ]) {
      await expectApiError(
        handleGridPrice({ node_or_zone: "CAISO", interval_start: bad }),
        400,
        "INVALID_INTERVAL",
      );
    }
  });

  it("a Feb-30 query never serves the Mar-2 cached row and mints no receipt", async () => {
    // Seed the row the old code rolled over to (J2 probe2 P4-cache: the
    // Feb-30 question was answered with this Mar-2 price AND a receipt).
    const mar2 = "2026-03-02T14:00:00.000Z";
    saveGridPrice("ZONE_J", mar2, 77.77, "NYISO", new Date().toISOString());
    expect(getGridPrice("ZONE_J", mar2)?.lmp_usd_per_mwh).toBe(77.77);
    const before = receiptCount();
    const realFetch = globalThis.fetch;
    // No network may be touched at all: the rejection happens before
    // any cache lookup or fetch.
    globalThis.fetch = (() => Promise.reject(new Error("NETWORK MUST NOT BE CALLED"))) as typeof fetch;
    try {
      await expectApiError(
        handleGridPrice({ node_or_zone: "ZONE_J", interval_start: "2026-02-30T14:00:00Z" }),
        400,
        "INVALID_INTERVAL",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(receiptCount()).toBe(before);
  });

  it("valid dates still serve (control: Mar 2 itself, and Feb 29 in a leap year)", async () => {
    const mar2 = "2026-03-02T14:00:00.000Z";
    saveGridPrice("ZONE_J", mar2, 77.77, "NYISO", new Date().toISOString());
    const res = await handleGridPrice({ node_or_zone: "ZONE_J", interval_start: "2026-03-02T14:00:00Z" });
    expect(res.lmp_usd_per_mwh).toBe(77.77);
    // 2024 was a leap year: Feb 29 2024 exists and must still serve.
    const leap = "2024-02-29T14:00:00.000Z";
    saveGridPrice("ZONE_J", leap, 44.44, "NYISO", new Date().toISOString());
    const resLeap = await handleGridPrice({ node_or_zone: "ZONE_J", interval_start: "2024-02-29T14:00:00Z" });
    expect(resLeap.lmp_usd_per_mwh).toBe(44.44);
  });
});

describe("GRID A4-FIX F2: empty/whitespace MW is a missing price, never $0.00", () => {
  /** A raw LMP_PRC row with an arbitrary MW string (and market run id). */
  function caisoRawRow(node: string, startGmt: string, mw: string, run = "DAM"): string {
    return (
      startGmt + ",2026-11-18T04:00:00-00:00,2026-11-18,20,0," +
      node + "," + node + "," + node + "," + run + ",LMP,LMP_PRC," + node + ",ALL_APNODES,0," +
      mw + ",1"
    );
  }

  /** Stub OASIS to answer every query with this zip; returns a restore fn. */
  function stubOasisZip(zip: Buffer): () => void {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("oasis.caiso.com")) {
        return new Response(new Uint8Array(zip), { status: 200 });
      }
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  it('MW "" / " " / "abc" -> null (no row cached, no serve); MW "36.80" -> 36.80; MW "0" stays a real $0.00', async () => {
    const hour = "2026-11-18T03:00:00.000Z";
    const gmt = "2026-11-18T03:00:00-00:00";
    for (const mw of ["", " ", "abc"]) {
      const zip = makeCaisoZip("PRC_LMP.csv", [CAISO_HEADER, caisoRawRow("TH_NP15_GEN-APND", gmt, mw)].join("\n"));
      const restore = stubOasisZip(zip);
      try {
        expect(await fetchCaisoDamLmp("TH_NP15_GEN-APND", hour)).toBeNull();
      } finally {
        restore();
      }
    }
    for (const [mw, want] of [["36.80", 36.8], ["0", 0]] as const) {
      const zip = makeCaisoZip("PRC_LMP.csv", [CAISO_HEADER, caisoRawRow("TH_NP15_GEN-APND", gmt, mw)].join("\n"));
      const restore = stubOasisZip(zip);
      try {
        expect((await fetchCaisoDamLmp("TH_NP15_GEN-APND", hour))?.lmp).toBe(want);
      } finally {
        restore();
      }
    }
  });

  it('A4-FIX2 F-N3: MW "0x10" / "0b101" / "1e3" are not decimal prices -> null (never 16 / 5 / 1000)', async () => {
    // Pre-fix, Number() parsed these literals (0x10 -> 16, 0b101 -> 5,
    // 1e3 -> 1000) and cached them as real prices. A price field is a
    // plain decimal; anything else is a missing price. Control row
    // proves the strict parser still accepts a real decimal.
    const hour = "2026-11-18T03:00:00.000Z";
    const gmt = "2026-11-18T03:00:00-00:00";
    for (const mw of ["0x10", "0X10", "0b101", "1e3", "1E3"]) {
      const zip = makeCaisoZip("PRC_LMP.csv", [CAISO_HEADER, caisoRawRow("TH_NP15_GEN-APND", gmt, mw)].join("\n"));
      const restore = stubOasisZip(zip);
      try {
        expect(await fetchCaisoDamLmp("TH_NP15_GEN-APND", hour)).toBeNull();
      } finally {
        restore();
      }
    }
    const zip = makeCaisoZip("PRC_LMP.csv", [CAISO_HEADER, caisoRawRow("TH_NP15_GEN-APND", gmt, "36.80")].join("\n"));
    const restore = stubOasisZip(zip);
    try {
      expect((await fetchCaisoDamLmp("TH_NP15_GEN-APND", hour))?.lmp).toBe(36.8);
    } finally {
      restore();
    }
  });

  it("an empty-MW row served through the handler -> 502 GRID_CACHE_MISS and nothing cached", async () => {
    const hour = "2026-11-18T06:00:00.000Z";
    const zip = makeCaisoZip(
      "PRC_LMP.csv",
      [CAISO_HEADER, caisoRawRow("TH_NP15_GEN-APND", "2026-11-18T06:00:00-00:00", "")].join("\n"),
    );
    expect(getGridPrice("TH_NP15_GEN-APND", hour)).toBeNull();
    const restore = stubOasisZip(zip);
    try {
      await expectApiError(
        handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: hour }),
        502,
        "GRID_CACHE_MISS",
      );
    } finally {
      restore();
    }
    expect(getGridPrice("TH_NP15_GEN-APND", hour)).toBeNull();
  });
});

describe("GRID A4-FIX F3: non-finite LMP is refused at write and at serve", () => {
  /** Past instant floored to a whole hour (CAISO's 60-min settlement boundary). */
  function pastHourIso(hoursAgo: number): string {
    const ms = Math.floor((Date.now() - hoursAgo * 3600_000) / 3600_000) * 3600_000;
    return new Date(ms).toISOString();
  }


  /** Seed a row the writers now refuse — direct DB insert, as a
   *  legacy/hand-seeded Infinity row would already exist. */
  function seedNonFiniteRow(node: string, interval: string, lmp: number): void {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO grid_cache
         (node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(node, interval, lmp, "CAISO", new Date().toISOString(), "https://oasis.caiso.com/x");
  }

  function receiptCount(): number {
    return (getDb().prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as { n: number }).n;
  }

  it("saveGridPrice(Infinity/-Infinity/NaN) throws and stores nothing", async () => {
    // Fixed far-past interval, NOT pastIso(20): the suite's live
    // ingester test (:504) runs before this describe and caches REAL
    // CAISO rows for the last 26 h, so a "stores nothing" assertion at
    // a recent pastIso() interval sees a genuine live row and fails.
    // Same precedent as the round-3 receipt-hash tests (:1801).
    const interval = "2026-01-04T00:00:00.000Z";
    for (const bad of [Infinity, -Infinity, NaN]) {
      expect(() => saveGridPrice("TH_NP15_GEN-APND", interval, bad, "CAISO")).toThrow(/non-finite/);
    }
    expect(getGridPrice("TH_NP15_GEN-APND", interval)).toBeNull();
  });

  it("saveGridPriceBatch with a non-finite row throws and stores nothing (not even its clean rows)", async () => {
    // Fixed far-past intervals — see the comment on the test above:
    // a recent pastIso() interval already holds a genuine live CAISO
    // row from the suite's live ingester test.
    const t0 = "2026-01-04T00:00:00.000Z";
    const t1 = "2026-01-04T01:00:00.000Z";
    const now = new Date().toISOString();
    expect(() =>
      saveGridPriceBatch([
        { node: "TH_NP15_GEN-APND", intervalStart: t0, lmp: 11.11, market: "CAISO", ingestedAt: now, upstreamUrl: "" },
        { node: "TH_SP15_GEN-APND", intervalStart: t1, lmp: Infinity, market: "CAISO", ingestedAt: now, upstreamUrl: "" },
      ]),
    ).toThrow(/non-finite/);
    expect(getGridPrice("TH_NP15_GEN-APND", t0)).toBeNull();
    expect(getGridPrice("TH_SP15_GEN-APND", t1)).toBeNull();
  });

  it("a cached Infinity row is never served (single hub, OASIS down) -> 502, no receipt", async () => {
    const interval = pastHourIso(23);
    seedNonFiniteRow("TH_NP15_GEN-APND", interval, Infinity);
    expect(getGridPrice("TH_NP15_GEN-APND", interval)?.lmp_usd_per_mwh).toBe(Infinity);
    const before = receiptCount();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("stubbed OASIS down"))) as typeof fetch;
    try {
      await expectApiError(
        handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: interval }),
        502,
        "GRID_CACHE_INVALID",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(receiptCount()).toBe(before);
  });

  it("a cached Infinity NP15 row is never served for a CAISO system request (OASIS down) -> 502 GRID_CACHE_INVALID", async () => {
    const interval = pastHourIso(24);
    seedNonFiniteRow("TH_NP15_GEN-APND", interval, Infinity);
    saveGridPrice("TH_SP15_GEN-APND", interval, 36.74, "CAISO", new Date().toISOString());
    saveGridPrice("TH_ZP26_GEN-APND", interval, 36.8, "CAISO", new Date().toISOString());
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("stubbed OASIS down"))) as typeof fetch;
    try {
      const err = await expectApiError(
        handleGridPrice({ node_or_zone: "CAISO", interval_start: interval }),
        502,
        "GRID_CACHE_INVALID",
      );
      expect(err.message).toContain("TH_NP15_GEN-APND");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID A4-FIX F4: an RTM row is never served as a DAM price", () => {
  function caisoRawRow(node: string, startGmt: string, mw: string, run = "DAM"): string {
    return (
      startGmt + ",2026-11-18T04:00:00-00:00,2026-11-18,20,0," +
      node + "," + node + "," + node + "," + run + ",LMP,LMP_PRC," + node + ",ALL_APNODES,0," +
      mw + ",1"
    );
  }

  function stubOasisZip(zip: Buffer): () => void {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("oasis.caiso.com")) {
        return new Response(new Uint8Array(zip), { status: 200 });
      }
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  it("an RTM-only CSV row -> null, and the handler 502s with nothing cached", async () => {
    const hour = "2026-11-18T07:00:00.000Z";
    const zip = makeCaisoZip(
      "PRC_LMP.csv",
      [CAISO_HEADER, caisoRawRow("TH_NP15_GEN-APND", "2026-11-18T07:00:00-00:00", "999.99", "RTM")].join("\n"),
    );
    const restore = stubOasisZip(zip);
    try {
      expect(await fetchCaisoDamLmp("TH_NP15_GEN-APND", hour)).toBeNull();
      await expectApiError(
        handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: hour }),
        502,
        "GRID_CACHE_MISS",
      );
    } finally {
      restore();
    }
    expect(getGridPrice("TH_NP15_GEN-APND", hour)).toBeNull();
  });

  it("an RTM row beside a DAM row for the same hour -> the DAM value wins", async () => {
    const hour = "2026-11-18T08:00:00.000Z";
    const zip = makeCaisoZip(
      "PRC_LMP.csv",
      [
        CAISO_HEADER,
        caisoRawRow("TH_NP15_GEN-APND", "2026-11-18T08:00:00-00:00", "999.99", "RTM"),
        caisoRawRow("TH_NP15_GEN-APND", "2026-11-18T08:00:00-00:00", "36.80", "DAM"),
      ].join("\n"),
    );
    const restore = stubOasisZip(zip);
    try {
      expect((await fetchCaisoDamLmp("TH_NP15_GEN-APND", hour))?.lmp).toBe(36.8);
    } finally {
      restore();
    }
  });
});

describe("GRID A4-FIX F5: one overall deadline bounds the whole on-demand call", () => {
  it("a 6-hop redirect chain, 150ms per hop, timeoutMs=200 -> timeout error, not hop-limit, well under 6x the timeout", async () => {
    let hop = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: unknown) => {
      void url;
      const n = hop++;
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve(
              new Response(null, {
                status: 302,
                headers: { Location: "https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP&hop=" + n },
              }),
            ),
          150,
        );
      });
    }) as typeof fetch;
    const t0 = Date.now();
    try {
      await expect(fetchCaisoDamLmp("TH_NP15_GEN-APND", "2026-11-18T03:00:00.000Z", 200)).rejects.toThrow(
        /timed out/,
      );
      // The old per-hop code ran this chain in ~1266ms and threw the
      // hop-limit error; the single deadline must fire at ~200ms.
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a body stalled after headers, timeoutMs=200 -> rejects at ~the deadline (not a hang)", async () => {
    // J2's probe stub: headers resolve at once, arrayBuffer() never
    // resolves, and the stub ignores the abort signal — so only the
    // body-read race (not the signal alone) can bound this call.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => null },
        arrayBuffer: () => new Promise(() => {}),
      } as unknown as Response)) as typeof fetch;
    const t0 = Date.now();
    try {
      await expect(fetchCaisoDamLmp("TH_NP15_GEN-APND", "2026-11-18T03:00:00.000Z", 200)).rejects.toThrow(
        /timed out/,
      );
      // The old code was still unresolved after 3.7s here.
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID A4-FIX F6: a corrupt hub row + OASIS down -> 502 GRID_CACHE_INVALID", () => {
  /** Past instant floored to a whole hour (CAISO's 60-min settlement boundary). */
  function pastHourIso(hoursAgo: number): string {
    const ms = Math.floor((Date.now() - hoursAgo * 3600_000) / 3600_000) * 3600_000;
    return new Date(ms).toISOString();
  }


  it("CAISO system request with an empty-market NP15 row and a failed re-fetch -> GRID_CACHE_INVALID (not STALE)", async () => {
    const interval = pastHourIso(25);
    saveGridPrice("TH_SP15_GEN-APND", interval, 36.74, "CAISO", new Date().toISOString());
    saveGridPrice("TH_ZP26_GEN-APND", interval, 36.8, "CAISO", new Date().toISOString());
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO grid_cache
         (node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("TH_NP15_GEN-APND", interval, 38.09, "", new Date().toISOString(), "https://oasis.caiso.com/x");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("stubbed OASIS down"))) as typeof fetch;
    try {
      const err = await expectApiError(
        handleGridPrice({ node_or_zone: "CAISO", interval_start: interval }),
        502,
        "GRID_CACHE_INVALID",
      );
      expect(err.message).toContain("TH_NP15_GEN-APND");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("single hub: a stale AND corrupt row + failed re-fetch -> GRID_CACHE_INVALID (not STALE)", async () => {
    const interval = pastHourIso(26);
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO grid_cache
         (node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("TH_SP15_GEN-APND", interval, 11.11, "", minutesAgoIso(61), "https://oasis.caiso.com/x");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("stubbed OASIS down"))) as typeof fetch;
    try {
      await expectApiError(
        handleGridPrice({ node_or_zone: "TH_SP15_GEN-APND", interval_start: interval }),
        502,
        "GRID_CACHE_INVALID",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("GRID A4-FIX F7: whitespace-tolerant CAISO system + hub spellings", () => {
  const INTERVAL = "2026-09-13T19:00:00.000Z";

  function seedHubs(): void {
    const now = new Date().toISOString();
    saveGridPrice("TH_NP15_GEN-APND", INTERVAL, 38.09, "CAISO", now);
    saveGridPrice("TH_SP15_GEN-APND", INTERVAL, 36.74, "CAISO", now);
    saveGridPrice("TH_ZP26_GEN-APND", INTERVAL, 36.8, "CAISO", now);
  }

  it('"caiso  system" / tab / nbsp / em-space all resolve to the system (NP15 hub)', async () => {
    seedHubs();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("NETWORK MUST NOT BE CALLED"))) as typeof fetch;
    try {
      for (const spelling of [
        "caiso  system",
        "caiso\tsystem",
        "caiso\u00a0system",
        "CAISO\u2003system",
        "caiso   system   hub",
      ]) {
        const res = await handleGridPrice({ node_or_zone: spelling, interval_start: INTERVAL });
        expect(res.lmp_usd_per_mwh).toBe(38.09);
        expect(res.node_or_zone).toBe("TH_NP15_GEN-APND");
        expect(res.market).toBe(CAISO_SYSTEM_MARKET);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a single hub with leading/trailing spaces resolves to its canonical spelling", async () => {
    seedHubs();
    const res = await handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND ", interval_start: INTERVAL });
    expect(res.lmp_usd_per_mwh).toBe(38.09);
    expect(res.node_or_zone).toBe("TH_NP15_GEN-APND");
    const res2 = await handleGridPrice({ node_or_zone: "  TH_SP15_GEN-APND  ", interval_start: INTERVAL });
    expect(res2.lmp_usd_per_mwh).toBe(36.74);
    expect(res2.node_or_zone).toBe("TH_SP15_GEN-APND");
  });

  it("lowercase single hub resolves to the canonical CAISO hub without changing its source row", async () => {
    seedHubs();
    const result = await handleGridPrice({ node_or_zone: " th_np15_gen-apnd", interval_start: INTERVAL });
    expect(result.node_or_zone).toBe("TH_NP15_GEN-APND");
    expect(result.lmp_usd_per_mwh).toBe(38.09);
    const canonical = await handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: INTERVAL });
    expect(result.market).toBe(canonical.market);
    expect(result.currency).toBe(canonical.currency);
    expect(result.interval_start).toBe(INTERVAL);
  });
});

describe("GRID A4-FIX NYISO: empty/whitespace LBMP is a missing price, never $0.00", () => {
  const NYISO_HEADER =
    '"Time Stamp","Name","PTID","LBMP ($/MWHr)","Marginal Cost Losses ($/MWHr)","Marginal Cost Congestion ($/MWHr)"';

  /** One NYISO realtime-zone row for N.Y.C. with an arbitrary LBMP string. */
  function nyisoRow(wall: string, lbmp: string): string {
    return `"${wall}","N.Y.C.",61757,${lbmp},1.26,0.00`;
  }

  /** ISO interval for a NYISO wall time, via the same parser the ingester uses. */
  function nyisoIso(wall: string): string {
    const ms = nyWallToUtcMs(wall);
    if (ms === null) throw new Error("bad test wall time " + wall);
    return new Date(ms).toISOString();
  }

  /** Stub fetch so the ingester reads only this NYISO CSV; everything else fails. */
  function stubNyisoCsv(csv: string): () => void {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("realtime_zone.csv")) return new Response(csv, { status: 200 });
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  it('LBMP "" / " " / "abc" -> nothing cached; LBMP "36.80" -> 36.8; LBMP "0" stays a real $0.00', async () => {
    // Fixed far-past walls (11/10/2026), NOT 11/19: the suite's live
    // ingester test (:504) runs before this describe and caches REAL
    // NYISO rows for 11/19–11/20 (the ingester's 2-day window), so a
    // "nothing cached" assertion at an 11/19 wall sees a genuine live
    // row and fails. Same precedent as the round-3 receipt-hash tests
    // (:1801), which use fixed far-past intervals for exactly this
    // reason. The stub ignores the URL, so any wall date exercises
    // the ingester identically.
    const walls = {
      empty: "11/10/2026 00:05:00",
      space: "11/10/2026 00:10:00",
      abc: "11/10/2026 00:15:00",
      good: "11/10/2026 00:20:00",
      zero: "11/10/2026 00:25:00",
    };
    const csv = [
      NYISO_HEADER,
      nyisoRow(walls.empty, ""),
      nyisoRow(walls.space, " "),
      nyisoRow(walls.abc, "abc"),
      nyisoRow(walls.good, "36.80"),
      nyisoRow(walls.zero, "0"),
    ].join("\n");
    const restore = stubNyisoCsv(csv);
    try {
      const result = await runIngesterOnce();
      // Two day-files x two good rows x two keys (ZONE_J + N.Y.C.) = 8.
      expect(result.fetched).toBe(8);
    } finally {
      restore();
    }
    expect(getGridPrice("ZONE_J", nyisoIso(walls.empty))).toBeNull();
    expect(getGridPrice("ZONE_J", nyisoIso(walls.space))).toBeNull();
    expect(getGridPrice("ZONE_J", nyisoIso(walls.abc))).toBeNull();
    expect(getGridPrice("ZONE_J", nyisoIso(walls.good))?.lmp_usd_per_mwh).toBe(36.8);
    expect(getGridPrice("ZONE_J", nyisoIso(walls.zero))?.lmp_usd_per_mwh).toBe(0);
    // The N.Y.C. alias key carries the same good rows (not a second $0.00).
    expect(getGridPrice("N.Y.C.", nyisoIso(walls.good))?.lmp_usd_per_mwh).toBe(36.8);
    expect(getGridPrice("N.Y.C.", nyisoIso(walls.zero))?.lmp_usd_per_mwh).toBe(0);
  });

  it("an empty-LBMP NYISO row served through the handler -> 502 GRID_CACHE_MISS and nothing cached", async () => {
    // Fixed far-past wall (11/10/2026) — see the comment on the test
    // above: the live ingester test caches real NYISO rows at 11/19
    // walls, so an 11/19 wall would already hold a genuine live row.
    const wall = "11/10/2026 00:30:00";
    const iso = nyisoIso(wall);
    const csv = [NYISO_HEADER, nyisoRow(wall, "")].join("\n");
    expect(getGridPrice("ZONE_J", iso)).toBeNull();
    const restore = stubNyisoCsv(csv);
    try {
      await runIngesterOnce();
      await expectApiError(
        handleGridPrice({ node_or_zone: "ZONE_J", interval_start: iso }),
        502,
        "GRID_CACHE_MISS",
      );
    } finally {
      restore();
    }
    expect(getGridPrice("ZONE_J", iso)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GRID A4-FIX2 (2026-11-20): J2 round-2 FAIL verdict — 1 MAJOR (F-N1) + 3 MINOR
// (F-N2/F-N3/F-N4). Each finding is pinned by a test that fails on the
// pre-fix code (reproduced with J2's probes j2r2probe.ts / j2r2probe2.ts)
// and passes on the fixed code. Deterministic (stubbed fetch); no live
// upstream call in this block. F-N2 is pinned in the fetchCaisoDamLmp
// describe above, F-N3 (CAISO) in the F2 describe above, F-N4 by the
// fixed far-past intervals in the round-7 guard tests above.
// ---------------------------------------------------------------------------

describe("GRID A4-FIX2 F-N1/F-N3: impossible NYISO wall times and non-decimal LBMP are never cached", () => {
  const NYISO_HEADER =
    '"Time Stamp","Name","PTID","LBMP ($/MWHr)","Marginal Cost Losses ($/MWHr)","Marginal Cost Congestion ($/MWHr)"';

  /** One NYISO realtime-zone row for N.Y.C. with an arbitrary LBMP string. */
  function nyisoRow(wall: string, lbmp: string): string {
    return `"${wall}","N.Y.C.",61757,${lbmp},1.26,0.00`;
  }

  /** ISO interval for a (valid) NYISO wall time, via the same parser the ingester uses. */
  function nyisoIso(wall: string): string {
    const ms = nyWallToUtcMs(wall);
    if (ms === null) throw new Error("bad test wall time " + wall);
    return new Date(ms).toISOString();
  }

  /** Stub fetch so the ingester reads only this NYISO CSV; everything else fails. */
  function stubNyisoCsv(csv: string): () => void {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("realtime_zone.csv")) return new Response(csv, { status: 200 });
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  /** Count of minted receipts — a skipped row / rejected query must mint none. */
  function receiptCount(): number {
    return (getDb().prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as { n: number }).n;
  }

  it("nyWallToUtcMs returns null for impossible walls, non-null for real ones (incl. leap day + DST gap)", () => {
    for (const bad of [
      "02/30/2026 00:05:00",
      "04/31/2026 00:05:00",
      "02/29/2026 00:05:00",
      "11/10/2026 24:00:00",
      "00/10/2026 00:05:00",
      "13/10/2026 00:05:00",
    ]) {
      expect(nyWallToUtcMs(bad)).toBeNull();
    }
    // Controls: real walls still resolve — 2024 was a leap year, and
    // the genuine DST spring-forward gap wall still resolves to the
    // post-transition instant (it is range-valid; only impossible
    // walls are rejected, never gap walls).
    expect(nyWallToUtcMs("02/29/2024 00:05:00")).not.toBeNull();
    expect(nyWallToUtcMs("11/10/2026 00:05:00")).not.toBeNull();
    expect(new Date(nyWallToUtcMs("03/08/2026 02:30:00") as number).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("impossible NYISO walls are skipped at ingest: nothing cached under any rolled instant", async () => {
    // Fixed far-past walls, NOT 11/19: the suite's live ingester test
    // (:504) caches REAL NYISO rows for 11/19–11/20, so a "nothing
    // cached" assertion at a recent rolled instant would see a genuine
    // live row. The stub ignores the URL, so any wall date exercises
    // the ingester identically.
    const walls = {
      feb30: "02/30/2026 00:05:00",
      apr31: "04/31/2026 00:05:00",
      hour24: "11/10/2026 24:00:00",
      month00: "00/10/2026 00:05:00",
      month13: "13/10/2026 00:05:00",
      good: "11/10/2026 00:20:00",
      gap: "03/08/2026 02:30:00",
    };
    const csv = [
      NYISO_HEADER,
      nyisoRow(walls.feb30, "99.99"),
      nyisoRow(walls.apr31, "99.99"),
      nyisoRow(walls.hour24, "88.88"),
      nyisoRow(walls.month00, "66.66"),
      nyisoRow(walls.month13, "77.77"),
      nyisoRow(walls.good, "36.80"),
      nyisoRow(walls.gap, "55.55"),
    ].join("\n");
    const restore = stubNyisoCsv(csv);
    try {
      const result = await runIngesterOnce();
      // Two day-files x two good rows (good + genuine DST gap) x two
      // keys (ZONE_J + N.Y.C.) = 8. The five impossible rows cache nothing.
      expect(result.fetched).toBe(8);
      // The rolled instant the pre-fix code served as verified with a
      // receipt (J2 round-2 F-N1, Feb-30 row 99.99): the handler must
      // find nothing there and mint no receipt.
      const before = receiptCount();
      await expectApiError(
        handleGridPrice({ node_or_zone: "ZONE_J", interval_start: "2026-03-02T05:05:00.000Z" }),
        502,
        "GRID_CACHE_MISS",
      );
      expect(receiptCount()).toBe(before);
    } finally {
      restore();
    }
    // Rolled instants, by Date.UTC rollover arithmetic (what the
    // pre-fix code cached under): Feb 30 -> Mar 2 (EST), Apr 31 ->
    // May 1 (EDT), hour 24 -> next day 00:00 (EST), month 00 ->
    // Dec 2025, month 13 -> Jan 2027. All must hold nothing.
    expect(getGridPrice("ZONE_J", "2026-03-02T05:05:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_J", "2026-05-01T04:05:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_J", "2026-11-11T05:00:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_J", "2025-12-10T05:05:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_J", "2027-01-10T05:05:00.000Z")).toBeNull();
    // Controls: the good row and the genuine DST spring-forward gap
    // row still cache (the gap row is range-valid, kept as a gap row).
    expect(getGridPrice("ZONE_J", nyisoIso(walls.good))?.lmp_usd_per_mwh).toBe(36.8);
    expect(getGridPrice("ZONE_J", "2026-03-08T07:30:00.000Z")?.lmp_usd_per_mwh).toBe(55.55);
  });

  it("a corrupt 24:00 wall in yesterday's file does NOT overwrite the real 00:00 row from today's file", async () => {
    // J2 round-2 F-N1 (probe2 P-D): today's file carries the real
    // 11/20/2026 00:00:00 row (42.00); yesterday's file carries the
    // corrupt 11/19/2026 24:00:00 row (88.88), which rolls onto the
    // same instant — and file order is today-then-yesterday, so the
    // corrupt row processed last won via INSERT OR REPLACE. Here with
    // far-past walls (11/10 / 11/09) so no live row can interfere.
    const nyDate = (ms: number): string =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .format(new Date(ms))
        .replace(/-/g, "");
    const today = nyDate(Date.now());
    const yesterday = nyDate(Date.now() - 24 * 3600_000);
    const realCsv = [NYISO_HEADER, nyisoRow("11/10/2026 00:00:00", "42.00")].join("\n");
    const corruptCsv = [NYISO_HEADER, nyisoRow("11/09/2026 24:00:00", "88.88")].join("\n");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("realtime_zone.csv")) {
        if (u.includes(today)) return new Response(realCsv, { status: 200 });
        if (u.includes(yesterday)) return new Response(corruptCsv, { status: 200 });
        return new Response(realCsv, { status: 200 });
      }
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const result = await runIngesterOnce();
      // Only the real row caches: 1 row x two keys (ZONE_J + N.Y.C.)
      // from the today file; the corrupt row is skipped, never written.
      expect(result.fetched).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
    // 11/10/2026 00:00:00 EST = 2026-11-10T05:00:00Z; the corrupt
    // 11/09 24:00 row rolls onto the same instant.
    const instant = "2026-11-10T05:00:00.000Z";
    expect(getGridPrice("ZONE_J", instant)?.lmp_usd_per_mwh).toBe(42.0);
    const res = await handleGridPrice({ node_or_zone: "ZONE_J", interval_start: instant });
    expect(res.lmp_usd_per_mwh).toBe(42.0);
  });

  it('A4-FIX2 F-N3: LBMP "0x10" / "0b101" / "1e3" are not decimal prices -> nothing cached', async () => {
    const walls = {
      hex: "11/10/2026 00:05:00",
      bin: "11/10/2026 00:10:00",
      exp: "11/10/2026 00:15:00",
      good: "11/10/2026 00:20:00",
      zero: "11/10/2026 00:25:00",
    };
    const csv = [
      NYISO_HEADER,
      nyisoRow(walls.hex, "0x10"),
      nyisoRow(walls.bin, "0b101"),
      nyisoRow(walls.exp, "1e3"),
      nyisoRow(walls.good, "36.80"),
      nyisoRow(walls.zero, "0"),
    ].join("\n");
    const restore = stubNyisoCsv(csv);
    try {
      const result = await runIngesterOnce();
      // Two day-files x two good rows x two keys = 8; the three
      // non-decimal rows cache nothing.
      expect(result.fetched).toBe(8);
    } finally {
      restore();
    }
    expect(getGridPrice("ZONE_J", nyisoIso(walls.hex))).toBeNull();
    expect(getGridPrice("ZONE_J", nyisoIso(walls.bin))).toBeNull();
    expect(getGridPrice("ZONE_J", nyisoIso(walls.exp))).toBeNull();
    expect(getGridPrice("ZONE_J", nyisoIso(walls.good))?.lmp_usd_per_mwh).toBe(36.8);
    expect(getGridPrice("ZONE_J", nyisoIso(walls.zero))?.lmp_usd_per_mwh).toBe(0);
  });
});

describe("GRID A4-FIX3 F-R3-1/F-R3-2: sub-100-year walls never cached; poisoned Elering row skipped", () => {
  const NYISO_HEADER =
    '"Time Stamp","Name","PTID","LBMP ($/MWHr)","Marginal Cost Losses ($/MWHr)","Marginal Cost Congestion ($/MWHr)"';

  /** One NYISO realtime-zone row for N.Y.C. with an arbitrary LBMP string. */
  function nyisoRow(wall: string, lbmp: string): string {
    return `"${wall}","N.Y.C.",61757,${lbmp},1.26,0.00`;
  }

  /** Stub fetch so the ingester reads only this NYISO CSV; everything else fails. */
  function stubNyisoCsv(csv: string): () => void {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("realtime_zone.csv")) return new Response(csv, { status: 200 });
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  /** Count of minted receipts — a skipped row / rejected query must mint none. */
  function receiptCount(): number {
    return (getDb().prepare("SELECT COUNT(*) AS n FROM miner_receipts").get() as { n: number }).n;
  }

  it("nyWallToUtcMs returns null for years 0000-0099 walls, still resolves year 0100 and genuine walls", () => {
    // J2 round-3 F-R3-1: Date.UTC maps years 0-99 to 1900-1999, so
    // these range-valid walls used to resolve to 1900s instants (and
    // year 0 rolled over to 1900-03-01). All must now be null.
    for (const bad of [
      "02/29/0024 00:05:00",
      "11/10/0099 00:05:00",
      "02/29/0000 00:05:00",
      "01/15/0050 00:05:00",
    ]) {
      expect(nyWallToUtcMs(bad)).toBeNull();
    }
    // Boundary control: year 100 is the first year Date.UTC handles
    // literally — it must still resolve (J2 round-3: years 0100/0999
    // resolve with the pre-1883 Local Mean Time offset, which is
    // correct, not a bug). No extra year-range ban is imposed.
    const y100 = nyWallToUtcMs("01/15/0100 00:05:00");
    expect(y100).not.toBeNull();
    expect(new Date(y100 as number).getUTCFullYear()).toBe(100);
    // Genuine walls unaffected, including the DST spring-forward gap
    // wall (the round-trip check is on the pre-offset instant, so gap
    // walls keep resolving to the post-transition instant).
    expect(nyWallToUtcMs("11/10/2026 00:05:00")).not.toBeNull();
    expect(nyWallToUtcMs("02/29/2024 00:05:00")).not.toBeNull();
    expect(new Date(nyWallToUtcMs("03/08/2026 02:30:00") as number).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("sub-100-year NYISO walls are skipped at ingest: nothing cached at the mapped 1900s instants", async () => {
    const csv = [
      NYISO_HEADER,
      nyisoRow("02/29/0024 00:05:00", "77.77"),
      nyisoRow("11/10/0099 00:05:00", "66.66"),
      nyisoRow("02/29/0000 00:05:00", "55.55"),
      nyisoRow("01/15/0050 00:05:00", "44.44"),
      nyisoRow("11/10/2026 00:20:00", "36.80"),
    ].join("\n");
    const restore = stubNyisoCsv(csv);
    try {
      const result = await runIngesterOnce();
      // Two day-files x one good row x two keys (ZONE_J + N.Y.C.) = 4.
      // The four sub-100-year rows cache nothing.
      expect(result.fetched).toBe(4);
      // The handler query J2 round-3 served as verified with a receipt
      // (77.77 @ 1924-02-29T05:05Z): it must now 502 with no receipt.
      const before = receiptCount();
      await expectApiError(
        handleGridPrice({ node_or_zone: "ZONE_J", interval_start: "1924-02-29T05:05:00.000Z" }),
        502,
        "GRID_CACHE_MISS",
      );
      expect(receiptCount()).toBe(before);
    } finally {
      restore();
    }
    // Mapped instants under the pre-fix code (Date.UTC 0-99 -> 1900s):
    // 0024 -> 1924-02-29, 0099 -> 1999-11-10, 0000 -> 1900-03-01
    // (year-0 rollover: 1900 is not a leap year), 0050 -> 1950-01-15.
    // All must hold nothing.
    expect(getGridPrice("ZONE_J", "1924-02-29T05:05:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_J", "1999-11-10T05:05:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_J", "1900-03-01T05:05:00.000Z")).toBeNull();
    expect(getGridPrice("ZONE_J", "1950-01-15T05:05:00.000Z")).toBeNull();
    // Control: the genuine 2026 row still caches and serves.
    expect(getGridPrice("ZONE_J", "2026-11-10T05:20:00.000Z")?.lmp_usd_per_mwh).toBe(36.8);
    const res = await handleGridPrice({ node_or_zone: "ZONE_J", interval_start: "2026-11-10T05:20:00.000Z" });
    expect(res.lmp_usd_per_mwh).toBe(36.8);
  });

  it("a poisoned Elering timestamp (1e999 / 1e20) skips only its row; good rows cache and serve", async () => {
    const goodTs = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);
    // Raw JSON string on purpose: JSON.stringify would neuter
    // Infinity to null, but the wire format 1e999 parses to Infinity
    // — and 1e20 is finite yet past the Date range (ts*1000 overflows
    // to an Invalid Date). Both used to throw inside toISOString()
    // and abort the whole Elering cycle (J2 round-3 F-R3-2).
    const body =
      '{"success":true,"data":{' +
      '"ee":[{"timestamp":1e999,"price":50},{"timestamp":' +
      goodTs("2026-01-04T04:00:00.000Z") +
      ',"price":42.5}],' +
      '"fi":[{"timestamp":1e20,"price":50},{"timestamp":' +
      goodTs("2026-01-04T04:00:00.000Z") +
      ',"price":10}],' +
      '"lv":[{"timestamp":' +
      goodTs("2026-01-04T04:00:00.000Z") +
      ',"price":20}],' +
      '"lt":[{"timestamp":' +
      goodTs("2026-01-04T04:00:00.000Z") +
      ',"price":30}]}}';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("open.er-api.com")) {
        return new Response(JSON.stringify({ rates: { USD: 1.09 } }), { status: 200 });
      }
      if (u.includes("elering")) return new Response(body, { status: 200 });
      throw new Error("stubbed upstream failure");
    }) as typeof fetch;
    try {
      const result = await runIngesterOnce();
      // Four good rows (one per zone); the two poisoned rows cache
      // nothing and the cycle does NOT abort.
      expect(result.fetched).toBe(4);
      expect(result.failed.filter((f) => f.startsWith("Elering:"))).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(getGridPrice("EE", "2026-01-04T04:00:00.000Z")?.lmp_usd_per_mwh).toBe(42.5 * 1.09);
    expect(getGridPrice("FI", "2026-01-04T04:00:00.000Z")?.lmp_usd_per_mwh).toBe(10 * 1.09);
    expect(getGridPrice("LV", "2026-01-04T04:00:00.000Z")?.lmp_usd_per_mwh).toBe(20 * 1.09);
    expect(getGridPrice("LT", "2026-01-04T04:00:00.000Z")?.lmp_usd_per_mwh).toBe(30 * 1.09);
    // And the good EE row serves through the handler (fresh ingest).
    const res = await handleGridPrice({ node_or_zone: "EE", interval_start: "2026-01-04T04:00:00.000Z" });
    expect(res.lmp_usd_per_mwh).toBe(42.5 * 1.09);
  });
});


describe("A9 isSettledGridInterval (pure)", () => {
  it("follows CAISO Tariff §35.2 (end of 3rd Business Day), not interval_end + 2 h", () => {
    const start = "2026-09-13T14:00:00.000Z"; // Sunday, 07:00 PDT Trading Day 2026-09-13
    const startMs = Date.parse(start);
    // 3rd Business Day following Sun 13 Sep is Wed 16 Sep. End of that
    // day in America/Los_Angeles is Thu 17 Sep 00:00 PDT = 07:00Z.
    const close = Date.parse("2026-09-17T07:00:00.000Z");
    expect(provisionalCloseMs("CAISO", startMs)).toBe(close);
    expect(isSettledGridInterval(start, 60, close - 1)).toBe(false);
    expect(isSettledGridInterval(start, 60, close)).toBe(true);
    // The withdrawn A9 r1 rule (end + 2 h = 17:00Z the same day) is
    // still well inside the provisional window.
    expect(isSettledGridInterval(start, 60, Date.parse("2026-09-13T17:00:00.000Z"))).toBe(false);
    // Unparseable / bad window: fail closed (not settled).
    expect(isSettledGridInterval("2026-02-30T14:00:00.000Z", 60, close + 10 * 86400_000)).toBe(false);
    expect(isSettledGridInterval(start, 0, close + 10 * 86400_000)).toBe(false);
  });

  it("a PDT hour and a post-DST PST hour are both settled by mid-November, a 90-minute-old hour is not", () => {
    // 2026-09-13 is US PDT (UTC-7); 2026-11-01 is the US DST end date (PST, UTC-8).
    // Trading-day math uses America/Los_Angeles, not a raw UTC offset.
    const pdt = "2026-09-13T14:00:00.000Z";
    const pst = "2026-11-01T15:00:00.000Z"; // 07:00 PST Trading Day 2026-11-01 (Sunday)
    const now = Date.parse("2026-11-21T10:00:00.000Z");
    expect(isSettledGridInterval(pdt, 60, now)).toBe(true);
    expect(isSettledGridInterval(pst, 60, now)).toBe(true);
    // A window that ended 90 minutes ago is still well inside the 3-BD window.
    const recent = "2026-11-21T08:00:00.000Z";
    expect(isSettledGridInterval(recent, 60, now)).toBe(false);
  });
});

describe("A9 CAISO live fetch retry + single-flight (stubbed)", () => {
  afterEach(() => {
    resetCaisoLiveInflightForTests();
  });

  it("retry policy is bounded", () => {
    expect(CAISO_LIVE_ATTEMPTS).toBe(3);
    expect(CAISO_RETRY_DELAY_MS).toBe(500);
    expect(CAISO_RETRY_DELAY_MS * (CAISO_LIVE_ATTEMPTS - 1)).toBeLessThan(120_000);
  });

  const HOUR = "2026-09-13T20:00:00.000Z";
  const START_GMT = "2026-09-13T20:00:00-00:00";
  const END_GMT = "2026-09-13T21:00:00-00:00";

  function zipFor(node: string, lmp: number): Buffer {
    return makeCaisoZip(
      "PRC_LMP.csv",
      [CAISO_HEADER, caisoLmpRow(node, START_GMT, END_GMT, lmp)].join("\n"),
    );
  }

  it("retries a transient OASIS 503 then serves and caches the price", async () => {
    const zip = zipFor("TH_SP15_GEN-APND", 36.74434);
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      if (fetchCalls < 3) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await handleGridPrice({ node_or_zone: "TH_SP15_GEN-APND", interval_start: HOUR });
      expect(res.lmp_usd_per_mwh).toBe(36.74434);
      expect(res.verdict).toBe("verified");
      expect(fetchCalls).toBe(CAISO_LIVE_ATTEMPTS);
      expect(getGridPrice("TH_SP15_GEN-APND", HOUR)?.lmp_usd_per_mwh).toBe(36.74434);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 8000);

  it("exhausted retries leave the cache empty and return 502 GRID_CACHE_MISS", async () => {
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    try {
      await expectApiError(
        handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: HOUR }),
        502,
        "GRID_CACHE_MISS",
      );
      expect(fetchCalls).toBe(CAISO_LIVE_ATTEMPTS);
      expect(getGridPrice("TH_NP15_GEN-APND", HOUR)).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 8000);

  it("a well-formed OASIS CSV with no LMP row is not retried (genuine miss)", async () => {
    // Header + a non-LMP component row: well-formed, no LMP_PRC match.
    const mcc = caisoLmpRow("TH_ZP26_GEN-APND", START_GMT, END_GMT, 1.23).replace(",LMP,LMP_PRC,", ",MCC,LMP_MCC,");
    const zip = makeCaisoZip("PRC_LMP.csv", [CAISO_HEADER, mcc].join("\n"));
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await fetchCaisoDamLmp("TH_ZP26_GEN-APND", HOUR)).toBeNull();
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("concurrent misses share one in-flight OASIS fetch (single-flight)", async () => {
    const zip = zipFor("TH_ZP26_GEN-APND", 36.79695);
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      await gate;
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as typeof fetch;
    try {
      const p1 = handleGridPrice({ node_or_zone: "TH_ZP26_GEN-APND", interval_start: HOUR });
      const p2 = handleGridPrice({ node_or_zone: "TH_ZP26_GEN-APND", interval_start: HOUR });
      // Let both handlers reach the in-flight map before releasing OASIS.
      await new Promise((r) => setTimeout(r, 30));
      expect(fetchCalls).toBe(1);
      release!();
      const [a, b] = await Promise.all([p1, p2]);
      expect(a.lmp_usd_per_mwh).toBe(36.79695);
      expect(b.lmp_usd_per_mwh).toBe(36.79695);
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("A9 settled historical cache (NYISO + CAISO reference hour)", () => {
  it("a 2-month-old NYISO row is served without being evicted by the 1 h TTL", async () => {
    const interval = "2026-09-13T14:00:00.000Z";
    saveGridPrice("ZONE_A", interval, 42.5, "NYISO", minutesAgoIso(48 * 60));
    const res = await handleGridPrice({ node_or_zone: "ZONE_A", interval_start: interval });
    expect(res.lmp_usd_per_mwh).toBe(42.5);
    expect(res.verdict).toBe("verified");
  });
});


describe("A9 r2 CAISO / NYISO / Elering finality calendar", () => {
  it("computes Easter 2026 as 5 April (Anonymous Gregorian)", () => {
    expect(ymdKey(easterSunday(2026))).toBe("2026-04-05");
    expect(ymdKey(easterSunday(2025))).toBe("2025-04-20");
  });

  it("treats Juneteenth, observed Independence Day, and the Friday after Thanksgiving as non-Business Days under Appendix A", () => {
    // 2026-06-19 is a Friday — Juneteenth is a federal holiday, so it is
    // NOT a CAISO Appendix A Business Day (even though the lowercase
    // §11.29 settlements calendar treats it as an operating day).
    expect(isCaisoBusinessDay({ y: 2026, m: 6, d: 19 })).toBe(false);
    expect(isUsFederalOrDayAfterThanksgiving({ y: 2026, m: 6, d: 19 })).toBe(true);
    // 4 July 2026 is a Saturday → observed Friday 3 July.
    expect(isCaisoBusinessDay({ y: 2026, m: 7, d: 3 })).toBe(false);
    expect(isCaisoBusinessDay({ y: 2026, m: 7, d: 4 })).toBe(false); // Saturday
    expect(isCaisoBusinessDay({ y: 2026, m: 7, d: 6 })).toBe(true); // Monday
    // Thanksgiving 2026-11-26 and Friday 11-27.
    expect(isCaisoBusinessDay({ y: 2026, m: 11, d: 26 })).toBe(false);
    expect(isCaisoBusinessDay({ y: 2026, m: 11, d: 27 })).toBe(false);
    expect(isCaisoBusinessDay({ y: 2026, m: 11, d: 30 })).toBe(true); // Monday
  });

  it("a Thanksgiving-week CAISO DAM hour stays provisional across the holiday weekend", () => {
    // Trading Day Wednesday 25 Nov 2026. Following BDs: Mon 30, Tue 1 Dec, Wed 2 Dec.
    // End of 2 Dec Pacific = 2026-12-03T08:00:00.000Z (PST, UTC-8).
    const startMs = Date.parse("2026-11-25T18:00:00.000Z"); // 10:00 PST
    const close = provisionalCloseMs("CAISO", startMs);
    expect(close).toBe(Date.parse("2026-12-03T08:00:00.000Z"));
    expect(gridFinalityPhase("CAISO", startMs, close! - 1)).toBe("provisional");
    expect(gridFinalityPhase("CAISO", startMs, close!)).toBe("correction");
  });

  it("CAISO §35.3.2 conservative correction window is 30 Business Days", () => {
    expect(CAISO_DAM_PROVISIONAL_BUSINESS_DAYS).toBe(3);
    expect(CAISO_CORRECTION_BUSINESS_DAYS).toBe(30);
    const startMs = Date.parse("2026-09-13T14:00:00.000Z");
    const corr = correctionCloseMs("CAISO", startMs);
    const prov = provisionalCloseMs("CAISO", startMs);
    expect(corr).toBeGreaterThan(prov!);
    // 21 Nov 2026 is past both windows (reference hour is safely final).
    const now = Date.parse("2026-11-21T10:00:00.000Z");
    expect(gridFinalityPhase("CAISO", startMs, now)).toBe("final");
  });

  it("NYISO realtime is provisional until the end of the 4th business day (MST Att. E §20.3)", () => {
    // 2026-09-13T14:00Z = 10:00 EDT, operating day Sunday 13 Sep.
    // Following BDs: Mon 14, Tue 15, Wed 16, Thu 17. End of 17 Sep
    // Eastern = 2026-09-18T04:00:00.000Z (EDT, UTC-4).
    const startMs = Date.parse("2026-09-13T14:00:00.000Z");
    expect(provisionalCloseMs("NYISO", startMs)).toBe(Date.parse("2026-09-18T04:00:00.000Z"));
    expect(correctionCloseMs("NYISO", startMs)).toBe(provisionalCloseMs("NYISO", startMs));
    expect(isSettledGridInterval("2026-09-13T14:00:00.000Z", 5, Date.parse("2026-09-18T03:59:59.999Z"))).toBe(
      false,
    );
    expect(isSettledGridInterval("2026-09-13T14:00:00.000Z", 5, Date.parse("2026-09-18T04:00:00.000Z"))).toBe(
      true,
    );
  });

  it("Elering Midsummer (24 Jun) is not a business day; 3-BD window skips it", () => {
    expect(isEstonianPublicHoliday({ y: 2026, m: 6, d: 23 })).toBe(true);
    expect(isEstonianPublicHoliday({ y: 2026, m: 6, d: 24 })).toBe(true);
    // Delivery 2026-06-22 (Monday EET). Following BDs skip 23–24 Jun:
    // Tue 23 holiday, Wed 24 holiday, Thu 25 (1), Fri 26 (2), Mon 29 (3).
    const startMs = Date.parse("2026-06-22T10:00:00.000Z"); // 13:00 EEST
    const close = provisionalCloseMs("ELERING", startMs);
    // End of Mon 29 Jun in Europe/Tallinn (EEST, UTC+3) = 2026-06-29T21:00:00.000Z.
    expect(close).toBe(Date.parse("2026-06-29T21:00:00.000Z"));
  });

  it("needsGridRevalidation is true once after provisional close, then false after a post-close success", () => {
    const startMs = Date.parse("2026-09-13T14:00:00.000Z");
    const close = provisionalCloseMs("CAISO", startMs)!;
    expect(
      needsGridRevalidation({
        kind: "CAISO",
        intervalStartMs: startMs,
        nowMs: close,
        ingestedAt: "2026-09-14T12:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      needsGridRevalidation({
        kind: "CAISO",
        intervalStartMs: startMs,
        nowMs: close,
        ingestedAt: "2026-09-14T12:00:00.000Z",
        lastSuccessAt: new Date(close).toISOString(),
      }),
    ).toBe(false);
    // Cooldown after a failed attempt.
    expect(
      needsGridRevalidation({
        kind: "CAISO",
        intervalStartMs: startMs,
        nowMs: close + 60_000,
        ingestedAt: "2026-09-14T12:00:00.000Z",
        lastAttemptAt: new Date(close).toISOString(),
      }),
    ).toBe(false);
  });
});

describe("A9 r2 OASIS empty zip / header-only / error 1000 (J2 m2)", () => {
  afterEach(() => {
    resetCaisoLiveInflightForTests();
  });

  const HOUR = "2026-09-13T20:00:00.000Z";

  function makeEmptyCaisoZip(): Buffer {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    return eocd;
  }

  function oasisErrorXml(code: number, desc: string): string {
    return (
      '<?xml version="1.0"?><OASISERROR><ERR_CODE>' +
      code +
      "</ERR_CODE><ERR_DESC>" +
      desc +
      "</ERR_DESC></OASISERROR>"
    );
  }

  it("classifies official error 1000 and the FAQ wording as a genuine miss", () => {
    expect(oasisErrorCodeFromPayload(oasisErrorXml(1000, "No data returned for the specified selection."))).toBe(
      1000,
    );
    expect(oasisErrorCodeFromPayload(oasisErrorXml(1003, "Timed out waiting for query response."))).toBe(1003);
    expect(oasisErrorCodeFromPayload("INTERVALSTARTTIME_GMT,NODE,XML_DATA_ITEM,MW,MARKET_RUN_ID\n")).toBeNull();
  });

  it("a header-only well-formed PRC_LMP CSV is a genuine miss and is not retried", async () => {
    const zip = makeCaisoZip("PRC_LMP.csv", CAISO_HEADER + "\n");
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await fetchCaisoDamLmp("TH_ZP26_GEN-APND", HOUR)).toBeNull();
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("an official OASIS 1000 error document is a genuine miss and is not retried", async () => {
    const zip = makeCaisoZip("ERROR.xml", oasisErrorXml(1000, "No data returned for the specified selection."));
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await fetchCaisoDamLmp("TH_NP15_GEN-APND", HOUR)).toBeNull();
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("an empty zip is retried once only (high-load artefact, not a 3-shot storm)", async () => {
    const empty = makeEmptyCaisoZip();
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response(new Uint8Array(empty), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(fetchCaisoDamLmp("TH_SP15_GEN-APND", HOUR)).rejects.toBeInstanceOf(CaisoEmptyArchiveError);
      expect(fetchCalls).toBe(CAISO_EMPTY_ARCHIVE_ATTEMPTS);
      expect(fetchCalls).toBeLessThan(CAISO_LIVE_ATTEMPTS);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 8000);
});

describe("A9 r2 post-provisional revalidation and single-node live repair", () => {
  afterEach(() => {
    resetCaisoLiveInflightForTests();
  });

  const HOUR = "2026-09-13T14:00:00.000Z";
  const START_GMT = "2026-09-13T14:00:00-00:00";
  const END_GMT = "2026-09-13T15:00:00-00:00";

  function zipFor(node: string, lmp: number): Buffer {
    return makeCaisoZip(
      "PRC_LMP.csv",
      [CAISO_HEADER, caisoLmpRow(node, START_GMT, END_GMT, lmp)].join("\n"),
    );
  }

  it("revalidates a pre-close ingest at least once after the provisional window and picks up a late revision (J2 m1)", async () => {
    // Ingested on Mon 14 Sep, before the Wed 16 Sep close. First serve
    // after the close must hit OASIS, not pin 99.99.
    saveGridPrice("TH_SP15_GEN-APND", HOUR, 99.99, "CAISO", "2026-09-14T12:00:00.000Z");
    const zip = zipFor("TH_SP15_GEN-APND", 36.74434);
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await handleGridPrice({ node_or_zone: "TH_SP15_GEN-APND", interval_start: HOUR });
      expect(res.lmp_usd_per_mwh).toBe(36.74434);
      expect(res.verdict).toBe("verified");
      expect(fetchCalls).toBe(1);
      expect(getGridPrice("TH_SP15_GEN-APND", HOUR)?.lmp_usd_per_mwh).toBe(36.74434);
      // Second call: already revalidated after the close; no more fetch.
      const res2 = await handleGridPrice({ node_or_zone: "TH_SP15_GEN-APND", interval_start: HOUR });
      expect(res2.lmp_usd_per_mwh).toBe(36.74434);
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 8000);

  it("a failed post-provisional revalidation still serves the valid cached price and does not storm", async () => {
    saveGridPrice("TH_NP15_GEN-APND", HOUR, 38.09459, "CAISO", "2026-09-14T12:00:00.000Z");
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    try {
      const res = await handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: HOUR });
      expect(res.lmp_usd_per_mwh).toBe(38.09459);
      expect(res.verdict).toBe(GRID_UNCONFIRMED_VERDICT);
      expect(res.confidence).toBe(GRID_UNCONFIRMED_CONFIDENCE);
      expect(String(res.source)).toContain("post-close revalidation did not confirm");
      expect(String(res.answer)).toMatch(/unverified/i);
      expect(String(res.answer)).toContain("post-close revalidation did not confirm");
      const receipt = res.receipt as Record<string, unknown>;
      expect(receipt.fetched_at).toBe("2026-09-14T12:00:00.000Z");
      expect(String(receipt.quorum_votes)).toContain("post-close revalidation did not confirm");
      expect(fetchCalls).toBe(CAISO_LIVE_ATTEMPTS);
      const res2 = await handleGridPrice({ node_or_zone: "TH_NP15_GEN-APND", interval_start: HOUR });
      expect(res2.lmp_usd_per_mwh).toBe(38.09459);
      expect(res2.verdict).toBe(GRID_UNCONFIRMED_VERDICT);
      expect(fetchCalls).toBe(CAISO_LIVE_ATTEMPTS); // cooldown, no second storm
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 8000);

  it("the single-node path live-repairs a settled corrupt row (J2 m4)", async () => {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO grid_cache
         (node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("TH_SP15_GEN-APND", HOUR, 99.99, "   ", "2026-09-14T12:00:00.000Z", "");
    const zip = zipFor("TH_SP15_GEN-APND", 36.74434);
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await handleGridPrice({ node_or_zone: "TH_SP15_GEN-APND", interval_start: HOUR });
      expect(res.lmp_usd_per_mwh).toBe(36.74434);
      expect(res.verdict).toBe("verified");
      expect(fetchCalls).toBe(1);
      expect(getGridPrice("TH_SP15_GEN-APND", HOUR)?.market).toBe("CAISO");
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 8000);
});

describe("A9 r2 grid_cache bound (J2 m3)", () => {
  it("purges unprotected rows down to the cap and never evicts the official CAISO reference", () => {
    expect(GRID_CACHE_MAX_ROWS).toBe(25_000);
    const db = getDb();
    const snapshot = db
      .prepare(
        "SELECT node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url FROM grid_cache",
      )
      .all();
    const nowMs = Date.parse("2026-11-21T10:00:00.000Z");
    try {
      db.exec("DELETE FROM grid_cache");
      for (const node of GRID_REFERENCE_CAISO_NODES) {
        saveGridPrice(node, GRID_REFERENCE_INTERVAL, 36.8, "CAISO", "2026-11-21T09:00:00.000Z");
      }
      for (let i = 0; i < 30; i++) {
        const interval = new Date(Date.parse("2020-01-01T00:00:00.000Z") + i * 3600_000).toISOString();
        saveGridPrice("ZONE_A", interval, i, "NYISO", "2020-01-02T00:00:00.000Z");
      }
      const deleted = purgeGridCacheOverflow(10, nowMs);
      expect(deleted).toBeGreaterThan(0);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM grid_cache").get() as { n: number }).n;
      expect(n).toBeLessThanOrEqual(10);
      for (const node of GRID_REFERENCE_CAISO_NODES) {
        expect(getGridPrice(node, GRID_REFERENCE_INTERVAL)?.lmp_usd_per_mwh).toBe(36.8);
      }
    } finally {
      db.exec("DELETE FROM grid_cache");
      const ins = db.prepare(
        `INSERT OR REPLACE INTO grid_cache
         (node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url)
         VALUES (@node_or_zone, @interval_start, @lmp_usd_per_mwh, @market, @ingested_at, @upstream_url)`,
      );
      for (const row of snapshot) ins.run(row);
    }
  });
});

describe("A9 r3: first post-close revalidation is not blocked by a pre-close success", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetCaisoLiveInflightForTests();
  });

  const HOUR = "2026-09-13T14:00:00.000Z";
  const START_MS = Date.parse(HOUR);
  const START_GMT = "2026-09-13T14:00:00-00:00";
  const END_GMT = "2026-09-13T15:00:00-00:00";
  const NODE = "TH_SP15_GEN-APND";
  const LIVE_LMP = 36.74434;
  const WRONG_LMP = 99.99;
  const close = provisionalCloseMs("CAISO", START_MS)!;
  // J2's exact instants: close is 2026-09-17T07:00:00.000Z.
  const REQUEST_AT = Date.parse("2026-09-17T07:00:00.001Z");

  function zipFor(node: string, lmp: number): Buffer {
    return makeCaisoZip(
      "PRC_LMP.csv",
      [CAISO_HEADER, caisoLmpRow(node, START_GMT, END_GMT, lmp)].join("\n"),
    );
  }

  function stubOasis(lmp: number): () => number {
    const zip = zipFor(NODE, lmp);
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as typeof fetch;
    return () => {
      const n = fetchCalls;
      globalThis.fetch = realFetch;
      return n;
    };
  }

  it("pure: ingest at close−30min / close−1ms / close−5h all require a post-close revalidation at close+1ms", () => {
    expect(close).toBe(Date.parse("2026-09-17T07:00:00.000Z"));
    expect(REQUEST_AT).toBe(close + 1);
    for (const deltaMs of [30 * 60_000, 1, 5 * 3600_000]) {
      const ingested = new Date(close - deltaMs).toISOString();
      expect(
        needsGridRevalidation({
          kind: "CAISO",
          intervalStartMs: START_MS,
          nowMs: REQUEST_AT,
          ingestedAt: ingested,
        }),
      ).toBe(true);
      // A lastAttempt copied from the pre-close success must not start the cooldown.
      expect(
        needsGridRevalidation({
          kind: "CAISO",
          intervalStartMs: START_MS,
          nowMs: REQUEST_AT,
          ingestedAt: ingested,
          lastSuccessAt: ingested,
          lastAttemptAt: ingested,
        }),
      ).toBe(true);
    }
    // A failed attempt already made after close still honours the cooldown.
    expect(
      needsGridRevalidation({
        kind: "CAISO",
        intervalStartMs: START_MS,
        nowMs: REQUEST_AT,
        ingestedAt: new Date(close - 30 * 60_000).toISOString(),
        lastAttemptAt: new Date(close).toISOString(),
      }),
    ).toBe(false);
    expect(GRID_REVALIDATE_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });

  async function serveAfterClose(ingestDeltaMs: number): Promise<{ lmp: unknown; fetches: number; verdict: unknown }> {
    vi.spyOn(Date, "now").mockReturnValue(REQUEST_AT);
    const ingested = new Date(close - ingestDeltaMs).toISOString();
    saveGridPrice(NODE, HOUR, WRONG_LMP, "CAISO", ingested, "seed");
    const restore = stubOasis(LIVE_LMP);
    try {
      const res = await handleGridPrice({ node_or_zone: NODE, interval_start: HOUR });
      const fetches = restore();
      return { lmp: res.lmp_usd_per_mwh, fetches, verdict: res.verdict };
    } catch (err) {
      restore();
      throw err;
    }
  }

  it("handler: TH_SP15_GEN-APND @ 2026-09-13T14:00Z ingested 99.99 at close−30min, request at 2026-09-17T07:00:00.001Z fetches and serves 36.74434 (J2 MAJOR)", async () => {
    const out = await serveAfterClose(30 * 60_000);
    expect(out.fetches).toBe(1);
    expect(out.lmp).toBe(LIVE_LMP);
    expect(out.verdict).toBe("verified");
    expect(getGridPrice(NODE, HOUR)?.lmp_usd_per_mwh).toBe(LIVE_LMP);
  }, 8000);

  it("handler: the same official hour ingested at close−1ms is revalidated at close+1ms", async () => {
    const out = await serveAfterClose(1);
    expect(out.fetches).toBe(1);
    expect(out.lmp).toBe(LIVE_LMP);
    expect(out.verdict).toBe("verified");
  }, 8000);

  it("handler: the same official hour ingested at close−5h is revalidated at close+1ms", async () => {
    const out = await serveAfterClose(5 * 3600_000);
    expect(out.fetches).toBe(1);
    expect(out.lmp).toBe(LIVE_LMP);
    expect(out.verdict).toBe("verified");
  }, 8000);
});

describe("A9 r3: Saturday New Year observance across the year boundary", () => {
  it("1 Jan 2028 (Saturday) is observed on Friday 31 Dec 2027; Trading Day 2027-12-28 closes 2028-01-04T08:00Z", () => {
    expect(isUsFederalOrDayAfterThanksgiving({ y: 2027, m: 12, d: 31 })).toBe(true);
    expect(isCaisoBusinessDay({ y: 2027, m: 12, d: 31 })).toBe(false);
    expect(isCaisoBusinessDay({ y: 2028, m: 1, d: 1 })).toBe(false); // Saturday
    expect(isCaisoBusinessDay({ y: 2028, m: 1, d: 3 })).toBe(true); // Monday
    // Trading Day Tuesday 28 Dec 2027 10:00 PST. Following BDs: Wed 29,
    // Thu 30, skip Fri 31 (observed New Year's), skip weekend, Mon 3 Jan is 3rd BD.
    // End of Mon 3 Jan 2028 PST (UTC-8) = 2028-01-04T08:00:00.000Z.
    const close = provisionalCloseMs("CAISO", Date.parse("2027-12-28T18:00:00.000Z"));
    expect(close).toBe(Date.parse("2028-01-04T08:00:00.000Z"));
  });
});

describe("A9 r3: Easter Monday is not an Estonian public holiday", () => {
  it("follows the Public Holidays Act §2 (Good Friday / Easter Sunday / Pentecost, not Easter Monday)", () => {
    expect(ymdKey(easterSunday(2026))).toBe("2026-04-05");
    expect(isEstonianPublicHoliday({ y: 2026, m: 4, d: 3 })).toBe(true); // Good Friday
    expect(isEstonianPublicHoliday({ y: 2026, m: 4, d: 5 })).toBe(true); // Easter Sunday
    expect(isEstonianPublicHoliday({ y: 2026, m: 4, d: 6 })).toBe(false); // Easter Monday — not in the Act
    // Delivery Thursday 2026-04-02. Following BDs: Mon 6 (Easter Monday
    // is a weekday), Tue 7, Wed 8. End of 8 Apr EEST (UTC+3) =
    // 2026-04-08T21:00:00.000Z.
    const close = provisionalCloseMs("ELERING", Date.parse("2026-04-02T10:00:00.000Z"));
    expect(close).toBe(Date.parse("2026-04-08T21:00:00.000Z"));
  });
});

describe("A9 r3: a zip containing a 0-byte file is retried once only", () => {
  afterEach(() => {
    resetCaisoLiveInflightForTests();
  });

  it("classifies a 0-byte file inside the zip like an empty archive", async () => {
    const emptyFileZip = makeCaisoZip("empty.csv", "");
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("oasis.caiso.com")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response(new Uint8Array(emptyFileZip), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(fetchCaisoDamLmp("TH_SP15_GEN-APND", "2026-09-13T20:00:00.000Z")).rejects.toBeInstanceOf(
        CaisoEmptyArchiveError,
      );
      expect(fetchCalls).toBe(CAISO_EMPTY_ARCHIVE_ATTEMPTS);
      expect(fetchCalls).toBeLessThan(CAISO_LIVE_ATTEMPTS);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 8000);
});

describe("A9 r3: saveGridPriceBatch records revalidation success", () => {
  it("a post-close batch overwrite updates last_success_at so the new value is the recorded write", () => {
    const hour = "2026-09-13T14:00:00.000Z";
    const node = "TH_ZP26_GEN-APND";
    const close = provisionalCloseMs("CAISO", Date.parse(hour))!;
    saveGridPrice(node, hour, 36.79695, "CAISO", new Date(close).toISOString(), "first");
    expect(getGridRevalidate(node, hour)?.last_success_at).toBe(new Date(close).toISOString());
    const later = new Date(close + 60_000).toISOString();
    saveGridPriceBatch([
      { node, intervalStart: hour, lmp: 99.99, market: "CAISO", ingestedAt: later, upstreamUrl: "batch" },
    ]);
    expect(getGridPrice(node, hour)?.lmp_usd_per_mwh).toBe(99.99);
    expect(getGridRevalidate(node, hour)?.last_success_at).toBe(later);
    // The batch write itself is the post-close success, so a subsequent
    // request does not owe another mandatory check.
    expect(
      needsGridRevalidation({
        kind: "CAISO",
        intervalStartMs: Date.parse(hour),
        nowMs: close + 120_000,
        ingestedAt: later,
        lastSuccessAt: later,
      }),
    ).toBe(false);
  });
});

describe("A9 r3: grid_cache cap binds and invalid keys are evictable", () => {
  function withIsolatedCache(fn: (db: ReturnType<typeof getDb>) => void): void {
    const db = getDb();
    const snapshot = db
      .prepare(
        "SELECT node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url FROM grid_cache",
      )
      .all();
    try {
      db.exec("DELETE FROM grid_cache");
      db.exec("DELETE FROM grid_cache_revalidate");
      fn(db);
    } finally {
      db.exec("DELETE FROM grid_cache");
      db.exec("DELETE FROM grid_cache_revalidate");
      const ins = db.prepare(
        `INSERT OR REPLACE INTO grid_cache
         (node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url)
         VALUES (@node_or_zone, @interval_start, @lmp_usd_per_mwh, @market, @ingested_at, @upstream_url)`,
      );
      for (const row of snapshot) ins.run(row);
    }
  }

  it("saveGridPrice and saveGridPriceBatch refuse unparseable interval keys", () => {
    expect(isStoreableGridIntervalKey("invalid_0")).toBe(false);
    expect(Number.isNaN(Date.parse("invalid_0"))).toBe(true);
    expect(isStoreableGridIntervalKey("foo-0")).toBe(false);
    expect(isStoreableGridIntervalKey("2026-09-13T14:00:00.000Z")).toBe(true);
    expect(() => saveGridPrice("ZONE_A", "invalid_0", 1, "NYISO", "2020-01-02T00:00:00.000Z")).toThrow(
      /unparseable or non-canonical interval_start/,
    );
    expect(() =>
      saveGridPriceBatch([
        { node: "ZONE_A", intervalStart: "invalid_0", lmp: 1, market: "NYISO", ingestedAt: "2020-01-02T00:00:00.000Z", upstreamUrl: "" },
      ]),
    ).toThrow(/unparseable or non-canonical interval_start/);
  });

  it("legacy unparseable interval keys are always evictable and the cap binds", () => {
    withIsolatedCache((db) => {
      const nowMs = Date.parse("2026-11-21T10:00:00.000Z");
      const ins = db.prepare(
        `INSERT OR REPLACE INTO grid_cache
         (node_or_zone, interval_start, lmp_usd_per_mwh, market, ingested_at, upstream_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const node of GRID_REFERENCE_CAISO_NODES) {
        saveGridPrice(node, GRID_REFERENCE_INTERVAL, 36.8, "CAISO", "2026-11-21T09:00:00.000Z");
      }
      for (let i = 0; i < 20; i++) {
        ins.run("ZONE_A", "invalid_" + i, i, "NYISO", "2020-01-02T00:00:00.000Z", "");
      }
      expect(isEvictionProtectedRow("ZONE_A", "invalid_0", "NYISO", nowMs)).toBe(false);
      const deleted = purgeGridCacheOverflow(10, nowMs);
      expect(deleted).toBeGreaterThan(0);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM grid_cache").get() as { n: number }).n;
      expect(n).toBeLessThanOrEqual(10);
      const invalidLeft = (
        db.prepare("SELECT COUNT(*) AS n FROM grid_cache WHERE interval_start LIKE 'invalid_%'").get() as { n: number }
      ).n;
      expect(invalidLeft).toBe(0);
      for (const node of GRID_REFERENCE_CAISO_NODES) {
        expect(getGridPrice(node, GRID_REFERENCE_INTERVAL)?.lmp_usd_per_mwh).toBe(36.8);
      }
    });
  });

  it("a protected-in-window set that exceeds the cap is evicted down to the cap; official references survive", () => {
    withIsolatedCache((db) => {
      // During the NYISO §20.3 window of the 13 Sep operating day.
      const nowMs = Date.parse("2026-09-14T16:00:00.000Z");
      for (const node of GRID_REFERENCE_CAISO_NODES) {
        saveGridPrice(node, GRID_REFERENCE_INTERVAL, 36.8, "CAISO", "2026-09-14T12:00:00.000Z");
      }
      for (let i = 0; i < 30; i++) {
        const interval = new Date(Date.parse("2026-09-13T14:00:00.000Z") + i * 5 * 60_000).toISOString();
        saveGridPrice("ZONE_A", interval, i, "NYISO", "2026-09-13T18:00:00.000Z");
      }
      const deleted = purgeGridCacheOverflow(10, nowMs);
      expect(deleted).toBeGreaterThan(0);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM grid_cache").get() as { n: number }).n;
      expect(n).toBeLessThanOrEqual(10);
      for (const node of GRID_REFERENCE_CAISO_NODES) {
        expect(getGridPrice(node, GRID_REFERENCE_INTERVAL)?.lmp_usd_per_mwh).toBe(36.8);
      }
    });
  });
});

describe("A9 r3: NYISO post-close revalidation from the dated MIS CSV", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetNyisoLiveInflightForTests();
  });

  it("revalidates a pre-close NYISO cache row after the 4-BD close and serves the official CSV price", async () => {
    const hour = "2026-09-13T14:00:00.000Z";
    const close = provisionalCloseMs("NYISO", Date.parse(hour))!;
    expect(close).toBe(Date.parse("2026-09-18T04:00:00.000Z"));
    vi.spyOn(Date, "now").mockReturnValue(close + 1);
    saveGridPrice("ZONE_A", hour, 99.99, "NYISO", new Date(close - 30 * 60_000).toISOString(), "seed");
    // 2026-09-13T14:00Z = 10:00 EDT. CSV Name for ZONE_A is WEST.
    const csv =
      '"Time Stamp","Name","PTID","LBMP ($/MWHr)","Marginal Cost Losses ($/MWHr)","Marginal Cost Congestion ($/MWHr)"\n' +
      '"09/13/2026 10:00:00","WEST",61752,42.5,0.00,0.00\n';
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (!String(url).includes("realtime_zone.csv")) throw new Error("stubbed upstream failure");
      fetchCalls++;
      return new Response(csv, { status: 200 });
    }) as typeof fetch;
    try {
      const res = await handleGridPrice({ node_or_zone: "ZONE_A", interval_start: hour });
      expect(res.lmp_usd_per_mwh).toBe(42.5);
      expect(res.verdict).toBe("verified");
      expect(fetchCalls).toBe(1);
      expect(getGridPrice("ZONE_A", hour)?.lmp_usd_per_mwh).toBe(42.5);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 8000);
});

// ---------------------------------------------------------------------------
// Free-text `question` fallback: the router may supply the verbatim question
// instead of canonical params. Absent params are recovered from the text;
// explicit params always win; unrecoverable params keep the strict 400s.
// Includes the live production failures observed 2026-11-23 (~06:22Z):
//   ?question=What was the LMP at NP15 for the hour starting ...Z -> 400
//   natural zone names in prose -> 422 / 400.
describe("handleGridPrice question fallback", () => {
  it("question supplies zone + interval when both params are absent (EE)", async () => {
    const interval = pastIso(3);
    saveGridPrice("EE", interval, 91.75, "Elering EE");
    const res = await handleGridPrice({
      question: "What was the LMP for EE for the interval starting " + interval + "?",
    });
    expect(res.verdict).toBe("verified");
    expect(res.lmp_usd_per_mwh).toBe(91.75);
    expect(res.node_or_zone).toBe("EE");
    expect(res.interval_start).toBe(interval);
  });

  it("question supplies only the missing interval (explicit zone wins)", async () => {
    const interval = pastIso(4);
    saveGridPrice("EE", interval, 66.1, "Elering EE");
    const res = await handleGridPrice({
      node_or_zone: "EE",
      question: "What was the EE price at " + interval + "?",
    });
    expect(res.lmp_usd_per_mwh).toBe(66.1);
    expect(res.interval_start).toBe(interval);
  });

  it("question supplies only the missing zone (explicit interval wins)", async () => {
    const interval = pastIso(5);
    saveGridPrice("EE", interval, 55.5, "Elering EE");
    const res = await handleGridPrice({
      interval_start: interval,
      question: "What was the EE LMP then?",
    });
    expect(res.lmp_usd_per_mwh).toBe(55.5);
    expect(res.node_or_zone).toBe("EE");
  });

  it("live failure 2026-11-23: 'What was the LMP at NP15 for the hour starting <iso>Z' resolves the NP15 hub", async () => {
    const interval = "2026-11-19T03:00:00.000Z";
    saveGridPrice("TH_NP15_GEN-APND", interval, 67.57, "CAISO", minutesAgoIso(10), "");
    const res = await handleGridPrice({
      question: "What was the LMP at NP15 for the hour starting 2026-11-19T03:00:00Z?",
    });
    expect(res.node_or_zone).toBe("TH_NP15_GEN-APND");
    expect(res.market).toBe("CAISO");
    expect(res.lmp_usd_per_mwh).toBe(67.57);
    expect(res.interval_start).toBe(interval);
  });

  it("lowercase prose hub spelling resolves (np15 hub)", async () => {
    const interval = "2026-11-19T03:00:00.000Z";
    saveGridPrice("TH_NP15_GEN-APND", interval, 67.57, "CAISO", minutesAgoIso(10), "");
    const res = await handleGridPrice({
      question: "what was the np15 hub price for the hour starting 2026-11-19T03:00:00Z?",
    });
    expect(res.node_or_zone).toBe("TH_NP15_GEN-APND");
    expect(res.lmp_usd_per_mwh).toBe(67.57);
  });

  it("explicit params win over conflicting question text", async () => {
    const interval = pastIso(6);
    saveGridPrice("EE", interval, 44.4, "Elering EE");
    const res = await handleGridPrice({
      node_or_zone: "EE",
      interval_start: interval,
      question: "What was the ZONE_J price at 2020-01-01T00:00:00Z?",
    });
    expect(res.node_or_zone).toBe("EE");
    expect(res.interval_start).toBe(interval);
    expect(res.lmp_usd_per_mwh).toBe(44.4);
  });

  it("question with no zone candidate -> 400 INVALID_NODE (same as absent param)", async () => {
    await expectApiError(
      handleGridPrice({ question: "What was the grid power price at 2026-11-19T03:00:00Z?" }),
      400,
      "INVALID_NODE",
    );
  });

  it("question with a zone but no parseable datetime -> 400 INVALID_INTERVAL", async () => {
    await expectApiError(
      handleGridPrice({ question: "What is the EE LMP right now?" }),
      400,
      "INVALID_INTERVAL",
    );
  });

  it("question naming a nonexistent calendar date -> 400 INVALID_INTERVAL (rollover-hardened path)", async () => {
    await expectApiError(
      handleGridPrice({ question: "What was the EE LMP at 2026-02-30T05:00:00Z?" }),
      400,
      "INVALID_INTERVAL",
    );
  });

  it("case guard: lowercase english words containing zone tokens extract nothing", async () => {
    // "final" contains fi, "between" contains ee, "western" contains west:
    // none may resolve to FI / EE / WEST.
    await expectApiError(
      handleGridPrice({ question: "what is the final fee between western nodes at 2026-11-19T03:00:00Z?" }),
      400,
      "INVALID_NODE",
    );
  });

  it("time-first phrasing: '05:00 UTC on 2026-11-19' recovers the interval", async () => {
    const interval = "2026-11-19T05:00:00.000Z";
    saveGridPrice("EE", interval, 38.25, "Elering EE");
    const res = await handleGridPrice({
      question: "What was the EE LMP at 05:00 UTC on 2026-11-19?",
    });
    expect(res.lmp_usd_per_mwh).toBe(38.25);
    expect(res.interval_start).toBe(interval);
  });

  it("date-first phrasing: 'on 2026-11-19 at 05:00 UTC' recovers the interval", async () => {
    const interval = "2026-11-19T05:00:00.000Z";
    saveGridPrice("EE", interval, 38.25, "Elering EE");
    const res = await handleGridPrice({
      question: "EE LMP on 2026-11-19 at 05:00 UTC please",
    });
    expect(res.lmp_usd_per_mwh).toBe(38.25);
    expect(res.interval_start).toBe(interval);
  });
});

// ---------------------------------------------------------------------------
// Natural-name zone aliases (A11): the name a person uses for a place
// resolves to the canonical supported zone, with the served zone named in
// the answer. Operators with no feed stay an honest 422.
describe("handleGridPrice natural-name aliases", () => {
  it("Estonia resolves to the EE bidding zone", async () => {
    const interval = pastIso(3);
    saveGridPrice("EE", interval, 83.1, "Elering EE");
    const res = await handleGridPrice({ node_or_zone: "Estonia", interval_start: interval });
    expect(res.verdict).toBe("verified");
    expect(res.lmp_usd_per_mwh).toBe(83.1);
    expect(res.node_or_zone).toBe("EE");
  });

  it("Finland / Latvia / Lithuania resolve to FI / LV / LT", async () => {
    const interval = pastIso(4);
    saveGridPrice("FI", interval, 10.5, "Elering FI");
    saveGridPrice("LV", interval, 84.2, "Elering LV");
    saveGridPrice("LT", interval, 85.3, "Elering LT");
    for (const [name, zone, lmp] of [
      ["Finland", "FI", 10.5],
      ["latvia", "LV", 84.2],
      ["LITHUANIA", "LT", 85.3],
    ] as const) {
      const res = await handleGridPrice({ node_or_zone: name, interval_start: interval });
      expect(res.node_or_zone).toBe(zone);
      expect(res.lmp_usd_per_mwh).toBe(lmp);
    }
  });

  it("New York City / nyc resolve to the N.Y.C. load zone", async () => {
    const interval = pastIso(5);
    saveGridPrice("N.Y.C.", interval, 30.42, "NYISO");
    for (const name of ["New York City", "nyc", "New York"]) {
      const res = await handleGridPrice({ node_or_zone: name, interval_start: interval });
      expect(res.node_or_zone).toBe("N.Y.C.");
      expect(res.market).toBe("NYISO");
      expect(res.lmp_usd_per_mwh).toBe(30.42);
    }
  });

  it("bare NYISO is answered for the N.Y.C. load zone (mirrors bare CAISO -> NP15)", async () => {
    const interval = pastIso(6);
    saveGridPrice("N.Y.C.", interval, 31.11, "NYISO");
    const res = await handleGridPrice({ node_or_zone: "NYISO", interval_start: interval });
    expect(res.node_or_zone).toBe("N.Y.C.");
    expect(res.market).toBe("NYISO");
    expect(res.lmp_usd_per_mwh).toBe(31.11);
  });

  it("Long Island resolves to LONGIL", async () => {
    const interval = pastIso(7);
    saveGridPrice("LONGIL", interval, 33.7, "NYISO");
    const res = await handleGridPrice({ node_or_zone: "Long Island", interval_start: interval });
    expect(res.node_or_zone).toBe("LONGIL");
    expect(res.lmp_usd_per_mwh).toBe(33.7);
  });

  it("operators with no feed stay an honest 422 (ERCOT, PJM, Texas)", async () => {
    const interval = pastIso(8);
    for (const name of ["ERCOT", "PJM", "Texas", "MISO"]) {
      await expectApiError(
        handleGridPrice({ node_or_zone: name, interval_start: interval }),
        422,
        "UNSUPPORTED_ZONE",
      );
    }
  });

  it("question path: 'What was the LMP in Estonia ...' recovers EE", async () => {
    const interval = pastIso(9);
    saveGridPrice("EE", interval, 77.7, "Elering EE");
    const res = await handleGridPrice({
      question: "What was the LMP in Estonia for the interval starting " + interval + "?",
    });
    expect(res.node_or_zone).toBe("EE");
    expect(res.lmp_usd_per_mwh).toBe(77.7);
  });

  it("question path: 'power price in New York City at <iso>Z' recovers N.Y.C.", async () => {
    const interval = pastIso(10);
    saveGridPrice("N.Y.C.", interval, 29.99, "NYISO");
    const res = await handleGridPrice({
      question: "What was the power price in New York City at " + interval + "?",
    });
    expect(res.node_or_zone).toBe("N.Y.C.");
    expect(res.lmp_usd_per_mwh).toBe(29.99);
  });
});
