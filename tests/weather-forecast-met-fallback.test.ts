import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/weather-forecast-met-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
import { resetForecastSourcesForTests } from "../src/handlers/forecastSourceCache";
import { resetMetBudgetForTests } from "../src/handlers/metForecast";
import { handleWeatherForecast } from "../src/handlers/weatherForecast";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

const FX = join(__dirname, "fixtures/weather-forecast");
const GEO_MIAMI = readFileSync(join(FX, "geocode-miami.json"), "utf8");
const MET_MIAMI = readFileSync(join(FX, "met-locationforecast-miami-20261128T0708Z.json"), "utf8");
const GEO_CAIRO = readFileSync(join(FX, "geocode-cairo.json"), "utf8");
const FC_CAIRO = readFileSync(join(FX, "forecast-cairo.json"), "utf8");
// Miami is UTC-5 in late November. 08:00Z = 03:00 local; the MET capture starts 06:00Z and is hourly to 2026-11-30T18:00Z.
const FROZEN_MIAMI = "2026-11-28T08:00:00Z";
const FROZEN_CAIRO = "2026-11-23T10:00:00Z";

beforeEach(() => { resetForecastSourcesForTests(); resetMetBudgetForTests(); vi.useFakeTimers({ now: new Date(FROZEN_MIAMI).getTime() }); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function stubMiami(opts: { met?: string | number; geoBody?: string } = {}): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url); requested.push(u);
    if (u.includes("geocoding-api.open-meteo.com")) return new Response(opts.geoBody ?? GEO_MIAMI, { status: 200 });
    if (u.includes("api.open-meteo.com")) return new Response("{}", { status: 429 });
    if (u.includes("api.met.no")) {
      if (typeof opts.met === "number") return new Response("{}", { status: opts.met });
      return new Response(opts.met ?? MET_MIAMI, { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return requested;
}
async function run(q: Record<string, string>) { const p = handleWeatherForecast(q); const settled = p.then((v) => ({ ok: v }), (e) => ({ err: e })); await vi.advanceTimersByTimeAsync(2000); return settled; }

// Expected window computed independently from the captured MET body: hourly steps starting at 08:00Z.
function expected(hours: number) {
  const d = JSON.parse(MET_MIAMI);
  const i = d.properties.timeseries.findIndex((r: { time: string }) => r.time === "2026-11-28T08:00:00Z");
  const t = d.properties.timeseries.slice(i, i + hours).map((r: { data: { instant: { details: { air_temperature: number } } } }) => r.data.instant.details.air_temperature);
  return { max: Math.max(...t), min: Math.min(...t) };
}

describe("WEATHER_FORECAST_GENERAL MET Norway fallback", () => {
  it("(a) primary 429 twice, MET answers: disclosed fallback with independent extrema and null probability", async () => {
    const requested = stubMiami();
    const r = await run({ location: "Miami", window_hours: "24" }) as { ok?: Record<string, unknown> };
    expect(r.ok).toBeTruthy();
    const out = r.ok!; const exp = expected(24);
    expect(out.temp_max_c).toBe(exp.max); expect(out.temp_min_c).toBe(exp.min);
    expect(out.precipitation_probability_pct).toBeNull();
    expect(out.extras).toBeNull();
    expect(out.forecast_source).toBe("met.no locationforecast 2.0 compact (fallback; primary Open-Meteo unavailable)");
    for (const text of [out.answer, out.summary] as string[]) {
      expect(text).toContain("met.no locationforecast 2.0 compact (fallback; primary Open-Meteo unavailable)");
      expect(text).toContain("no precipitation probability available from this source");
    }
    expect(requested.some((u) => u.includes("api.met.no"))).toBe(true);
    const stored = await getReceiptEvidence((out.receipt as { receipt_id: string }).receipt_id);
    const ev = JSON.parse(stored.evidence!.toString());
    expect(ev.forecast_upstream.raw_body).toBe(MET_MIAMI);
    expect(ev.forecast_upstream.url).toMatch(/^https:\/\/api\.met\.no\/weatherapi\/locationforecast\/2\.0\/compact\?lat=25\.7743&lon=-80\.1937$/);
    expect(ev.forecast_upstream.sha256).toBe(sha256Hex(Buffer.from(MET_MIAMI, "utf8")));
    expect(ev.method).toContain("MET Norway model forecast, fallback");
    expect(ev.extras).toBeNull(); expect(ev.precipitation_probability_pct).toBeNull();
  });

  it("(b) primary success path is unchanged and carries no fallback disclosure", async () => {
    vi.setSystemTime(new Date(FROZEN_CAIRO));
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("geocoding-api.open-meteo.com")) return new Response(GEO_CAIRO, { status: 200 });
      if (u.includes("api.open-meteo.com")) return new Response(FC_CAIRO, { status: 200 });
      throw new Error("secondary offline");
    });
    const out = await handleWeatherForecast({ location: "Cairo", window_hours: "24" });
    expect(out.forecast_source).toBeUndefined();
    expect(typeof out.precipitation_probability_pct).toBe("number");
    expect(out.answer as string).not.toContain("fallback");
  });

  it("(c) both sources fail: 502 as before", async () => {
    stubMiami({ met: 503 });
    const r = await run({ location: "Miami", window_hours: "24" }) as { err?: { status: number; code: string } };
    expect(r.err).toMatchObject({ status: 502, code: "UPSTREAM_UNREACHABLE" });
  });

  it("(d) a gap inside the MET window is refused, nothing interpolated", async () => {
    const d = JSON.parse(MET_MIAMI);
    d.properties.timeseries = d.properties.timeseries.filter((r: { time: string }) => r.time !== "2026-11-28T12:00:00Z");
    stubMiami({ met: JSON.stringify(d) });
    const r = await run({ location: "Miami", window_hours: "24" }) as { err?: { status: number; code: string } };
    expect(r.err).toMatchObject({ status: 502, code: "UPSTREAM_UNREACHABLE" });
  });

  it("(e) a 120 h window that needs 6-hourly steps is refused", async () => {
    stubMiami();
    const r = await run({ location: "Miami", window_hours: "120" }) as { err?: { status: number; code: string } };
    expect(r.err).toMatchObject({ status: 502, code: "UPSTREAM_UNREACHABLE" });
  });

  it("direct coordinates have no timezone: fallback refuses, MET is not trusted for an offset", async () => {
    stubMiami();
    const r = await run({ location: "25.77427,-80.19366", window_hours: "24" }) as { err?: { status: number; code: string } };
    expect(r.err).toMatchObject({ status: 502, code: "UPSTREAM_UNREACHABLE" });
  });

  it("a malformed primary body is not a fallback case", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url); requested.push(u);
      if (u.includes("geocoding-api.open-meteo.com")) return new Response(GEO_MIAMI, { status: 200 });
      if (u.includes("api.open-meteo.com")) return new Response("not json", { status: 200 });
      throw new Error("must not be reached");
    });
    const r = await run({ location: "Miami", window_hours: "24" }) as { err?: { status: number; code: string } };
    expect(r.err).toMatchObject({ status: 502, code: "FORECAST_MALFORMED" });
    expect(requested.some((u) => u.includes("api.met.no"))).toBe(false);
  });
});
