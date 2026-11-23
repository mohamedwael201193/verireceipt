// MISO packet tests (vitest). Fixtures are REAL rows copied verbatim from
// the published MISO day-ahead ExPost LMP files:
//   https://docs.misoenergy.org/marketreports/20261123_da_expost_lmp.csv
//   https://docs.misoenergy.org/marketreports/20261122_da_expost_lmp.csv
// (preamble lines + header + the real ILLINOIS.HUB row; no invented
// values). MISO labels the file in fixed EST (UTC-5, no DST), HE n =
// the hour ENDING n:00 EST.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "fs";

const scratch = vi.hoisted(() => {
  const path = `/tmp/grid-miso-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return path;
});

import { saveGridPrice } from "../src/core/db";
import { closeStorage } from "../src/core/storage";
import { primaryUpstreamForGridZone, upstreamNameForUrl } from "../src/core/upstreams";
import { handleGridPrice, MISO_SYSTEM_MARKET, MISO_SYSTEM_NODE } from "../src/handlers/gridPrice";
import { fetchMisoDaLmp, MISO_REPORTS_URL, SUPPORTED_ZONES } from "../src/jobs/gridIngester";
import { gridFinalityPhase } from "../src/jobs/gridFinality";

afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await closeStorage();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(scratch + suffix, { force: true });
});

// Real file shape: three preamble lines, then the Node/Type header,
// then rows. ILLINOIS.HUB values below are the real 2026-11-23 file's
// row (HE 1 = 13.92, HE 2 = 14.97, ..., HE 24 = 41.66).
const CSV_20261123 = [
  "Day Ahead Market ExPost LMPs",
  "11/23/2026",
  "",
  ",,,All Hours-Ending are Eastern Standard Time (EST)",
  "Node,Type,Value,HE 1,HE 2,HE 3,HE 4,HE 5,HE 6,HE 7,HE 8,HE 9,HE 10,HE 11,HE 12,HE 13,HE 14,HE 15,HE 16,HE 17,HE 18,HE 19,HE 20,HE 21,HE 22,HE 23,HE 24",
  "ILLINOIS.HUB,Hub,LMP,13.92,14.97,16.3,16.29,19.31,24.92,37.26,61.52,36.88,20.31,22.58,23.22,23.09,22.26,21.47,24.98,48.21,109.66,72.73,46.92,47.5,43.59,42.22,41.66",
].join("\n");

// Real 2026-11-22 file's ILLINOIS.HUB row (HE 23 = 17.24, HE 24 = 16.82).
const CSV_20261122 = [
  "Day Ahead Market ExPost LMPs",
  "11/22/2026",
  "",
  ",,,All Hours-Ending are Eastern Standard Time (EST)",
  "Node,Type,Value,HE 1,HE 2,HE 3,HE 4,HE 5,HE 6,HE 7,HE 8,HE 9,HE 10,HE 11,HE 12,HE 13,HE 14,HE 15,HE 16,HE 17,HE 18,HE 19,HE 20,HE 21,HE 22,HE 23,HE 24",
  "ILLINOIS.HUB,Hub,LMP,10.74,9.36,8.39,7.98,7.56,7.81,8.9,12.58,12.05,11.13,11.84,10.51,10.38,11.25,11,11.32,15.37,32.48,26.2,20.34,19.01,18.71,17.24,16.82",
].join("\n");

function stubCsv(body: string) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => body } as Response;
    }),
  );
  return calls;
}

describe("fetchMisoDaLmp (EST/HE mapping against the real file shape)", () => {
  it("UTC 06:00 = EST 01:00 = HE 2 of the same EST day -> 14.97", async () => {
    const calls = stubCsv(CSV_20261123);
    const got = await fetchMisoDaLmp("ILLINOIS.HUB", "2026-11-23T06:00:00.000Z");
    expect(got).toEqual({
      lmp: 14.97,
      upstreamUrl: MISO_REPORTS_URL + "20261123_da_expost_lmp.csv",
    });
    expect(calls).toEqual([MISO_REPORTS_URL + "20261123_da_expost_lmp.csv"]);
  });

  it("UTC 05:00 = EST 00:00 = HE 1 -> 13.92", async () => {
    stubCsv(CSV_20261123);
    const got = await fetchMisoDaLmp("ILLINOIS.HUB", "2026-11-23T05:00:00.000Z");
    expect(got?.lmp).toBe(13.92);
  });

  it("date wrap: UTC 04:00 = EST 23:00 of the PREVIOUS day -> HE 24 of 20261122 -> 16.82", async () => {
    const calls = stubCsv(CSV_20261122);
    const got = await fetchMisoDaLmp("ILLINOIS.HUB", "2026-11-23T04:00:00.000Z");
    expect(got).toEqual({
      lmp: 16.82,
      upstreamUrl: MISO_REPORTS_URL + "20261122_da_expost_lmp.csv",
    });
    expect(calls).toEqual([MISO_REPORTS_URL + "20261122_da_expost_lmp.csv"]);
  });

  it("a well-formed file with no row for the node is a genuine miss (null)", async () => {
    stubCsv(CSV_20261123);
    await expect(fetchMisoDaLmp("TEXAS.HUB", "2026-11-23T06:00:00.000Z")).resolves.toBeNull();
  });

  it("fails closed on a non-numeric LMP cell", async () => {
    stubCsv(CSV_20261123.replace(",13.92,", ",not-a-number,"));
    await expect(fetchMisoDaLmp("ILLINOIS.HUB", "2026-11-23T05:00:00.000Z")).rejects.toThrow(
      /non-numeric LMP/,
    );
  });

  it("fails closed when the Node/Type header is absent", async () => {
    stubCsv("Day Ahead Market ExPost LMPs\n11/23/2026\n\nno header here");
    await expect(fetchMisoDaLmp("ILLINOIS.HUB", "2026-11-23T05:00:00.000Z")).rejects.toThrow(
      /missing Node\/Type header/,
    );
  });

  it("an unparseable interval is a miss, never a throw", async () => {
    stubCsv(CSV_20261123);
    await expect(fetchMisoDaLmp("ILLINOIS.HUB", "not-a-date")).resolves.toBeNull();
  });
});

describe("handleGridPrice MISO serving", () => {
  it("a MISO system question is answered for the Illinois hub with disclosure", async () => {
    stubCsv(CSV_20261122);
    const res = await handleGridPrice({
      question: "What was the MISO system LMP at 2026-11-23T04:00:00Z?",
    });
    expect(res.node_or_zone).toBe(MISO_SYSTEM_NODE);
    expect(res.lmp_usd_per_mwh).toBe(16.82);
    expect(res.market).toBe(MISO_SYSTEM_MARKET);
    expect(res.answer).toContain("Illinois hub");
    expect(res.answer).toContain("16.82");
  });

  it("natural hub name 'illinois hub' resolves to ILLINOIS.HUB", async () => {
    stubCsv(CSV_20261122);
    const res = await handleGridPrice({
      node_or_zone: "illinois hub",
      interval_start: "2026-11-23T03:00:00.000Z",
    });
    expect(res.node_or_zone).toBe("ILLINOIS.HUB");
    expect(res.lmp_usd_per_mwh).toBe(17.24); // HE 23, real value
    expect(res.market).toBe("MISO");
  });

  it("a cached MISO row is served with market MISO", async () => {
    saveGridPrice("ILLINOIS.HUB", "2026-11-23T04:00:00.000Z", 16.82, "MISO");
    stubCsv(CSV_20261122); // refresh, if attempted, returns the same value
    const res = await handleGridPrice({
      node_or_zone: "ILLINOIS.HUB",
      interval_start: "2026-11-23T04:00:00.000Z",
    });
    expect(res.node_or_zone).toBe("ILLINOIS.HUB");
    expect(res.lmp_usd_per_mwh).toBe(16.82);
    expect(res.market).toBe("MISO");
  });

  it("every classic hub is a supported MISO zone with a 60-minute window", () => {
    for (const hub of [
      "ARKANSAS.HUB", "ILLINOIS.HUB", "INDIANA.HUB", "LOUISIANA.HUB",
      "MICHIGAN.HUB", "MINN.HUB", "MS.HUB", "TEXAS.HUB",
    ]) {
      const z = SUPPORTED_ZONES[hub];
      expect(z, hub).toBeDefined();
      expect(z.market).toBe("MISO");
      expect(z.windowMin).toBe(60);
    }
  });
});

describe("MISO upstream + finality bookkeeping", () => {
  it("MISO hubs map to the miso-marketreports upstream", () => {
    expect(primaryUpstreamForGridZone("ILLINOIS.HUB")).toBe("miso-marketreports");
    expect(primaryUpstreamForGridZone("texas.hub")).toBe("miso-marketreports");
    expect(
      upstreamNameForUrl(MISO_REPORTS_URL + "20261123_da_expost_lmp.csv"),
    ).toBe("miso-marketreports");
  });

  it("provisional window: one weekday after the delivery day, end of that EST day", () => {
    // Interval UTC 2026-11-23T04:00Z = EST Sunday 2026-11-22 23:00.
    // First weekday after Sunday 22 is Monday 23; close = end of
    // Monday EST = 2026-11-24T05:00:00Z. Correction close equals the
    // provisional close, so the phase goes straight to final.
    const start = Date.parse("2026-11-23T04:00:00.000Z");
    expect(gridFinalityPhase("MISO", start, Date.parse("2026-11-24T04:59:59.000Z"))).toBe("provisional");
    expect(gridFinalityPhase("MISO", start, Date.parse("2026-11-24T05:00:00.000Z"))).toBe("final");
  });

  it("weekend days do not count: a Friday delivery also closes end of Monday EST", () => {
    // UTC 2026-11-21T04:00Z = EST Friday 2026-11-20 23:00; Saturday 21
    // and Sunday 22 are skipped, close = end of Monday 23 EST.
    const start = Date.parse("2026-11-21T04:00:00.000Z");
    expect(gridFinalityPhase("MISO", start, Date.parse("2026-11-23T12:00:00.000Z"))).toBe("provisional");
    expect(gridFinalityPhase("MISO", start, Date.parse("2026-11-24T05:00:00.000Z"))).toBe("final");
  });
});
