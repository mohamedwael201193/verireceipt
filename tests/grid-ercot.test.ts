// ERCOT packet tests (vitest). Fixtures are REAL rows copied verbatim
// from the published ERCOT cdr pages:
//   https://www.ercot.com/content/cdr/html/20261122_dam_spp (CST day)
//   https://www.ercot.com/content/cdr/html/20260308_dam_spp (spring-forward)
// No invented values. The pages label rows Oper Day + Hour Ending in
// CPT (America/Chicago, DST-aware): HE n starts at wall (n-1):00.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "fs";

const scratch = vi.hoisted(() => {
  const path = `/tmp/grid-ercot-${process.pid}-${Date.now()}.sqlite`;
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  return path;
});

import { saveGridPrice } from "../src/core/db";
import { closeStorage } from "../src/core/storage";
import { primaryUpstreamForGridZone, upstreamNameForUrl } from "../src/core/upstreams";
import { handleGridPrice, ERCOT_SYSTEM_MARKET, ERCOT_SYSTEM_NODE } from "../src/handlers/gridPrice";
import { ERCOT_CDR_URL, fetchErcotDamSpp, SUPPORTED_ZONES } from "../src/jobs/gridIngester";
import { gridFinalityPhase } from "../src/jobs/gridFinality";

afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await closeStorage();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(scratch + suffix, { force: true });
});

const HEADER =
  "Oper Day,Hour Ending,HB_BUSAVG,HB_HOUSTON,HB_HUBAVG,HB_NORTH,HB_PAN,HB_SOUTH,HB_WEST,LZ_AEN,LZ_CPS,LZ_HOUSTON,LZ_LCRA,LZ_NORTH,LZ_RAYBN,LZ_SOUTH,LZ_WEST";

function table(rows: string[]): string {
  const tr = (line: string) => "<tr>" + line.split(",").map((c) => "<td>" + c + "</td>").join("") + "</tr>";
  return "<html><body><table>" + tr(HEADER) + rows.map(tr).join("") + "</table></body></html>";
}

// Real rows from the 2026-11-22 page (CST, UTC-6).
const ROW_1122_HE1 = "11/22/2026,1,25.47,25.74,27.16,23.05,18.10,27.11,32.73,27.13,28.21,26.51,27.65,22.99,22.71,27.08,46.45";
const ROW_1122_HE24 = "11/22/2026,24,26.40,26.32,26.62,26.13,26.15,26.47,27.56,26.57,26.75,26.66,26.64,26.13,26.10,26.54,29.83";
// Real rows from the 2026-03-08 spring-forward page (HE 3 absent on it).
const ROW_0308_HE2 = "03/08/2026,2,35.78,35.34,36.24,35.45,36.12,35.00,39.18,34.88,35.30,35.34,35.20,35.48,35.52,35.75,47.84";
const ROW_0308_HE4 = "03/08/2026,4,33.63,33.03,34.20,33.24,33.46,32.54,37.97,32.48,32.86,33.08,32.98,33.29,33.38,33.40,48.41";

// Real rows from the 2026-07-15 page (CDT, UTC-5 — summer mapping pin).
const ROW_0715_HE1 = "07/15/2026,1,30.06,29.55,30.28,30.34,30.53,28.02,33.19,29.98,30.39,29.52,30.12,30.38,30.38,25.50,36.91";
const ROW_0715_HE24 = "07/15/2026,24,28.81,28.71,28.82,29.15,28.31,27.46,29.97,28.86,29.17,28.69,28.97,29.17,29.16,25.58,31.12";

const PAGE_20261122 = table([ROW_1122_HE1, ROW_1122_HE24]);
const PAGE_20260715 = table([ROW_0715_HE1, ROW_0715_HE24]);
const PAGE_20260308 = table([ROW_0308_HE2, ROW_0308_HE4]);

function stubPage(body: string) {
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

describe("fetchErcotDamSpp (CPT/HE mapping against the real page shape)", () => {
  it("CST: UTC 06:00 = wall 00:00 = HE 1 -> HB_BUSAVG 25.47", async () => {
    const calls = stubPage(PAGE_20261122);
    const got = await fetchErcotDamSpp("HB_BUSAVG", "2026-11-22T06:00:00.000Z");
    expect(got).toEqual({ lmp: 25.47, upstreamUrl: ERCOT_CDR_URL + "20261122_dam_spp" });
    expect(calls).toEqual([ERCOT_CDR_URL + "20261122_dam_spp"]);
  });

  it("HE 24: UTC 2026-11-23T05:00 = wall 11/22 23:00 -> HE 24 of the 20261122 page", async () => {
    const calls = stubPage(PAGE_20261122);
    const got = await fetchErcotDamSpp("HB_BUSAVG", "2026-11-23T05:00:00.000Z");
    expect(got).toEqual({ lmp: 26.40, upstreamUrl: ERCOT_CDR_URL + "20261122_dam_spp" });
    expect(calls).toEqual([ERCOT_CDR_URL + "20261122_dam_spp"]);
  });

  it("spring-forward: UTC 07:00 = wall 01:00 CST = HE 2 -> 35.78", async () => {
    stubPage(PAGE_20260308);
    const got = await fetchErcotDamSpp("HB_BUSAVG", "2026-03-08T07:00:00.000Z");
    expect(got?.lmp).toBe(35.78);
  });

  it("spring-forward: UTC 08:00 = wall 03:00 CDT = HE 4 -> 33.63", async () => {
    stubPage(PAGE_20260308);
    const got = await fetchErcotDamSpp("HB_BUSAVG", "2026-03-08T08:00:00.000Z");
    expect(got?.lmp).toBe(33.63);
  });

  it("CDT summer mapping: UTC 05:00 = wall 00:00 CDT = HE 1 -> 30.06", async () => {
    const calls = stubPage(PAGE_20260715);
    const got = await fetchErcotDamSpp("HB_BUSAVG", "2026-07-15T05:00:00.000Z");
    expect(got).toEqual({ lmp: 30.06, upstreamUrl: ERCOT_CDR_URL + "20260715_dam_spp" });
    expect(calls).toEqual([ERCOT_CDR_URL + "20260715_dam_spp"]);
  });

  it("CDT summer mapping, no date wrap: UTC 2026-07-16T04:00 = wall 23:00 CDT 07/15 = HE 24 -> 28.81", async () => {
    const calls = stubPage(PAGE_20260715);
    const got = await fetchErcotDamSpp("HB_BUSAVG", "2026-07-16T04:00:00.000Z");
    expect(got).toEqual({ lmp: 28.81, upstreamUrl: ERCOT_CDR_URL + "20260715_dam_spp" });
    expect(calls).toEqual([ERCOT_CDR_URL + "20260715_dam_spp"]);
  });

  it("fall-back duplicate HE 2 (hypothetical 25-row page): both UTC hours serve the FIRST matching row", async () => {
    // Reviewer control: the repeated wall hour 01:00 on a fall-back
    // page would appear as two HE 2 rows; the fetch maps BOTH UTC
    // hours (CDT and CST occurrences) to HE 2 and the first matching
    // row wins, so the second row is unservable from this page shape.
    stubPage(table([
      "11/01/2026,1,10.00,10.00,10.00,10.00,10.00,10.00,10.00,10.00,10.00,10.00,10.00,10.00,10.00,10.00,10.00",
      "11/01/2026,2,11.11,11.11,11.11,11.11,11.11,11.11,11.11,11.11,11.11,11.11,11.11,11.11,11.11,11.11,11.11",
      "11/01/2026,2,22.22,22.22,22.22,22.22,22.22,22.22,22.22,22.22,22.22,22.22,22.22,22.22,22.22,22.22,22.22",
      "11/01/2026,3,12.00,12.00,12.00,12.00,12.00,12.00,12.00,12.00,12.00,12.00,12.00,12.00,12.00,12.00,12.00",
    ]));
    const cdt = await fetchErcotDamSpp("HB_BUSAVG", "2026-11-01T06:00:00.000Z"); // wall 01:00 CDT
    const cst = await fetchErcotDamSpp("HB_BUSAVG", "2026-11-01T07:00:00.000Z"); // wall 01:00 CST
    expect(cdt?.lmp).toBe(11.11);
    expect(cst?.lmp).toBe(11.11);
  });

  it("a well-formed page with no row for the hour is a genuine miss (null)", async () => {
    // Controlled truncation of the real 11/22 page: HE 1 row only.
    stubPage(table([ROW_1122_HE1]));
    await expect(fetchErcotDamSpp("HB_BUSAVG", "2026-11-23T05:00:00.000Z")).resolves.toBeNull();
  });

  it("fails closed on a blank cell — never serves $0.00", async () => {
    stubPage(table([ROW_1122_HE1.replace(",25.47,", ",,")]));
    await expect(fetchErcotDamSpp("HB_BUSAVG", "2026-11-22T06:00:00.000Z")).rejects.toThrow(
      /blank SPP cell/,
    );
  });

  it("fails closed on a whitespace-only cell", async () => {
    stubPage(table([ROW_1122_HE1.replace(",25.47,", ", ,")]));
    await expect(fetchErcotDamSpp("HB_BUSAVG", "2026-11-22T06:00:00.000Z")).rejects.toThrow(
      /blank SPP cell/,
    );
  });

  it("fails closed on a non-numeric cell", async () => {
    stubPage(table([ROW_1122_HE1.replace(",25.47,", ",N/A,")]));
    await expect(fetchErcotDamSpp("HB_BUSAVG", "2026-11-22T06:00:00.000Z")).rejects.toThrow(
      /non-numeric SPP/,
    );
  });

  it("fails closed when the page has no Oper Day table (unpublished-day shell)", async () => {
    stubPage("<html><body>The Day-Ahead Market for the current operating day has not completed.</body></html>");
    await expect(fetchErcotDamSpp("HB_BUSAVG", "2026-11-22T06:00:00.000Z")).rejects.toThrow(
      /missing Oper Day table/,
    );
  });

  it("fails closed when the settlement point column is absent", async () => {
    stubPage(PAGE_20261122);
    await expect(fetchErcotDamSpp("HB_NOTREAL", "2026-11-22T06:00:00.000Z")).rejects.toThrow(
      /missing settlement point column/,
    );
  });

  it("an unparseable interval is a miss, never a throw", async () => {
    stubPage(PAGE_20261122);
    await expect(fetchErcotDamSpp("HB_BUSAVG", "not-a-date")).resolves.toBeNull();
  });
});

describe("handleGridPrice ERCOT serving", () => {
  it("a bare 'ercot' question is answered for the hub average with disclosure", async () => {
    stubPage(PAGE_20261122);
    const res = await handleGridPrice({
      question: "What was the ERCOT price at 2026-11-22T06:00:00Z?",
    });
    expect(res.node_or_zone).toBe(ERCOT_SYSTEM_NODE);
    expect(res.lmp_usd_per_mwh).toBe(27.16); // real HE 1 HB_HUBAVG
    expect(res.market).toBe(ERCOT_SYSTEM_MARKET);
    expect(res.answer).toContain("hub average");
    expect(res.answer).toContain("27.16");
  });

  it("an exact settlement point serves its own value with market ERCOT", async () => {
    stubPage(PAGE_20261122);
    const res = await handleGridPrice({
      node_or_zone: "LZ_HOUSTON",
      interval_start: "2026-11-22T06:00:00.000Z",
    });
    expect(res.node_or_zone).toBe("LZ_HOUSTON");
    expect(res.lmp_usd_per_mwh).toBe(26.51); // real HE 1 LZ_HOUSTON
    expect(res.market).toBe("ERCOT");
  });

  it("a cached ERCOT row is served with market ERCOT", async () => {
    saveGridPrice("HB_NORTH", "2026-11-22T06:00:00.000Z", 23.05, "ERCOT");
    stubPage(PAGE_20261122); // refresh, if attempted, returns the same value
    const res = await handleGridPrice({
      node_or_zone: "HB_NORTH",
      interval_start: "2026-11-22T06:00:00.000Z",
    });
    expect(res.node_or_zone).toBe("HB_NORTH");
    expect(res.lmp_usd_per_mwh).toBe(23.05); // real HE 1 HB_NORTH
    expect(res.market).toBe("ERCOT");
  });

  it("all 15 settlement points are supported ERCOT zones at 60 minutes", () => {
    for (const sp of [
      "HB_BUSAVG", "HB_HOUSTON", "HB_HUBAVG", "HB_NORTH", "HB_PAN", "HB_SOUTH", "HB_WEST",
      "LZ_AEN", "LZ_CPS", "LZ_HOUSTON", "LZ_LCRA", "LZ_NORTH", "LZ_RAYBN", "LZ_SOUTH", "LZ_WEST",
    ]) {
      const z = SUPPORTED_ZONES[sp];
      expect(z, sp).toBeDefined();
      expect(z.market).toBe("ERCOT");
      expect(z.windowMin).toBe(60);
    }
  });
});

describe("ERCOT upstream + finality bookkeeping", () => {
  it("settlement points map to the ercot-cdr upstream", () => {
    expect(primaryUpstreamForGridZone("HB_NORTH")).toBe("ercot-cdr");
    expect(primaryUpstreamForGridZone("lz_houston")).toBe("ercot-cdr");
    expect(upstreamNameForUrl(ERCOT_CDR_URL + "20261122_dam_spp")).toBe("ercot-cdr");
  });

  it("provisional window: one weekday after the delivery day, end of that CPT day", () => {
    // Interval UTC 2026-11-23T05:00Z = wall Sunday 2026-11-22 23:00 CST.
    // First weekday after Sunday 22 is Monday 23; close = end of
    // Monday CST = 2026-11-24T06:00:00Z. Correction close equals the
    // provisional close, so the phase goes straight to final.
    const start = Date.parse("2026-11-23T05:00:00.000Z");
    expect(gridFinalityPhase("ERCOT", start, Date.parse("2026-11-24T05:59:59.000Z"))).toBe("provisional");
    expect(gridFinalityPhase("ERCOT", start, Date.parse("2026-11-24T06:00:00.000Z"))).toBe("final");
  });
});
