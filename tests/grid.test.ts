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
import { runIngesterOnce, SUPPORTED_ZONES } from "../src/jobs/gridIngester";

function pastIso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

function futureIso(hoursAhead: number): string {
  return new Date(Date.now() + hoursAhead * 3600_000).toISOString();
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
