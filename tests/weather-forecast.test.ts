import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/weather-forecast-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
import { handleWeatherForecast, resolveGeocode } from "../src/handlers/weatherForecast";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";

// Fixtures are real upstream bodies retrieved 2026-11-23 (Cairo). The
// suite freezes wall time inside the forecast window the fixture
// covers — the same anti-rot doctrine as the pinned-block route tests.
const FX = join(__dirname, "fixtures/weather-forecast");
const GEO_CAIRO = readFileSync(join(FX, "geocode-cairo.json"), "utf8");
const GEO_CAIRO_EG = readFileSync(join(FX, "geocode-cairo-egypt.json"), "utf8");
const GEO_NOMATCH = readFileSync(join(FX, "geocode-nomatch.json"), "utf8");
const FC_CAIRO = readFileSync(join(FX, "forecast-cairo.json"), "utf8");
// The fixture covers 2026-11-23T00:00..2026-11-24T23:00 Africa/Cairo
// (UTC+2). Freeze at 10:00 UTC = 12:00 local.
const FROZEN_UTC = "2026-11-23T10:00:00Z";

function stub(opts: { geoBody?: string; geoDown?: boolean; fcDown?: boolean } = {}): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    requested.push(u);
    if (u.includes("geocoding-api.open-meteo.com")) {
      if (opts.geoDown) throw new Error("geocoder outage");
      if (u.includes("name=Cairo%2C+Egypt") || u.includes("name=Cairo%2C%20Egypt")) return new Response(GEO_CAIRO_EG, { status: 200 });
      if (opts.geoBody) return new Response(opts.geoBody, { status: 200 });
      return new Response(GEO_CAIRO, { status: 200 });
    }
    if (u.includes("api.open-meteo.com")) {
      if (opts.fcDown) throw new Error("forecast outage");
      return new Response(FC_CAIRO, { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return requested;
}
beforeEach(() => vi.useFakeTimers({ now: new Date(FROZEN_UTC).getTime() }));

// Expected window stats computed from the fixture itself: local Cairo
// hour 2026-11-23T12:00 + 24h.
function expectedWindow(hours: number): { max: number; min: number } {
  const d = JSON.parse(FC_CAIRO);
  const i = d.hourly.time.findIndex((t: string) => t >= "2026-11-23T12:00");
  const temps = d.hourly.temperature_2m.slice(i, i + hours).filter((t: number | null) => t !== null);
  return { max: Math.max(...temps), min: Math.min(...temps) };
}

describe("WEATHER_FORECAST_GENERAL", () => {
  it("requests one extra forecast day so a 24h window after local midnight is coverable (live bug pin)", async () => {
    // Live on 2026-11-23 a 24h window 422'd: forecast_days=1 makes
    // Open-Meteo return only today's local hours (00:00-23:00), so a
    // window starting after hour 00 is never covered. The handler must
    // ask for ceil(window/24)+1 days.
    const requested = stub();
    await handleWeatherForecast({ location: "Cairo, Egypt" });
    const fc = requested.find((u) => u.includes("api.open-meteo.com/v1/forecast"));
    expect(fc).toBeDefined();
    expect(fc).toContain("forecast_days=2");
  });
  it("a qualified place name resolves, names place+coords, and the window stats match the fixture exactly", async () => {
    stub();
    const result = await handleWeatherForecast({ location: "Cairo, Egypt" });
    expect(String(result.location)).toContain("Cairo");
    expect(String(result.location)).toContain("Egypt");
    expect(String(result.location)).toContain("30.0626");
    const exp = expectedWindow(24);
    expect(result.temp_max_c).toBe(exp.max);
    expect(result.temp_min_c).toBe(exp.min);
    expect(String(result.when)).toContain("2026-11-23T12:00");
    expect(String(result.answer)).toContain("not a measurement");
    expect(String(result.answer)).toContain("°C");
  });
  it("bare 'Cairo' is AMBIGUOUS (Egypt vs US) and refuses with the candidate list, no first-hit pick", async () => {
    stub();
    await expect(handleWeatherForecast({ location: "Cairo" })).rejects.toMatchObject({ status: 422, code: "AMBIGUOUS_LOCATION" });
    try {
      await handleWeatherForecast({ location: "Cairo" });
    } catch (e) {
      expect((e as Error).message).toContain("Cairo, Cairo Governorate, Egypt");
      expect((e as Error).message).toContain("United States");
    }
  });
  it("an unresolvable name is 422 PLACE_NOT_FOUND", async () => {
    stub({ geoBody: GEO_NOMATCH });
    await expect(handleWeatherForecast({ location: "Xqzzwibble" })).rejects.toMatchObject({ status: 422, code: "PLACE_NOT_FOUND" });
  });
  it("direct lat,lon skips the geocoder entirely", async () => {
    const requested = stub();
    const result = await handleWeatherForecast({ location: "30.06,31.25" });
    expect(requested.some((u) => u.includes("geocoding-api"))).toBe(false);
    expect(requested.some((u) => u.includes("api.open-meteo.com/v1/forecast"))).toBe(true);
    expect(String(result.location)).toContain("coordinates given directly");
    expect(result.temp_max_c).toBe(expectedWindow(24).max);
  });
  it("window_hours bounds are enforced (1..240, integer) and out-of-range lat,lon is 400", async () => {
    stub();
    await expect(handleWeatherForecast({ location: "Cairo, Egypt", window_hours: "0" })).rejects.toMatchObject({ status: 400, code: "INVALID_WINDOW" });
    await expect(handleWeatherForecast({ location: "Cairo, Egypt", window_hours: "241" })).rejects.toMatchObject({ status: 400 });
    await expect(handleWeatherForecast({ location: "Cairo, Egypt", window_hours: "abc" })).rejects.toMatchObject({ status: 400 });
    await expect(handleWeatherForecast({ location: "91,0" })).rejects.toMatchObject({ status: 400 });
    await expect(handleWeatherForecast({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
  });
  it("a window longer than the retrieved forecast is refused, never extrapolated", async () => {
    stub();
    // 48h from 12:00 local exceeds the fixture's 48 half-used hours.
    await expect(handleWeatherForecast({ location: "30.06,31.25", window_hours: "40" })).rejects.toMatchObject({ status: 422, code: "FORECAST_WINDOW_UNCOVERED" });
  });
  it("fails closed when the geocoder or the forecast API is down", async () => {
    stub({ geoDown: true });
    await expect(handleWeatherForecast({ location: "Cairo, Egypt" })).rejects.toMatchObject({ status: 502 });
    stub({ fcDown: true });
    await expect(handleWeatherForecast({ location: "30.06,31.25" })).rejects.toMatchObject({ status: 502 });
  });
  it("the receipt is persisted and evidence carries both upstream sha256s and the model-not-measurement note", async () => {
    stub();
    const result = await handleWeatherForecast({ location: "Cairo, Egypt" });
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("WEATHER_FORECAST_GENERAL");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
    const ev = String(stored.evidence);
    expect(ev).toContain("geocoding-api.open-meteo.com");
    expect(ev).toContain("api.open-meteo.com/v1/forecast");
    expect(ev).toContain("NOT a measurement");
  });
  it("resolveGeocode ambiguity rule: same name in another country refuses, different features of one place accept", () => {
    expect(() => resolveGeocode(GEO_CAIRO, "Cairo")).toThrowError(/AMBIGUOUS|distinct places/);
    const hit = resolveGeocode(GEO_CAIRO_EG, "Cairo, Egypt");
    expect(hit.country).toBe("Egypt");
    expect(hit.name).toBe("Cairo");
  });
  it("GET /v1/weather-forecast is wired and returns the envelope; missing location is 400", async () => {
    stub();
    const app = await buildServer();
    const ok = await app.inject({ method: "GET", url: "/v1/weather-forecast?location=Cairo%2C%20Egypt" });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { receipt: { intent: string }; temp_max_c: number };
    expect(body.receipt.intent).toBe("WEATHER_FORECAST_GENERAL");
    expect(body.temp_max_c).toBe(expectedWindow(24).max);
    const bad = await app.inject({ method: "GET", url: "/v1/weather-forecast" });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
