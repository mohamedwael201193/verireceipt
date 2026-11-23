import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const scratch = mkdtempSync("/tmp/weather-check-tests-");
process.env.SQLITE_PATH = join(scratch, "receipts.sqlite");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
import { handleWeatherCheck } from "../src/handlers/weatherCheck";
import { buildServer } from "../src/server";
import { getReceiptEvidence } from "../src/core/storage";
import { sha256Hex } from "../src/core/receipt";
// Real aviationweather.gov METAR body for HECA, retrieved 2026-11-23.
const heca = readFileSync(join(__dirname, "fixtures/weather-check/metar-heca.json"), "utf8");
function stub(body: string | "ERR" = heca): void {
  vi.stubGlobal("fetch", async () => {
    if (body === "ERR") throw new Error("test outage");
    return new Response(body, { status: 200 });
  });
}
describe("WEATHER_CHECK_TEMPERATURE", () => {
  it("requires a location; unknown place names refuse honestly", async () => {
    await expect(handleWeatherCheck({})).rejects.toMatchObject({ status: 400, code: "MISSING_PARAM" });
    // Geocoder finds nothing for the query: 422 PLACE_NOT_FOUND, never a guess.
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response('{"results":[]}', { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    await expect(handleWeatherCheck({ location: "Zzznotaplace" })).rejects.toMatchObject({ status: 422, code: "PLACE_NOT_FOUND" });
  });

  it("W1: a place name resolves through the geocoder to the nearest reporting station, disclosed", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    const geo = JSON.stringify({ results: [{ name: "Cairo", latitude: 30.0444, longitude: 31.2357, country: "Egypt", admin1: "Cairo", country_code: "EG" }] });
    const stations = JSON.stringify([
      { icaoId: "HECA", lat: 30.133, lon: 31.405, siteType: ["METAR", "TAF"] },
      { icaoId: "HEXX", lat: 30.5, lon: 31.9, siteType: ["TAF"] },
    ]);
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response(geo, { status: 200 });
      if (u.startsWith("https://aviationweather.gov/api/data/stationinfo")) return new Response(stations, { status: 200 });
      if (u.startsWith("https://aviationweather.gov/api/data/metar")) return new Response(heca, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "Cairo" });
    expect(result.temperature_c).toBe(16);
    expect(result.station_name).toBe("Cairo Intl, QH, EG");
    expect(String(result.resolved_place)).toContain("Cairo, Egypt");
    expect(typeof result.station_distance_km).toBe("number");
    const ans = String(result.answer);
    expect(ans).toContain("nearest reporting station is HECA");
    expect(ans).toContain("km away");
    expect(ans).toContain("never a forecast");
  });

  it("W1: a non-reporting nearest station falls back to the next by distance, named in the answer", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    const stations = JSON.stringify([
      { icaoId: "EGRB", lat: 51.5, lon: -0.1, siteType: ["METAR"] },
      { icaoId: "HECA", lat: 30.133, lon: 31.405, siteType: ["METAR"] },
    ]);
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://aviationweather.gov/api/data/stationinfo")) return new Response(stations, { status: 200 });
      if (u.includes("ids=EGRB")) return new Response("[]", { status: 200 });
      if (u.includes("ids=HECA")) return new Response(heca, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "51.5,-0.12" });
    expect(result.temperature_c).toBe(16);
    expect(result.station_name).toBe("Cairo Intl, QH, EG");
    expect(String(result.answer)).toContain("nearest reporting station is HECA");
  });

  it("W1: when no candidate station reports, the refusal names what was tried", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    const stations = JSON.stringify([
      { icaoId: "EGRB", lat: 51.5, lon: -0.1, siteType: ["METAR"] },
      { icaoId: "EGXX", lat: 51.6, lon: -0.2, siteType: ["METAR"] },
    ]);
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://aviationweather.gov/api/data/stationinfo")) return new Response(stations, { status: 200 });
      if (u.startsWith("https://aviationweather.gov/api/data/metar")) return new Response("[]", { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    await expect(handleWeatherCheck({ location: "51.5,-0.12" })).rejects.toMatchObject({
      status: 422, code: "NO_USABLE_OBSERVATION", message: expect.stringContaining("EGRB, EGXX"),
    });
  });

  it("W1: direct lat,lon coordinates skip the geocoder and say so", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    const stations = JSON.stringify([{ icaoId: "HECA", lat: 30.133, lon: 31.405, siteType: ["METAR"] }]);
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) throw new Error("geocoder must not be called for direct coordinates");
      if (u.startsWith("https://aviationweather.gov/api/data/stationinfo")) return new Response(stations, { status: 200 });
      if (u.startsWith("https://aviationweather.gov/api/data/metar")) return new Response(heca, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "30.04,31.24" });
    expect(result.temperature_c).toBe(16);
    expect(String(result.resolved_place)).toContain("coordinates given directly");
    await expect(handleWeatherCheck({ location: "91,0" })).rejects.toMatchObject({ status: 400, code: "BAD_LOCATION" });
  });
  it("serves the measured station temperature with identity and freshness", async () => {
    // Freeze within the fixture's 90-minute freshness window (obs 23:30Z).
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    stub();
    const result = await handleWeatherCheck({ location: "heca" });
    expect(result.temperature_c).toBe(16);
    expect(result.station_name).toBe("Cairo Intl, QH, EG");
    const ans = String(result.answer);
    expect(ans).toContain("measured METAR");
    expect(ans).toContain("never a forecast");
    const receipt = result.receipt as { receipt_id: string; raw_response_sha256: string; intent: string };
    expect(receipt.intent).toBe("WEATHER_CHECK_TEMPERATURE");
    const stored = await getReceiptEvidence(receipt.receipt_id);
    if (!stored.evidence) throw new Error("missing evidence");
    expect(sha256Hex(stored.evidence)).toBe(receipt.raw_response_sha256);
  });
  it("an unknown station is an honest 422, an outage a 502", async () => {
    stub("[]");
    await expect(handleWeatherCheck({ location: "ZZZQ" })).rejects.toMatchObject({ status: 422, code: "STATION_NOT_FOUND" });
    vi.unstubAllGlobals();
    stub("ERR");
    await expect(handleWeatherCheck({ location: "HECA" })).rejects.toMatchObject({ status: 502, code: "METAR_UNREACHABLE" });
  });
  it("a stale observation is refused, not served", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T05:00:00Z")); // > 90 min after 23:30Z obs
    stub();
    await expect(handleWeatherCheck({ location: "HECA" })).rejects.toMatchObject({ status: 422, code: "NO_USABLE_OBSERVATION" });
  });
  it("GET /v1/weather-check is wired", async () => {
    const app = buildServer();
    expect(app.hasRoute({ method: "GET", url: "/v1/weather-check" })).toBe(true);
    await app.close();
  });
});
