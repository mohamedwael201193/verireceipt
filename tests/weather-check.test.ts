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
    // W1b: a purely alphabetic 4-letter token with no station falls
    // through to the geocoder; an alphanumeric code stays station-only.
    await expect(handleWeatherCheck({ location: "ZZ1Q" })).rejects.toMatchObject({ status: 422, code: "STATION_NOT_FOUND" });
    await expect(handleWeatherCheck({ location: "ZZZQ" })).rejects.toMatchObject({ status: 422, code: "PLACE_NOT_FOUND" });
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

describe("W1b", () => {
  const stations = JSON.stringify([
    { icaoId: "HECA", lat: 30.133, lon: 31.405, siteType: ["METAR"] },
  ]);
  const romeGeo = JSON.stringify({ results: [{ name: "Rome", latitude: 41.8919, longitude: 12.5113, country: "Italy", admin1: "Lazio", country_code: "IT" }] });

  it("(a) a 4-letter place name falls through to the geocoder when no ICAO station matches", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("ids=ROME")) return new Response("[]", { status: 200 });
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response(romeGeo, { status: 200 });
      if (u.startsWith("https://aviationweather.gov/api/data/stationinfo")) return new Response(stations, { status: 200 });
      if (u.includes("ids=HECA")) return new Response(heca, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "Rome" });
    expect(result.temperature_c).toBe(16);
    expect(String(result.resolved_place)).toContain("Rome, Lazio, Italy");
    expect(String(result.answer)).toContain("No reporting station ROME");
    expect(String(result.answer)).toContain("nearest reporting station is HECA");
  });

  it("(a) a real ICAO station still answers on the direct path", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("ids=HECA")) return new Response(heca, { status: 200 });
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response('{"results":[]}', { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "HECA" });
    expect(result.temperature_c).toBe(16);
    expect(result.resolved_place).toBeUndefined();
    expect(String(result.answer)).not.toContain("No reporting station");
  });

  it("(b) the stationinfo bbox body hash is committed in the receipt evidence", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response(romeGeo, { status: 200 });
      if (u.startsWith("https://aviationweather.gov/api/data/stationinfo")) return new Response(stations, { status: 200 });
      if (u.includes("ids=HECA")) return new Response(heca, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "Rome, Italy" });
    const rc = result.receipt as { receipt_id: string };
    const ev = await getReceiptEvidence(rc.receipt_id);
    expect(ev.found).toBe(true);
    const parsed = JSON.parse(ev.evidence!) as { resolved: { station_directory: { url: string; sha256: string }[] } };
    expect(Array.isArray(parsed.resolved.station_directory)).toBe(true);
    expect(parsed.resolved.station_directory[0].sha256).toBe(sha256Hex(Buffer.from(stations, "utf8")));
    expect(parsed.resolved.station_directory[0].url).toContain("stationinfo?bbox=");
  });

  it("(c) the ICAO-path refusal keeps the parser's reason string", async () => {
    // Fixture observation is from 2026-11-23 00:00; five hours later it is stale.
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T05:00:00Z"));
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("ids=HECA")) return new Response(heca, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    let err: unknown;
    try {
      await handleWeatherCheck({ location: "HECA" });
    } catch (e) { err = e; }
    const e = err as { status?: number; code?: string; message?: string };
    expect(e.status).toBe(422);
    expect(e.code).toBe("NO_USABLE_OBSERVATION");
    expect(String(e.message)).toContain("unusable observation (");
    expect(String(e.message).length).toBeGreaterThan("HECA: unusable observation ()".length);
  });
});

describe("W1c dual-match ambiguity", () => {
  const limaGeo = JSON.stringify({ results: [{ name: "Lima", latitude: -12.0464, longitude: -77.0428, country: "Peru", admin1: "Lima Province", country_code: "PE" }] });
  // Real-shaped METAR body for station LIMA (Torino/Aeritalia), same schema as the HECA fixture.
  const limaMetar = heca.replace(/HECA/g, "LIMA").replace("Cairo Intl, QH, EG", "Torino/Aeritalia Arpt, TO, IT");

  it("a token matching both a reporting station and a place refuses, naming both", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("ids=LIMA")) return new Response(limaMetar, { status: 200 });
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response(limaGeo, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    let err: unknown;
    try {
      await handleWeatherCheck({ location: "Lima" });
    } catch (e) { err = e; }
    const e = err as { status?: number; code?: string; message?: string };
    expect(e.status).toBe(422);
    expect(e.code).toBe("AMBIGUOUS_LOCATION");
    expect(String(e.message)).toContain("LIMA");
    expect(String(e.message)).toContain("Lima, Lima Province, Peru");
    expect(String(e.message)).toContain("icao:LIMA");
  });

  it("the icao: prefix forces the station reading", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("ids=LIMA")) return new Response(limaMetar, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "icao:LIMA" });
    expect(result.location).toBe("LIMA");
    expect(result.station_name).toBe("Torino/Aeritalia Arpt, TO, IT");
    expect(result.resolved_place).toBeUndefined();
  });

  it("a station match with no geocoder hit serves the station (HECA-style)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("ids=LIMA")) return new Response(limaMetar, { status: 200 });
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response('{"results":[]}', { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "LIMA" });
    expect(result.location).toBe("LIMA");
    expect(result.resolved_place).toBeUndefined();
  });
});

describe("W1b/c case rule", () => {
  it("an exactly-uppercase token serves its station even when a geocoder hit exists (KJFK)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    const kjfkMetar = heca.replace(/HECA/g, "KJFK").replace("Cairo Intl, QH, EG", "John F Kennedy Intl, NY, US");
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("ids=KJFK")) return new Response(kjfkMetar, { status: 200 });
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) {
        return new Response(JSON.stringify({ results: [{ name: "Kjfk", latitude: 10, longitude: 10, country: "Somewhere" }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "KJFK" });
    expect(result.location).toBe("KJFK");
    expect(result.station_name).toBe("John F Kennedy Intl, NY, US");
    expect(result.resolved_place).toBeUndefined();
  });

  it("an exactly-uppercase token with no station falls through to the geocoder (ROME)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    const stations = JSON.stringify([{ icaoId: "HECA", lat: 30.133, lon: 31.405, siteType: ["METAR"] }]);
    const romeGeo = JSON.stringify({ results: [{ name: "Rome", latitude: 41.8919, longitude: 12.5113, country: "Italy", admin1: "Lazio", country_code: "IT" }] });
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("ids=ROME")) return new Response("[]", { status: 200 });
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) return new Response(romeGeo, { status: 200 });
      if (u.startsWith("https://aviationweather.gov/api/data/stationinfo")) return new Response(stations, { status: 200 });
      if (u.includes("ids=HECA")) return new Response(heca, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "ROME" });
    expect(String(result.resolved_place)).toContain("Rome, Lazio, Italy");
    expect(String(result.answer)).toContain("No reporting station ROME");
  });

  it("a Titlecase token whose geocoder hit sits within 5 km of the station serves the station", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      if (u.includes("ids=HECA")) return new Response(heca, { status: 200 });
      if (u.startsWith("https://geocoding-api.open-meteo.com/")) {
        return new Response(JSON.stringify({ results: [{ name: "Heca", latitude: 30.1335, longitude: 31.4055, country: "Egypt" }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await handleWeatherCheck({ location: "Heca" });
    expect(result.location).toBe("HECA");
    expect(result.resolved_place).toBeUndefined();
  });
});
