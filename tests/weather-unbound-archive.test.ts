// Unbound-location past weather: Open-Meteo geocoding plus the existing ERA5 archive path.
// Fixtures are real Open-Meteo bodies captured 2026-11-26 (geocoder count=10; archive 2026-11-15, models=era5).
import { readFileSync } from "node:fs";
import { it, expect, vi, afterEach } from "vitest";
vi.mock("../src/core/storage", () => ({ saveReceipt: vi.fn(async () => {}) }));
import { saveReceipt } from "../src/core/storage";
import { createWiredWeatherHandlers } from "../src/handlers/weatherWired";
import { pickGeocode, qualifierMatches } from "../src/handlers/openMeteoArchive";
import { sha256Hex } from "../src/core/receipt";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });
const DATE = "2026-11-15";
const fx = (n: string) => readFileSync(`tests/fixtures/weather-archive/unbound/${n}.json`, "utf8");
const CITIES: [string, string, string, string][] = [
  ["Tokyo", "tokyo", "Tokyo, JP", "35.6895"], ["Paris", "paris", "Paris, FR", "48.85341"], ["Karachi", "karachi", "Karachi, PK", "24.8608"],
  ["Sao Paulo", "sao-paulo", "São Paulo, BR", "-23.5475"], ["Mumbai", "mumbai", "Mumbai, IN", "19.07283"],
];
function stub(opts: { geo?: (u: URL) => Response; archive?: (u: URL) => Response; ncei?: string } = {}) {
  const f = vi.fn(async (u: unknown) => {
    const url = new URL(String(u));
    if (url.hostname.startsWith("geocoding-api")) return opts.geo ? opts.geo(url) : new Response('{"results":[]}');
    if (url.hostname.includes("ncei")) return new Response(opts.ncei ?? "[]");
    if (url.hostname.startsWith("archive-api")) return opts.archive ? opts.archive(url) : new Response("{}", { status: 500 });
    throw new Error("unexpected host " + url.hostname);
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const hosts = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => new URL(String(c[0])).hostname);
function cityStub(slug: string) {
  return stub({ geo: () => new Response(fx(`${slug}-geocode`)), archive: () => new Response(fx(`${slug}-archive-${DATE}`)) });
}

it.each(CITIES)("%s (unbound) is served from the Open-Meteo archive at the geocoded point, labelled a grid estimate", async (city, slug, place, lat) => {
  const f = cityStub(slug);
  const out: any = await createWiredWeatherHandlers().past({ location: city, date: DATE });
  const arch = JSON.parse(fx(`${slug}-archive-${DATE}`)).daily;
  expect(out).toMatchObject({ location: city, date: DATE, temp_max_c: arch.temperature_2m_max[0], temp_min_c: arch.temperature_2m_min[0], precipitation_mm: arch.precipitation_sum[0], source_method: "era5_reanalysis", station: null, station_name: null, reporting_period: "UTC calendar day", resolved_place: place });
  for (const k of ["temp_max_c", "temp_min_c"]) { expect(typeof out[k]).toBe("number"); expect(out[k]).toBeGreaterThanOrEqual(-90); expect(out[k]).toBeLessThanOrEqual(60); }
  expect(out.precipitation_mm).toBeGreaterThanOrEqual(0); expect(out.precipitation_mm).toBeLessThanOrEqual(2000); expect(out.temp_min_c).toBeLessThanOrEqual(out.temp_max_c);
  expect(String(out.answer)).toContain("Open-Meteo ERA5 reanalysis grid estimate, not a measured station record");
  expect(String(out.source)).toContain("Open-Meteo ERA5");
  // single source, never blended: one geocoder call then one archive call, no NOAA fetch for an unbound place
  expect(hosts(f)).toEqual(["geocoding-api.open-meteo.com", "archive-api.open-meteo.com"]);
  const au = new URL(String(f.mock.calls[1][0]));
  expect(au.searchParams.get("latitude")).toBe(lat); expect(au.searchParams.get("models")).toBe("era5"); expect(au.searchParams.get("start_date")).toBe(DATE);
  const gu = new URL(String(f.mock.calls[0][0])); expect(gu.searchParams.get("name")).toBe(city); expect(gu.searchParams.get("count")).toBe("10"); expect(gu.searchParams.get("format")).toBe("json"); expect(gu.searchParams.get("language")).toBe("en");
  const [receipt, evidence] = vi.mocked(saveReceipt).mock.calls[0] as any;
  expect(sha256Hex(evidence)).toBe(receipt.raw_response_sha256);
  const raw = JSON.parse(JSON.parse(evidence).raw_body);
  expect(raw.geocoder_raw_body).toBe(fx(`${slug}-geocode`)); expect(raw.source_raw_body).toBe(fx(`${slug}-archive-${DATE}`)); expect(raw.geocoder_pick.country_code).toBe(place.slice(-2));
});
it.each(["springfield", "cambridge"])("%s is ambiguous in the geocoder: refused, archive never read, no receipt", async (slug) => {
  const f = stub({ geo: () => new Response(fx(`${slug}-geocode`)), archive: () => new Response(fx("tokyo-archive-2026-11-15")) });
  await expect(createWiredWeatherHandlers().past({ location: slug[0].toUpperCase() + slug.slice(1), date: DATE })).rejects.toMatchObject({ status: 502, code: "APPROVED_SOURCES_UNAVAILABLE" });
  expect(hosts(f)).toEqual(["geocoding-api.open-meteo.com"]); expect(saveReceipt).not.toHaveBeenCalled();
});
it("no geocoder result, geocoder HTTP error and a non-place result all refuse before the archive", async () => {
  for (const geo of [() => new Response(fx("none-geocode")), () => new Response("", { status: 500 }), () => new Response(fx("tokyo-geocode").replace(/"feature_code":"PPL[A-Z0-9]*"/g, '"feature_code":"MT"'))]) {
    const f = stub({ geo, archive: () => new Response(fx("tokyo-archive-2026-11-15")) });
    await expect(createWiredWeatherHandlers().past({ location: "Tokyo", date: DATE })).rejects.toMatchObject({ status: 502, code: "APPROVED_SOURCES_UNAVAILABLE" });
    expect(hosts(f)).toEqual(["geocoding-api.open-meteo.com"]);
  }
  expect(saveReceipt).not.toHaveBeenCalled();
});
it("archive that reports a different point than the geocoded one is rejected", async () => {
  const bad = JSON.parse(fx("tokyo-archive-2026-11-15")); bad.latitude = 40; 
  stub({ geo: () => new Response(fx("tokyo-geocode")), archive: () => new Response(JSON.stringify(bad)) });
  await expect(createWiredWeatherHandlers().past({ location: "Tokyo", date: DATE })).rejects.toMatchObject({ status: 502 });
  expect(saveReceipt).not.toHaveBeenCalled();
});
it("archive with no data yet gives the disclosed no-record answer (200), not a 502", async () => {
  const nul = JSON.parse(fx("tokyo-archive-2026-11-15")); nul.daily.temperature_2m_max = [null]; nul.daily.temperature_2m_min = [null]; nul.daily.precipitation_sum = [null];
  stub({ geo: () => new Response(fx("tokyo-geocode")), archive: () => new Response(JSON.stringify(nul)) });
  const out: any = await createWiredWeatherHandlers().past({ location: "Tokyo", date: DATE });
  expect(out).toMatchObject({ data_status: "no_record", temp_max_c: null, temp_min_c: null, precipitation_mm: null });
  expect(String(out.answer)).toContain("the Open-Meteo ERA5 archive returned no record for the geocoded grid cell"); expect(String(out.answer)).not.toContain("NOAA archive returned"); expect(saveReceipt).toHaveBeenCalledTimes(1);
});
it("a partly missing archive day is still refused, never served as partial", async () => {
  const part = JSON.parse(fx("tokyo-archive-2026-11-15")); part.daily.temperature_2m_max = [null];
  stub({ geo: () => new Response(fx("tokyo-geocode")), archive: () => new Response(JSON.stringify(part)) });
  await expect(createWiredWeatherHandlers().past({ location: "Tokyo", date: DATE })).rejects.toMatchObject({ status: 502 });
});
it("non-past and malformed dates are refused before any request, for unbound places too", async () => {
  vi.useFakeTimers(); vi.setSystemTime("2026-11-26T12:00:00Z");
  const f = stub();
  for (const date of ["2026-11-26", "2026-11-27", "2026-02-30", "yesterday", ""]) await expect(createWiredWeatherHandlers().past({ location: "Tokyo", date })).rejects.toMatchObject({ status: 400, code: "INVALID_DATE" });
  expect(f).not.toHaveBeenCalled();
});
it("a bound city never calls the geocoder: NOAA first, then the archive at its reviewed coordinates", async () => {
  const f = stub({ archive: () => new Response(readFileSync("tests/fixtures/weather-archive/cairo-era5.json", "utf8")) });
  const out: any = await createWiredWeatherHandlers().past({ location: "Cairo", date: "2026-11-01" });
  expect(out.source_method).toBe("era5_reanalysis"); expect(out.resolved_place).toBeUndefined();
  expect(hosts(f)).toHaveLength(2); expect(hosts(f)[0]).toContain("ncei"); expect(hosts(f)[1]).toBe("archive-api.open-meteo.com");
  expect(hosts(f).some((h) => h.startsWith("geocoding-api"))).toBe(false);
});
it("a location that resolves to a bound city's spelling keeps the bound path even with different case", async () => {
  const f = stub({ archive: () => new Response(readFileSync("tests/fixtures/weather-archive/cairo-era5.json", "utf8")) });
  await createWiredWeatherHandlers().past({ location: "cAiRo", date: "2026-11-01" });
  expect(hosts(f).some((h) => h.startsWith("geocoding-api"))).toBe(false);
});
it("archiveFallback=false never geocodes", async () => {
  const f = stub({ geo: () => new Response(fx("tokyo-geocode")) });
  await expect(createWiredWeatherHandlers({ archiveFallback: false }).past({ location: "Tokyo", date: DATE })).rejects.toMatchObject({ status: 502 });
  expect(hosts(f)).toEqual([]);
});
const geoBody = (rows: any[]) => JSON.stringify({ results: rows });
const row = (o: any) => ({ name: "Testville", country_code: "US", admin1: "X", latitude: 10, longitude: 20, feature_code: "PPL", population: 1000, ...o });
it("pickGeocode: unique, 10x dominance accepted; 9.9x, ties and no exact match refused", () => {
  expect(pickGeocode("Testville", geoBody([row({})])).country_code).toBe("US");
  expect(pickGeocode("Testville", geoBody([row({ population: null })])).population).toBeNull();
  expect(pickGeocode("Testville", geoBody([row({ population: 10000 }), row({ country_code: "CA", population: 1000 })])).country_code).toBe("US");
  expect(pickGeocode("Testville", geoBody([row({ country_code: "CA", population: 1000 }), row({ population: 10000 })])).country_code).toBe("US");
  expect(() => pickGeocode("Testville", geoBody([row({ population: 9999 }), row({ country_code: "CA", population: 1000 })]))).toThrow("ambiguous");
  expect(() => pickGeocode("Testville", geoBody([row({}), row({ country_code: "CA" })]))).toThrow("ambiguous");
  expect(() => pickGeocode("Testville", geoBody([row({ population: null }), row({ country_code: "CA", population: null })]))).toThrow("ambiguous");
  expect(() => pickGeocode("Testville", geoBody([row({ population: 5000 }), row({ country_code: "CA", population: null })]))).not.toThrow();
  expect(() => pickGeocode("Testville", geoBody([row({ name: "Other" })]))).toThrow("no exact");
  expect(() => pickGeocode("Testville, US", geoBody([row({})]))).toThrow("no exact");
  expect(() => pickGeocode("Testville", "{}")).toThrow("no exact");
});
// "City, Country" locations (round 7): the geocoder returns nothing for the whole comma string, so the city part is
// geocoded alone and the qualifier must match the result's country name, country_code (UK->GB, USA->US aliases) or
// admin1, accent and case folded. Several qualifier matches still need the 10x-population rule.
const londonGeo = () => geoBody([
  row({ name: "London", country: "United Kingdom", country_code: "GB", admin1: "England", latitude: 51.50853, longitude: -0.12574, feature_code: "PPLC", population: 8900000 }),
  row({ name: "London", country: "Canada", country_code: "CA", admin1: "Ontario", latitude: 42.98339, longitude: -81.23304, feature_code: "PPL", population: 346000 }),
  row({ name: "London", country: "United States", country_code: "US", admin1: "Kentucky", latitude: 37.12898, longitude: -84.08326, feature_code: "PPL", population: 8000 }),
]);
const archiveBody = (lat: number, lon: number, date: string) => JSON.stringify({ latitude: lat, longitude: lon, timezone: "GMT", utc_offset_seconds: 0, daily_units: { time: "iso8601", temperature_2m_max: "\u00b0C", temperature_2m_min: "\u00b0C", precipitation_sum: "mm" }, daily: { time: [date], temperature_2m_max: [10.5], temperature_2m_min: [4.2], precipitation_sum: [1.3] } });
it('"London, UK" geocodes the city only, matches GB by the UK alias, and discloses the requested string and matched country', async () => {
  const f = stub({ geo: () => new Response(londonGeo()), archive: () => new Response(archiveBody(51.5, -0.12, DATE)) });
  const out: any = await createWiredWeatherHandlers().past({ location: "London, UK", date: DATE });
  expect(out.resolved_place).toBe("London, GB"); expect(out.temp_max_c).toBe(10.5);
  const gu = new URL(String(f.mock.calls[0][0])); expect(gu.searchParams.get("name")).toBe("London");
  const [receipt, evidence] = vi.mocked(saveReceipt).mock.calls[0] as any;
  expect(sha256Hex(evidence)).toBe(receipt.raw_response_sha256);
  const raw = JSON.parse(JSON.parse(evidence).raw_body);
  expect(raw.requested_location).toBe("London, UK"); expect(raw.matched_country).toBe("United Kingdom");
});
it('"Paris, France" resolves FR Paris by the country-name qualifier (real geocoder fixture)', async () => {
  const f = stub({ geo: () => new Response(fx("paris-geocode")), archive: () => new Response(fx(`paris-archive-${DATE}`)) });
  const out: any = await createWiredWeatherHandlers().past({ location: "Paris, France", date: DATE });
  const arch = JSON.parse(fx(`paris-archive-${DATE}`)).daily;
  expect(out.resolved_place).toBe("Paris, FR"); expect(out.temp_max_c).toBe(arch.temperature_2m_max[0]);
  const gu = new URL(String(f.mock.calls[0][0])); expect(gu.searchParams.get("name")).toBe("Paris");
  const raw = JSON.parse(JSON.parse((vi.mocked(saveReceipt).mock.calls[0] as any)[1]).raw_body);
  expect(raw.requested_location).toBe("Paris, France"); expect(raw.matched_country).toBe("France");
});
it("pickGeocode with qualifier: 'Paris, Texas' picks US Paris, never FR Paris (real geocoder fixture)", () => {
  const pick = pickGeocode("Paris", fx("paris-geocode"), "Texas");
  expect(pick.country_code).toBe("US"); expect(pick.admin1).toBe("Texas"); expect(pick.country).toBe("United States");
});
it('"Springfield, USA" stays ambiguous and refuses (real geocoder fixture, 10x rule after the qualifier filter)', async () => {
  const f = stub({ geo: () => new Response(fx("springfield-geocode")), archive: () => new Response(fx("tokyo-archive-2026-11-15")) });
  await expect(createWiredWeatherHandlers().past({ location: "Springfield, USA", date: DATE })).rejects.toMatchObject({ status: 502, code: "APPROVED_SOURCES_UNAVAILABLE" });
  expect(hosts(f)).toEqual(["geocoding-api.open-meteo.com"]); expect(saveReceipt).not.toHaveBeenCalled();
});
it('"London, Narnia" matches no qualifier and refuses before the archive', async () => {
  const f = stub({ geo: () => new Response(londonGeo()), archive: () => new Response(archiveBody(51.5, -0.12, DATE)) });
  await expect(createWiredWeatherHandlers().past({ location: "London, Narnia", date: DATE })).rejects.toMatchObject({ status: 502, code: "APPROVED_SOURCES_UNAVAILABLE" });
  expect(hosts(f)).toEqual(["geocoding-api.open-meteo.com"]); expect(saveReceipt).not.toHaveBeenCalled();
});
it("qualifierMatches: country name, ISO code, UK/USA aliases and admin1, accent and case folded", () => {
  const fr = { name: "Paris", country: "France", country_code: "FR", admin1: "\u00cele-de-France Region" };
  const us = { name: "Paris", country: "United States", country_code: "US", admin1: "Texas" };
  expect(qualifierMatches("france", fr)).toBe(true); expect(qualifierMatches("FR", fr)).toBe(true);
  expect(qualifierMatches("\u00eele-de-france region", fr)).toBe(true);
  expect(qualifierMatches("texas", us)).toBe(true); expect(qualifierMatches("USA", us)).toBe(true); expect(qualifierMatches("Us", us)).toBe(true);
  expect(qualifierMatches("UK", { country: "United Kingdom", country_code: "GB", admin1: "England" })).toBe(true);
  expect(qualifierMatches("france", us)).toBe(false); expect(qualifierMatches("Narnia", fr)).toBe(false);
});
it("pickGeocode qualifier: country name, code, alias and admin1 all select; a miss throws qualifier-no-match", () => {
  const body = geoBody([
    row({ name: "Paris", country: "France", country_code: "FR", admin1: "\u00cele-de-France Region", population: 2138551 }),
    row({ name: "Paris", country: "United States", country_code: "US", admin1: "Texas", population: 24782 }),
  ]);
  expect(pickGeocode("Paris", body, "france").country_code).toBe("FR");
  expect(pickGeocode("Paris", body, "FR").country_code).toBe("FR");
  expect(pickGeocode("Paris", body, "texas").country_code).toBe("US");
  expect(pickGeocode("Paris", body, "USA").country_code).toBe("US");
  expect(() => pickGeocode("Paris", body, "Narnia")).toThrow("qualifier matched no place");
});
it("pickGeocode: accent and case fold; only populated places with valid country and coordinates", () => {
  expect(pickGeocode("sao paulo", geoBody([row({ name: "São Paulo", country_code: "BR" })])).name).toBe("São Paulo");
  expect(pickGeocode("  TESTVILLE ", geoBody([row({})])).name).toBe("Testville");
  for (const bad of [{ feature_code: "MT" }, { feature_code: "ADM1" }, { country_code: "usa" }, { country_code: undefined }, { latitude: 91 }, { longitude: -181 }, { latitude: "10" }, { latitude: null }])
    expect(() => pickGeocode("Testville", geoBody([row(bad)])), JSON.stringify(bad)).toThrow();
  expect(pickGeocode("Testville", geoBody([row({ feature_code: "PPLA2" })])).feature_code).toBe("PPLA2");
});
